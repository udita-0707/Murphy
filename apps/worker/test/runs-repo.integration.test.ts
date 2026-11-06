import {
  createDeliveryQueue,
  createRepository,
  createRunQueue,
  type DeliveryQueue,
  type Repository,
  type RunQueue,
  type StartRunInput,
} from "@murphy/db";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";

let db: TestDb;
let repo: Repository;
let queue: DeliveryQueue;
let runs: RunQueue;
let projectId: string;
let otherProjectId: string;
let endpointId: string;
let scenarioId: string;

const SCENARIO = {
  slug: "dup",
  name: "Duplicate",
  difficulty: "beginner" as const,
  definitionYaml: "version: 1",
};

const newEndpoint = async (project: string) =>
  (
    await repo.endpoints.create(project, {
      url: "https://example.com/hooks",
      secretEnc: randomBytes(48),
    })
  ).id;

function runInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  const id = randomUUID();
  return {
    id,
    scenarioId,
    endpointId,
    seed: 42,
    targetLabel: "naive",
    stateUrl: "http://127.0.0.1:4343/state/naive",
    plan: { plan_version: 1 },
    deadlineOffsetMs: 60_000,
    entities: [{ kind: "reservation", externalId: "res_1", state: "confirmed" }],
    steps: [
      {
        eventType: "reservation.created",
        payload: { _murphy: { step: "created" } },
        idempotencyKey: `sim:${id}:created`,
        requestHash: "h1",
        dueOffsetsMs: [1_000],
      },
      {
        eventType: "reservation.confirmed",
        payload: { _murphy: { step: "confirmed" } },
        idempotencyKey: `sim:${id}:confirmed`,
        requestHash: "h2",
        dueOffsetsMs: [2_000, 3_000],
      },
    ],
    ...overrides,
  };
}

async function started(input = runInput()): Promise<string> {
  const result = await repo.runs.start(projectId, input);
  expect(result.outcome).toBe("started");
  return input.id;
}

/** Makes all of a run's rows finish, without sending anything. */
const finishRows = (runId: string, status: "succeeded" | "dead" = "succeeded") =>
  db.prisma.delivery.updateMany({
    where: { event: { scenarioRunId: runId } },
    data: { status, completedAt: new Date() },
  });

beforeAll(async () => {
  db = await startTestDb();
  repo = createRepository(db.prisma);
  queue = createDeliveryQueue(db.prisma);
  runs = createRunQueue(db.prisma);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.prisma.$executeRawUnsafe(`TRUNCATE projects CASCADE`);
  await db.prisma.$executeRawUnsafe(`DELETE FROM scenarios`);
  projectId = (await repo.projects.create({ name: "a" })).id;
  otherProjectId = (await repo.projects.create({ name: "b" })).id;
  endpointId = await newEndpoint(projectId);
  scenarioId = (await repo.scenarios.save(projectId, SCENARIO)).id;
});

