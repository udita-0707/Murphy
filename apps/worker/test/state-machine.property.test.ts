import { canonicalHash, RETRY_SCHEDULE_MS } from "@murphy/core";
import {
  createDeliveryQueue,
  createRepository,
  type DeliveryQueue,
  type DeliveryStatus,
  type Repository,
} from "@murphy/db";
import {
  auditViolations,
  clearDeliveryAudit,
  installDeliveryAudit,
  type AuditRule,
} from "@murphy/db/audit";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SendResult } from "../src/net/send.js";
import { decideOutcome } from "../src/policy.js";
import { FREE_REAPS } from "../src/reaper.js";
import { startTestDb, type TestDb } from "./helpers.js";

/**
 * Model-based test of the delivery state machine: random operation sequences run against the
 * real repository, queue and retry policy on a real Postgres, and against a small in-memory
 * model written independently of them. After every operation the two must agree, and after every
 * sequence the audit history must break no invariant.
 *
 * Replay a failure with MURPHY_PROPERTY_SEED and MURPHY_PROPERTY_PATH from the printed report.
 */

const NUM_RUNS = Number(process.env.MURPHY_PROPERTY_RUNS ?? 50);
const SEED = process.env.MURPHY_PROPERTY_SEED
  ? Number(process.env.MURPHY_PROPERTY_SEED)
  : undefined;
const PATH = process.env.MURPHY_PROPERTY_PATH;

/** One initial attempt plus one retry per schedule entry. */
const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
const CLIENT_ERROR_MAX_RETRIES = 2;
const WORKERS = ["w1", "w2"] as const;
const EVENT_TYPES = ["payment.captured", "refund.created"] as const;
/** Long enough that nothing expires or comes due by wall clock during a run. */
const HOUR_MS = 3_600_000;

/** Counts of operations that had a real effect, so a shallow run cannot pass quietly. */
const coverage = new Map<string, number>();
const covered = (what: string, by = 1) => {
  if (by > 0) coverage.set(what, (coverage.get(what) ?? 0) + by);
};

type Response = "ok" | "server_error" | "timeout" | "client_error" | "gone" | "redirect";

interface MEndpoint {
  id: string;
  projectId: string;
  filter: string[];
  status: "active" | "disabled";
  deleted: boolean;
}

interface MDelivery {
  id: string;
  projectId: string;
  endpoint: MEndpoint;
  status: DeliveryStatus;
  attemptCount: number;
  clientErrorCount: number;
  reapCount: number;
  attemptRows: number;
  lockedBy: string | null;
  /** Bumped on every claim. A task may write only if it holds the current lease. */
  leaseNumber: number;
  leaseExpired: boolean;
  due: boolean;
}

/** Work a worker holds in memory. It outlives its lease, which is how late writes happen. */
interface MTask {
  deliveryId: string;
  worker: string;
  claimToken: string;
  leaseNumber: number;
  counters: { attemptCount: number; clientErrorCount: number };
}

interface Model {
  projects: string[];
  endpoints: MEndpoint[];
  deliveries: MDelivery[];
  tasks: MTask[];
  events: { projectId: string; key: string; type: string; id: string; count: number }[];
  nextKey: number;
}

interface Real {
  db: TestDb;
  repo: Repository;
  queue: DeliveryQueue;
}

const pick = <T>(items: readonly T[], index: number): T => items[index % items.length]!;

function eventHash(type: string): string {
  return canonicalHash({ type, payload: { id: "pay_1" } });
}

/** What should happen to a delivery after a failed attempt, given its new counters. */
function retryOrDead(d: MDelivery): void {
  if (d.attemptCount >= MAX_ATTEMPTS) {
    d.status = "dead";
  } else {
    d.status = "pending";
    d.due = false;
  }
}

function clearLease(d: MDelivery): void {
  d.lockedBy = null;
  d.leaseExpired = false;
}

/** The expected effect of a response on a delivery whose lease is current. */
function applyResponse(d: MDelivery, response: Response): void {
  d.attemptCount += 1;
  switch (response) {
    case "ok":
      d.status = "succeeded";
      break;
    case "server_error":
    case "timeout":
      retryOrDead(d);
      break;
    case "client_error":
      d.clientErrorCount += 1;
      if (d.clientErrorCount > CLIENT_ERROR_MAX_RETRIES) d.status = "dead";
      else retryOrDead(d);
      break;
    case "gone":
      d.status = "dead";
      if (!d.endpoint.deleted) d.endpoint.status = "disabled";
      break;
    case "redirect":
      d.status = "dead";
      break;
  }
  clearLease(d);
}

