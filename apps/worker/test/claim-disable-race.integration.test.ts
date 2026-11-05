import {
  createDeliveryQueue,
  createRepository,
  type DeliveryQueue,
  type Repository,
} from "@murphy/db";
import { auditViolations, clearDeliveryAudit, installDeliveryAudit } from "@murphy/db/audit";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";

/**
 * Regression for chaos seed 2002: a claim read an endpoint as active while a disable was
 * committing, and sent a delivery the disable should have parked (ADR 009).
 */

const HOLD_SECONDS = 0.6;
const LET_RACER_START_MS = 150;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let db: TestDb;
let repo: Repository;
let queue: DeliveryQueue;
let projectId: string;
let endpointId: string;

const claim = () => queue.claim({ workerId: "w", batchSize: 10, projectCap: 10, leaseMs: 60_000 });

async function newEndpoint(): Promise<string> {
  const { id } = await repo.endpoints.create(projectId, {
    url: "https://example.com/hooks",
    secretEnc: randomBytes(48),
  });
  return id;
}

async function ingest(key: string): Promise<void> {
  await repo.events.accept(projectId, {
    type: "payment.captured",
    payload: { id: "pay_1" },
    idempotencyKey: key,
    requestHash: "h",
  });
}

/** Holds a transaction open with the endpoint row updated but not committed. */
function holdEndpointUpdate(id: string, data: { status?: "disabled"; deletedAt?: Date }) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked: () => void = () => undefined;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const done = db.prisma.$transaction(async (tx) => {
    await tx.endpoint.update({ where: { id }, data });
    locked();
    await released;
  });
  return { isLocked, release, done };
}

beforeAll(async () => {
  db = await startTestDb();
  await installDeliveryAudit(db.prisma);
  repo = createRepository(db.prisma);
  queue = createDeliveryQueue(db.prisma);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.prisma.$executeRawUnsafe(`TRUNCATE projects CASCADE`);
  await clearDeliveryAudit(db.prisma);
  projectId = (await repo.projects.create({ name: "race" })).id;
  endpointId = await newEndpoint();
  await ingest("one");
});
afterEach(async () => {
  await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_hold ON deliveries`);
});

describe("claiming while an endpoint changes", () => {
  it("a disable during a claim waits for it, so nothing is claimed after the disable", async () => {
    await db.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_hold() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(${HOLD_SECONDS}); RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await db.prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_hold BEFORE UPDATE ON deliveries
      FOR EACH ROW WHEN (NEW.status = 'in_flight') EXECUTE FUNCTION test_hold()`);

    const claiming = claim();
    await wait(LET_RACER_START_MS);
    await repo.endpoints.update(projectId, endpointId, { status: "disabled" });
    expect(await claiming).toHaveLength(1);

    const { violations } = await auditViolations(db.prisma);
    expect(violations.map((v) => v.rule)).not.toContain("claimed_parked_delivery");
  });

  it("a claim skips an endpoint being disabled, without waiting for it", async () => {
    const hold = holdEndpointUpdate(endpointId, { status: "disabled" });
    await hold.isLocked;
    const started = Date.now();
    expect(await claim()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
    hold.release();
    await hold.done;
    expect(await claim()).toEqual([]);
  });

  it("a claim still takes other endpoints' work while one is being changed", async () => {
    const other = await newEndpoint();
    await ingest("two");
    const hold = holdEndpointUpdate(endpointId, { status: "disabled" });
    await hold.isLocked;
    const claimed = await claim();
    expect(claimed.length).toBeGreaterThan(0);
    expect(new Set(claimed.map((c) => c.endpointId))).toEqual(new Set([other]));
    hold.release();
    await hold.done;
  });

  it("does not deadlock with deletes under concurrency", async () => {
    for (let round = 0; round < 15; round++) {
      const id = await newEndpoint();
      for (let i = 0; i < 5; i++) await ingest(`deadlock-${round}-${i}`);
      const results = await Promise.allSettled([
        claim(),
        repo.endpoints.delete(projectId, id),
        claim(),
        ingest(`deadlock-${round}-last`),
      ]);
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    }
    const stranded = await db.prisma.delivery.count({
      where: { status: "pending", endpoint: { deletedAt: { not: null } } },
    });
    expect(stranded).toBe(0);
  }, 60_000);
});