describe("starting a run", () => {
  it("writes ordinary rows that are due later, one row per offset", async () => {
    const runId = await started();
    const rows = await db.prisma.delivery.findMany({
      where: { event: { scenarioRunId: runId } },
      orderBy: { nextAttemptAt: "asc" },
      include: { event: true },
    });
    expect(rows.map((r) => r.event.type)).toEqual([
      "reservation.created",
      "reservation.confirmed",
      "reservation.confirmed",
    ]);
    const run = await repo.runs.get(projectId, runId);
    const offsets = rows.map((r) => r.nextAttemptAt.getTime() - run!.startedAt!.getTime());
    expect(offsets).toEqual([1_000, 2_000, 3_000]);
    expect(rows.every((r) => r.status === "pending" && r.endpointId === endpointId)).toBe(true);
    expect(rows[1]!.eventId).toBe(rows[2]!.eventId);
  });

  it("sends nothing before it is due", async () => {
    await started();
    expect(
      await queue.claim({ workerId: "w", batchSize: 10, projectCap: 10, leaseMs: 60_000 }),
    ).toEqual([]);
  });

  it("does not fan out to the project's other endpoints", async () => {
    const other = await newEndpoint(projectId);
    const runId = await started();
    expect(await db.prisma.delivery.count({ where: { endpointId: other } })).toBe(0);
    expect(await db.prisma.delivery.count({ where: { event: { scenarioRunId: runId } } })).toBe(3);
  });

  it("marks events as simulated, and leaves ordinary events unmarked", async () => {
    const runId = await started();
    const events = await db.prisma.event.findMany({ where: { scenarioRunId: runId } });
    expect(events).toHaveLength(2);

    const ordinary = await repo.events.accept(projectId, {
      type: "x",
      payload: {},
      idempotencyKey: "plain",
      requestHash: "h",
    });
    const event = await repo.events.getWithDeliveries(projectId, ordinary.eventId);
    expect(event!.scenarioRunId).toBeNull();
    const simulated = await repo.events.getWithDeliveries(projectId, events[0]!.id);
    expect(simulated!.scenarioRunId).toBe(runId);
  });

  it("records the run, its plan, deadline and entities", async () => {
    const runId = await started();
    const run = await repo.runs.get(projectId, runId);
    expect(run).toMatchObject({
      status: "running",
      seed: 42,
      targetLabel: "naive",
      plan: { plan_version: 1 },
      report: null,
    });
    expect(run!.deadlineAt!.getTime() - run!.startedAt!.getTime()).toBe(60_000);
    expect(await db.prisma.simulatedEntity.findMany({ where: { runId } })).toMatchObject([
      { kind: "reservation", externalId: "res_1", state: "confirmed", projectId },
    ]);
  });

  it("refuses a disabled, paused or deleted endpoint, and leaves nothing behind", async () => {
    for (const status of ["disabled", "paused"] as const) {
      await repo.endpoints.update(projectId, endpointId, { status });
      expect(await repo.runs.start(projectId, runInput())).toEqual({
        outcome: "endpoint_not_available",
      });
    }
    await repo.endpoints.update(projectId, endpointId, { status: "active" });
    await repo.endpoints.delete(projectId, endpointId);
    expect(await repo.runs.start(projectId, runInput())).toEqual({
      outcome: "endpoint_not_available",
    });
    expect(await db.prisma.scenarioRun.count()).toBe(0);
    expect(await db.prisma.event.count()).toBe(0);
  });

  it("rolls back entirely if any part fails", async () => {
    const input = runInput();
    input.steps[1]!.idempotencyKey = input.steps[0]!.idempotencyKey;
    await expect(repo.runs.start(projectId, input)).rejects.toThrow();
    expect(await db.prisma.scenarioRun.count()).toBe(0);
    expect(await db.prisma.delivery.count()).toBe(0);
  });

  it("a delete in progress wins: the run waits, then is refused, with nothing stranded", async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const deleting = db.prisma.$transaction(async (tx) => {
      await tx.endpoint.update({ where: { id: endpointId }, data: { deletedAt: new Date() } });
      locked();
      await released;
    });
    await isLocked;
    const starting = repo.runs.start(projectId, runInput());
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    await deleting;
    expect(await starting).toEqual({ outcome: "endpoint_not_available" });
    expect(await db.prisma.delivery.count()).toBe(0);
  });

  it("a later delete cancels the run's rows", async () => {
    const runId = await started();
    await repo.endpoints.delete(projectId, endpointId);
    const rows = await db.prisma.delivery.findMany({ where: { event: { scenarioRunId: runId } } });
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["cancelled"]));
  });
});

describe("tenant isolation", () => {
  it("cannot start a run on another project's endpoint or scenario", async () => {
    const theirEndpoint = await newEndpoint(otherProjectId);
    const theirScenario = await repo.scenarios.save(otherProjectId, SCENARIO);
    expect(await repo.runs.start(projectId, runInput({ endpointId: theirEndpoint }))).toEqual({
      outcome: "endpoint_not_available",
    });
    expect(await repo.runs.start(projectId, runInput({ scenarioId: theirScenario.id }))).toEqual({
      outcome: "scenario_not_found",
    });
    expect(await db.prisma.scenarioRun.count()).toBe(0);
  });

  it("another project cannot read a run, its rows or its scenario", async () => {
    const runId = await started();
    expect(await repo.runs.get(otherProjectId, runId)).toBeNull();
    expect(await repo.runs.deliveries(otherProjectId, runId)).toEqual([]);
    expect(await repo.scenarios.get(otherProjectId, scenarioId)).toBeNull();
    expect(await repo.scenarios.list(otherProjectId)).toEqual([]);
  });

  it("another project cannot finish a run", async () => {
    const runId = await started();
    expect(await runs.finish(otherProjectId, runId, "passed", {})).toBe(false);
    expect((await repo.runs.get(projectId, runId))!.status).toBe("running");
  });
});