function sendResult(response: Response): SendResult {
  const http = (status: number): SendResult => ({
    ok: true,
    status,
    retryAfter: null,
    bodySnippet: "",
    durationMs: 1,
  });
  switch (response) {
    case "ok":
      return http(200);
    case "server_error":
      return http(500);
    case "client_error":
      return http(404);
    case "gone":
      return http(410);
    case "redirect":
      return http(301);
    case "timeout":
      return { ok: false, kind: "timeout", error: "timed out", durationMs: 1 };
  }
}

/** The whole database must match the model, field by field. */
async function assertMatches(model: Model, real: Real): Promise<void> {
  const rows = await real.db.prisma.$queryRaw<
    {
      id: string;
      status: DeliveryStatus;
      attemptCount: number;
      clientErrorCount: number;
      reapCount: number;
      lockedBy: string | null;
      lockedUntil: Date | null;
      completedAt: Date | null;
      attemptRows: number;
    }[]
  >`
    SELECT d.id::text AS "id", d.status::text AS "status", d.attempt_count AS "attemptCount",
           d.client_error_count AS "clientErrorCount", d.reap_count AS "reapCount",
           d.locked_by AS "lockedBy", d.locked_until AS "lockedUntil",
           d.completed_at AS "completedAt",
           (SELECT count(*)::int FROM delivery_attempts a WHERE a.delivery_id = d.id) AS "attemptRows"
    FROM deliveries d`;
  const project = (r: (typeof rows)[number]) => ({
    id: r.id,
    status: r.status,
    attemptCount: r.attemptCount,
    clientErrorCount: r.clientErrorCount,
    reapCount: r.reapCount,
    lockedBy: r.lockedBy,
    attemptRows: r.attemptRows,
  });
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  expect(rows.map(project).sort(byId)).toEqual(
    model.deliveries
      .map((d) => ({
        id: d.id,
        status: d.status,
        attemptCount: d.attemptCount,
        clientErrorCount: d.clientErrorCount,
        reapCount: d.reapCount,
        lockedBy: d.lockedBy,
        attemptRows: d.attemptRows,
      }))
      .sort(byId),
  );

  for (const row of rows) {
    const finished = ["succeeded", "dead", "cancelled"].includes(row.status);
    expect(row.completedAt !== null, `completed_at on ${row.status}`).toBe(finished);
    expect(row.lockedUntil !== null, `locked_until on ${row.status}`).toBe(
      row.status === "in_flight",
    );
  }

  const endpoints = await real.db.prisma.endpoint.findMany({
    select: { id: true, status: true, deletedAt: true },
  });
  expect(
    endpoints
      .map((e) => ({ id: e.id, status: e.status, deleted: e.deletedAt !== null }))
      .sort(byId),
  ).toEqual(
    model.endpoints.map((e) => ({ id: e.id, status: e.status, deleted: e.deleted })).sort(byId),
  );
}

type Cmd = fc.AsyncCommand<Model, Real>;

class Ingest implements Cmd {
  constructor(
    readonly project: number,
    readonly type: number,
  ) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const projectId = pick(m.projects, this.project);
    const type = pick(EVENT_TYPES, this.type);
    const key = `key-${m.nextKey++}`;
    const result = await r.repo.events.accept(projectId, {
      type,
      payload: { id: "pay_1" },
      idempotencyKey: key,
      requestHash: eventHash(type),
    });
    if (result.outcome !== "created") throw new Error(`expected created, got ${result.outcome}`);

    const targets = m.endpoints.filter(
      (e) =>
        e.projectId === projectId &&
        e.status === "active" &&
        !e.deleted &&
        (e.filter.length === 0 || e.filter.includes(type)),
    );
    expect(result.deliveries).toBe(targets.length);
    const rows = await r.db.prisma.delivery.findMany({
      where: { eventId: result.eventId },
      select: { id: true, endpointId: true },
    });
    for (const row of rows) {
      const endpoint = targets.find((e) => e.id === row.endpointId);
      if (!endpoint) throw new Error(`fan-out to unexpected endpoint ${row.endpointId}`);
      m.deliveries.push({
        id: row.id,
        projectId,
        endpoint,
        status: "pending",
        attemptCount: 0,
        clientErrorCount: 0,
        reapCount: 0,
        attemptRows: 0,
        lockedBy: null,
        leaseNumber: 0,
        leaseExpired: false,
        due: true,
      });
    }
    m.events.push({ projectId, key, type, id: result.eventId, count: targets.length });
    await assertMatches(m, r);
  }
  toString = () => `ingest(project ${this.project}, type ${this.type})`;
}

class IngestAgain implements Cmd {
  constructor(readonly event: number) {}
  check = (m: Readonly<Model>) => m.events.length > 0;
  async run(m: Model, r: Real) {
    const event = pick(m.events, this.event);
    const result = await r.repo.events.accept(event.projectId, {
      type: event.type,
      payload: { id: "pay_1" },
      idempotencyKey: event.key,
      requestHash: eventHash(event.type),
    });
    expect(result).toEqual({ outcome: "replayed", eventId: event.id, deliveries: event.count });
    await assertMatches(m, r);
  }
  toString = () => `ingest_again(event ${this.event})`;
}

class Claim implements Cmd {
  constructor(
    readonly worker: number,
    readonly batchSize: number,
    readonly projectCap: number,
  ) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const worker = pick(WORKERS, this.worker);
    const claimed = await r.queue.claim({
      workerId: worker,
      batchSize: this.batchSize,
      projectCap: this.projectCap,
      leaseMs: HOUR_MS,
    });

    const eligible = m.deliveries.filter(
      (d) =>
        d.status === "pending" && d.due && d.endpoint.status === "active" && !d.endpoint.deleted,
    );
    const available = m.projects.reduce(
      (sum, p) => sum + Math.min(this.projectCap, eligible.filter((d) => d.projectId === p).length),
      0,
    );
    expect(claimed.length).toBe(Math.min(this.batchSize, available));
    covered("claimed", claimed.length);
    covered(
      "claim_skipped_parked",
      m.deliveries.filter((d) => d.status === "pending" && d.due && d.endpoint.status !== "active")
        .length,
    );

    for (const row of claimed) {
      const d = eligible.find((e) => e.id === row.id);
      if (!d) throw new Error(`claimed an ineligible delivery ${row.id}`);
      d.status = "in_flight";
      d.lockedBy = worker;
      d.leaseNumber += 1;
      d.leaseExpired = false;

      const context = await r.queue.loadContext(row.id, row.claimToken);
      if (!context) throw new Error(`no context right after claiming ${row.id}`);
      expect(context.attemptCount).toBe(d.attemptCount);
      expect(context.clientErrorCount).toBe(d.clientErrorCount);
      m.tasks.push({
        deliveryId: d.id,
        worker,
        claimToken: row.claimToken,
        leaseNumber: d.leaseNumber,
        counters: {
          attemptCount: context.attemptCount,
          clientErrorCount: context.clientErrorCount,
        },
      });
    }
    await assertMatches(m, r);
  }
  toString = () => `claim(w${this.worker}, batch ${this.batchSize}, cap ${this.projectCap})`;
}

/** Finishes held work. If the task lost its lease this is a late write, which must change nothing. */
class Complete implements Cmd {
  constructor(
    readonly task: number,
    readonly response: Response,
  ) {}
  check = (m: Readonly<Model>) => m.tasks.length > 0;
  async run(m: Model, r: Real) {
    const index = this.task % m.tasks.length;
    const task = m.tasks[index]!;
    m.tasks.splice(index, 1);
    const d = m.deliveries.find((e) => e.id === task.deliveryId)!;
    const current =
      d.status === "in_flight" && d.lockedBy === task.worker && d.leaseNumber === task.leaseNumber;

    const outcome = decideOutcome(sendResult(this.response), task.counters);
    // The policy's real delay could come due during a long run; only advance_time may do that.
    const stable = outcome.kind === "retry" ? { ...outcome, delayMs: HOUR_MS } : outcome;
    const { applied } = await r.queue.recordAttempt(
      task.deliveryId,
      task.claimToken,
      {
        startedAt: new Date(),
        durationMs: 1,
        requestHeaders: {},
        responseStatus: null,
        responseBodySnippet: null,
        error: null,
      },
      stable,
    );

    expect(applied, current ? "write with the current lease" : "late write").toBe(current);
    d.attemptRows += 1;
    if (current) {
      applyResponse(d, this.response);
      covered(`complete:${this.response}`);
      if (d.status === "dead") covered("went_dead");
    } else {
      covered("late_write");
      if (d.status === "in_flight" && d.lockedBy === task.worker) {
        covered("late_write_same_worker_new_lease");
      }
    }
    await assertMatches(m, r);
  }
  toString = () => `complete(task ${this.task}, ${this.response})`;
}