describe("scenarios", () => {
  it("saving the same slug replaces it, per project", async () => {
    const saved = await repo.scenarios.save(projectId, { ...SCENARIO, name: "New name" });
    expect(saved.id).toBe(scenarioId);
    expect(saved.name).toBe("New name");
    const theirs = await repo.scenarios.save(otherProjectId, SCENARIO);
    expect(theirs.id).not.toBe(scenarioId);
  });

  it("built-ins are visible to every project, and syncing is repeatable", async () => {
    await repo.scenarios.syncBuiltins([{ ...SCENARIO, slug: "builtin", name: "One" }]);
    await repo.scenarios.syncBuiltins([{ ...SCENARIO, slug: "builtin", name: "Two" }]);
    const builtins = await db.prisma.scenario.findMany({ where: { slug: "builtin" } });
    expect(builtins).toHaveLength(1);
    expect(builtins[0]).toMatchObject({ projectId: null, isPublic: true, name: "Two" });
    expect((await repo.scenarios.list(otherProjectId)).map((s) => s.slug)).toEqual(["builtin"]);
    expect(await repo.scenarios.get(otherProjectId, builtins[0]!.id)).not.toBeNull();
  });

  it("a run can use a built-in", async () => {
    await repo.scenarios.syncBuiltins([{ ...SCENARIO, slug: "builtin" }]);
    const builtin = await db.prisma.scenario.findFirstOrThrow({ where: { slug: "builtin" } });
    await started(runInput({ scenarioId: builtin.id }));
  });

  it("a project can have a scenario with a built-in's slug", async () => {
    await repo.scenarios.syncBuiltins([SCENARIO]);
    expect(await db.prisma.scenario.count({ where: { slug: SCENARIO.slug } })).toBe(2);
  });
});

describe("run deliveries", () => {
  it("lists rows with their step and attempts, without request headers", async () => {
    const runId = await started();
    const rows = await repo.runs.deliveries(projectId, runId);
    expect(rows.map((r) => r.step).sort()).toEqual(["confirmed", "confirmed", "created"]);

    await db.prisma.deliveryAttempt.create({
      data: {
        deliveryId: rows[0]!.deliveryId,
        projectId,
        attemptNo: 1,
        startedAt: new Date(),
        durationMs: 5,
        requestHeaders: { "webhook-signature": "v1,secret" },
        responseStatus: 200,
      },
    });
    const again = await repo.runs.deliveries(projectId, runId);
    const row = again.find((r) => r.deliveryId === rows[0]!.deliveryId)!;
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]!.responseStatus).toBe(200);
    expect(JSON.stringify(again)).not.toContain("webhook-signature");
  });
});

describe("the run queue", () => {
  it("offers a run only once nothing is left to send", async () => {
    const runId = await started();
    expect(await runs.listFinishable()).toEqual([]);
    await finishRows(runId, "dead");
    expect(await runs.listFinishable()).toEqual([{ id: runId, projectId, deadlinePassed: false }]);
  });

  it("offers a run past its deadline, even with rows still pending", async () => {
    const runId = await started(runInput({ deadlineOffsetMs: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await runs.listFinishable()).toEqual([{ id: runId, projectId, deadlinePassed: true }]);
  });

  it("stores the verdict once, and a finished run is no longer offered", async () => {
    const runId = await started();
    await finishRows(runId);
    expect(await runs.finish(projectId, runId, "failed", { verdict: "first" })).toBe(true);
    expect(await runs.finish(projectId, runId, "passed", { verdict: "second" })).toBe(false);
    expect(await repo.runs.get(projectId, runId)).toMatchObject({
      status: "failed",
      report: { verdict: "first" },
    });
    expect(await runs.listFinishable()).toEqual([]);
  });

  it("two finishers at once produce one verdict", async () => {
    const runId = await started();
    const results = await Promise.all([
      runs.finish(projectId, runId, "passed", {}),
      runs.finish(projectId, runId, "failed", {}),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