/** The lease runs out: the worker died or stalled. Only the clock moves. */
class ExpireLease implements Cmd {
  constructor(readonly delivery: number) {}
  check = (m: Readonly<Model>) => m.deliveries.some((d) => d.status === "in_flight");
  async run(m: Model, r: Real) {
    const d = pick(
      m.deliveries.filter((e) => e.status === "in_flight"),
      this.delivery,
    );
    await r.db.prisma.$executeRaw`
      UPDATE deliveries SET locked_until = now() - interval '1 second' WHERE id = ${d.id}::uuid`;
    d.leaseExpired = true;
    await assertMatches(m, r);
  }
  toString = () => `expire_lease(delivery ${this.delivery})`;
}

class Reap implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    const reaped = await r.queue.reapExpired({
      limit: 100,
      freeReaps: FREE_REAPS,
      // Same exhaustion rule as reapOnce, with a delay that cannot come due by wall clock.
      retryDelay: (attemptCount) => (attemptCount >= MAX_ATTEMPTS ? null : HOUR_MS),
    });
    const expired = m.deliveries.filter((d) => d.status === "in_flight" && d.leaseExpired);
    expect(reaped.map((x) => x.id).sort()).toEqual(expired.map((d) => d.id).sort());
    covered("reaped", expired.length);
    for (const d of expired) {
      d.reapCount += 1;
      d.attemptRows += 1;
      const counted = d.reapCount > FREE_REAPS;
      if (counted) {
        d.attemptCount += 1;
        retryOrDead(d);
        covered("poison_guard_counted");
        if (d.status === "dead") covered("poison_guard_dead");
      } else {
        d.status = "pending";
        d.due = true;
      }
      clearLease(d);
    }
    await assertMatches(m, r);
  }
  toString = () => "reap()";
}

/** Graceful shutdown: the worker hands back everything it holds. */
class Release implements Cmd {
  constructor(readonly worker: number) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const worker = pick(WORKERS, this.worker);
    const released = await r.queue.releaseLeases(worker);
    const held = m.deliveries.filter((d) => d.status === "in_flight" && d.lockedBy === worker);
    expect(released).toBe(held.length);
    covered("released", held.length);
    for (const d of held) {
      d.status = "pending";
      d.due = true;
      clearLease(d);
    }
    await assertMatches(m, r);
  }
  toString = () => `release(w${this.worker})`;
}

class Replay implements Cmd {
  constructor(readonly delivery: number) {}
  check = (m: Readonly<Model>) => m.deliveries.length > 0;
  async run(m: Model, r: Real) {
    const d = pick(m.deliveries, this.delivery);
    const result = await r.repo.deliveries.replay(d.projectId, d.id);
    if (d.status === "cancelled" || d.endpoint.deleted) {
      expect(result.outcome).toBe("endpoint_deleted");
      covered("replay_refused_deleted");
    } else if (d.status === "succeeded" || d.status === "dead") {
      expect(result.outcome).toBe("replayed");
      covered(`replayed_${d.status}`);
      resetForReplay(d);
    } else {
      expect(result).toEqual({ outcome: "in_progress", status: d.status });
    }
    await assertMatches(m, r);
  }
  toString = () => `replay(delivery ${this.delivery})`;
}

class BulkReplay implements Cmd {
  constructor(readonly project: number) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const projectId = pick(m.projects, this.project);
    const count = await r.repo.deliveries.bulkReplay(projectId, {
      statuses: ["succeeded", "dead"],
    });
    const matching = m.deliveries.filter(
      (d) =>
        d.projectId === projectId &&
        (d.status === "succeeded" || d.status === "dead") &&
        !d.endpoint.deleted,
    );
    expect(count).toBe(matching.length);
    covered("bulk_replayed", matching.length);
    for (const d of matching) resetForReplay(d);
    await assertMatches(m, r);
  }
  toString = () => `bulk_replay(project ${this.project})`;
}

function resetForReplay(d: MDelivery): void {
  d.status = "pending";
  d.attemptCount = 0;
  d.clientErrorCount = 0;
  d.reapCount = 0;
  d.due = true;
  clearLease(d);
}

class DeleteEndpoint implements Cmd {
  constructor(readonly endpoint: number) {}
  /** A project with no live endpoints can do nothing further, which wastes the rest of a run. */
  check = (m: Readonly<Model>) => {
    const e = pick(m.endpoints, this.endpoint);
    return m.endpoints.some((o) => o.projectId === e.projectId && o !== e && !o.deleted);
  };
  async run(m: Model, r: Real) {
    const e = pick(m.endpoints, this.endpoint);
    const deleted = await r.repo.endpoints.delete(e.projectId, e.id);
    expect(deleted).toBe(!e.deleted);
    if (!e.deleted) {
      e.deleted = true;
      for (const d of m.deliveries) {
        if (d.endpoint === e && (d.status === "pending" || d.status === "in_flight")) {
          covered(`cancelled_from_${d.status}`);
          d.status = "cancelled";
          clearLease(d);
        }
      }
    }
    await assertMatches(m, r);
  }
  toString = () => `delete_endpoint(${this.endpoint})`;
}

class SetEndpointStatus implements Cmd {
  constructor(
    readonly endpoint: number,
    readonly status: "active" | "disabled",
  ) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const e = pick(m.endpoints, this.endpoint);
    const updated = await r.repo.endpoints.update(e.projectId, e.id, { status: this.status });
    expect(updated === null).toBe(e.deleted);
    if (!e.deleted) e.status = this.status;
    await assertMatches(m, r);
  }
  toString = () => `${this.status === "active" ? "enable" : "disable"}_endpoint(${this.endpoint})`;
}

/** Backoff time passes: every waiting delivery comes due. Only the clock moves. */
class AdvanceTime implements Cmd {
  check = () => true;
  async run(m: Model, r: Real) {
    await r.db.prisma.$executeRaw`
      UPDATE deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`;
    for (const d of m.deliveries) if (d.status === "pending") d.due = true;
    await assertMatches(m, r);
  }
  toString = () => "advance_time()";
}

/**
 * Jumps a waiting delivery near exhaustion, because reaching dead or the poison guard the long
 * way would need dozens of operations in a row. This writes counters directly, upwards only.
 */
class AgeDelivery implements Cmd {
  constructor(readonly delivery: number) {}
  check = (m: Readonly<Model>) => m.deliveries.some((d) => d.status === "pending");
  async run(m: Model, r: Real) {
    const d = pick(
      m.deliveries.filter((e) => e.status === "pending"),
      this.delivery,
    );
    const attemptCount = Math.max(d.attemptCount, MAX_ATTEMPTS - 1);
    const reapCount = Math.max(d.reapCount, FREE_REAPS);
    await r.db.prisma.$executeRaw`
      UPDATE deliveries SET attempt_count = ${attemptCount}, reap_count = ${reapCount}
      WHERE id = ${d.id}::uuid`;
    d.attemptCount = attemptCount;
    d.reapCount = reapCount;
    await assertMatches(m, r);
  }
  toString = () => `age_delivery(${this.delivery})`;
}

const index = fc.nat({ max: 50 });
const ingest = fc.tuple(index, index).map(([p, t]) => new Ingest(p, t));
const claim = fc
  .tuple(index, fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 3 }))
  .map(([w, b, c]) => new Claim(w, b, c));
const complete = fc
  .tuple(
    index,
    fc.constantFrom<Response>(
      "ok",
      "ok",
      "ok",
      "server_error",
      "server_error",
      "timeout",
      "client_error",
      "gone",
      "redirect",
    ),
  )
  .map(([t, res]) => new Complete(t, res));
const expire = index.map((d) => new ExpireLease(d));
const reap = fc.constant(new Reap());
const advance = fc.constant(new AdvanceTime());
const enable = index.map((e) => new SetEndpointStatus(e, "active"));

/** Repeats weight the mix: without them a sequence rarely gets past claiming anything. */
const commands = [
  ingest,
  ingest,
  ingest,
  claim,
  claim,
  claim,
  claim,
  complete,
  complete,
  complete,
  expire,
  expire,
  reap,
  reap,
  advance,
  advance,
  enable,
  index.map((e) => new IngestAgain(e)),
  index.map((w) => new Release(w)),
  index.map((d) => new Replay(d)),
  index.map((d) => new Replay(d)),
  index.map((p) => new BulkReplay(p)),
  index.map((e) => new DeleteEndpoint(e)),
  fc
    .tuple(index, fc.constantFrom<"active" | "disabled">("active", "disabled"))
    .map(([e, s]) => new SetEndpointStatus(e, s)),
  index.map((d) => new AgeDelivery(d)),
];

async function setup(real: Real): Promise<{ model: Model; real: Real }> {
  await real.db.prisma.$executeRawUnsafe(`TRUNCATE projects CASCADE`);
  await clearDeliveryAudit(real.db.prisma);

  const projects = [
    (await real.repo.projects.create({ name: "a" })).id,
    (await real.repo.projects.create({ name: "b" })).id,
  ];
  const layout = [
    { projectId: projects[0]!, filter: [] },
    { projectId: projects[0]!, filter: ["refund.created"] },
    { projectId: projects[0]!, filter: [] },
    { projectId: projects[1]!, filter: [] },
    { projectId: projects[1]!, filter: [] },
  ];
  const endpoints: MEndpoint[] = [];
  for (const { projectId, filter } of layout) {
    const created = await real.repo.endpoints.create(projectId, {
      url: "https://example.com/hooks",
      eventFilter: filter,
      secretEnc: randomBytes(48),
    });
    endpoints.push({ id: created.id, projectId, filter, status: "active", deleted: false });
  }
  return {
    model: { projects, endpoints, deliveries: [], tasks: [], events: [], nextKey: 0 },
    real,
  };
}

function property(real: Real) {
  return fc.asyncProperty(
    fc.commands(commands, { size: "max", maxCommands: 120 }),
    async (cmds) => {
      await fc.asyncModelRun(() => setup(real), cmds);
      const { violations } = await auditViolations(real.db.prisma, 5);
      expect(violations).toEqual([]);
    },
  );
}

const COVERAGE_SEED = 20261106;
const REQUIRED_COVERAGE = [
  "claimed",
  "claim_skipped_parked",
  "complete:ok",
  "complete:server_error",
  "complete:timeout",
  "complete:client_error",
  "complete:gone",
  "complete:redirect",
  "went_dead",
  "late_write",
  "late_write_same_worker_new_lease",
  "reaped",
  "poison_guard_counted",
  "poison_guard_dead",
  "released",
  "replayed_succeeded",
  "replayed_dead",
  "replay_refused_deleted",
  "bulk_replayed",
  "cancelled_from_pending",
  "cancelled_from_in_flight",
];

let db: TestDb;
let real: Real;

beforeAll(async () => {
  db = await startTestDb();
  await installDeliveryAudit(db.prisma);
  real = { db, repo: createRepository(db.prisma), queue: createDeliveryQueue(db.prisma) };
});
afterAll(async () => {
  await db?.stop();
});

describe("delivery state machine", () => {
  it("matches the model and breaks no invariant on random operation sequences", async () => {
    await fc.assert(property(real), {
      numRuns: NUM_RUNS,
      ...(SEED !== undefined ? { seed: SEED } : {}),
      ...(PATH ? { path: PATH } : {}),
    });
  }, 900_000);

  // Fixed seed, so this is deterministic: the run above uses a new seed each time and may miss a
  // rare path by chance, which should not fail the build.
  it("reaches every path, so a pass above means something", async () => {
    coverage.clear();
    await fc.assert(property(real), { numRuns: 50, seed: COVERAGE_SEED });
    console.log("state machine coverage:", Object.fromEntries([...coverage].sort()));
    for (const what of REQUIRED_COVERAGE) {
      expect(coverage.get(what) ?? 0, `operation never had an effect: ${what}`).toBeGreaterThan(0);
    }
  }, 900_000);

  it("the property fails when the queue is broken (test of the test)", async () => {
    const broken: Real = {
      ...real,
      queue: { ...real.queue, reapExpired: async () => [] },
    };
    const result = await fc.check(property(broken), {
      numRuns: 200,
      seed: 20261105,
      endOnFailure: true,
    });
    expect(result.failed).toBe(true);
  }, 300_000);
});

describe("audit history", () => {
  /** A project, endpoint and delivery, with a clean audit log. */
  async function oneDelivery(status: "active" | "disabled" = "active") {
    await db.prisma.$executeRawUnsafe(`TRUNCATE projects CASCADE`);
    await clearDeliveryAudit(db.prisma);
    const project = await real.repo.projects.create({ name: "audit" });
    const endpoint = await real.repo.endpoints.create(project.id, {
      url: "https://example.com/hooks",
      secretEnc: randomBytes(48),
      status,
    });
    const event = await real.repo.events.accept(project.id, {
      type: "x",
      payload: {},
      idempotencyKey: "k",
      requestHash: "h",
    });
    if (event.outcome !== "created") throw new Error("expected created");
    await db.prisma.$executeRaw`
      INSERT INTO deliveries (project_id, event_id, endpoint_id, status, next_attempt_at)
      VALUES (${project.id}::uuid, ${event.eventId}::uuid, ${endpoint.id}::uuid, 'pending', now())`;
    const row = await db.prisma.delivery.findFirstOrThrow({ where: { endpointId: endpoint.id } });
    return row.id;
  }

  async function rules(): Promise<AuditRule[]> {
    const { violations } = await auditViolations(db.prisma);
    return violations.map((v) => v.rule);
  }

  const lease = `locked_by = 'w', locked_until = now() + interval '1 minute', claim_token = gen_random_uuid()`;
  const noLease = `locked_by = NULL, locked_until = NULL, claim_token = NULL`;

  const cases: { name: string; rule: AuditRule; steps: string[]; parked?: boolean }[] = [
    {
      name: "pending straight to succeeded",
      rule: "illegal_transition",
      steps: [`status = 'succeeded'`],
    },
    {
      name: "leaving cancelled",
      rule: "illegal_transition",
      steps: [`status = 'cancelled'`, `status = 'pending'`],
    },
    {
      name: "using the failed status",
      rule: "illegal_transition",
      steps: [`status = 'in_flight', ${lease}`, `status = 'failed', ${noLease}`],
    },
    {
      name: "attempt_count going down outside a replay",
      rule: "attempt_count_decreased",
      steps: [`attempt_count = 5`, `attempt_count = 2`],
    },
    {
      name: "client_error_count going down outside a replay",
      rule: "client_error_count_decreased",
      steps: [`client_error_count = 2`, `client_error_count = 1`],
    },
    {
      name: "reap_count going down outside a replay",
      rule: "reap_count_decreased",
      steps: [`reap_count = 2`, `reap_count = 1`],
    },
    {
      name: "in_flight without a lease",
      rule: "lease_missing_while_in_flight",
      steps: [`status = 'in_flight'`],
    },
    {
      name: "a lease left on a finished delivery",
      rule: "lease_kept_outside_in_flight",
      steps: [`status = 'in_flight', ${lease}`, `status = 'succeeded'`],
    },
    {
      name: "a lease moving to another worker without a claim",
      rule: "lease_changed_hands_while_in_flight",
      steps: [`status = 'in_flight', ${lease}`, `locked_by = 'other'`],
    },
    {
      name: "claiming a parked delivery",
      rule: "claimed_parked_delivery",
      steps: [`status = 'in_flight', ${lease}`],
      parked: true,
    },
  ];

  it.each(cases)("flags $name", async ({ rule, steps, parked }) => {
    const id = await oneDelivery(parked ? "disabled" : "active");
    for (const step of steps) {
      await db.prisma.$executeRawUnsafe(`UPDATE deliveries SET ${step} WHERE id = '${id}'::uuid`);
    }
    expect(await rules()).toContain(rule);
  });

  it("flags attempt_no going backwards", async () => {
    await oneDelivery();
    await db.prisma.$executeRaw`
      INSERT INTO attempt_audit (delivery_id, attempt_no)
      VALUES (gen_random_uuid(), 1)`;
    const { delivery_id: id } = (
      await db.prisma.$queryRaw<{ delivery_id: string }[]>`
        SELECT delivery_id::text FROM attempt_audit LIMIT 1`
    )[0]!;
    await db.prisma.$executeRaw`
      INSERT INTO attempt_audit (delivery_id, attempt_no) VALUES (${id}::uuid, 1)`;
    expect(await rules()).toContain("attempt_no_not_increasing");
  });

  it("accepts a replay resetting the counters", async () => {
    const id = await oneDelivery();
    for (const step of [
      `status = 'in_flight', attempt_count = 3, reap_count = 1, ${lease}`,
      `status = 'dead', ${noLease}`,
      `status = 'pending', attempt_count = 0, reap_count = 0`,
    ]) {
      await db.prisma.$executeRawUnsafe(`UPDATE deliveries SET ${step} WHERE id = '${id}'::uuid`);
    }
    expect(await rules()).toEqual([]);
  });
});
