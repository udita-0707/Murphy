import { createRepository, type Repository } from "@murphy/db";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";

/**
 * Deleting an endpoint must leave no delivery waiting forever. A delivery that becomes pending
 * after the delete has swept the endpoint's rows would never be claimed (the claim skips deleted
 * endpoints) and never be cancelled. A test-only trigger holds the racing transaction open at the
 * exact moment, so these interleavings happen every time rather than by luck.
 */

const HOLD_SECONDS = 0.6;
const LET_RACER_START_MS = 150;

let db: TestDb;
let repo: Repository;
let projectId: string;
let endpointId: string;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function holdWrites(table: string, when: string): Promise<void> {
  await db.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_hold() RETURNS trigger AS $$
    BEGIN PERFORM pg_sleep(${HOLD_SECONDS}); RETURN NEW; END;
    $$ LANGUAGE plpgsql`);
  await db.prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_hold BEFORE ${when.startsWith("INSERT") ? "INSERT" : "UPDATE"} ON ${table}
    FOR EACH ROW ${when.includes("WHEN") ? when.slice(when.indexOf("WHEN")) : ""}
    EXECUTE FUNCTION test_hold()`);
}

async function dropHolds(): Promise<void> {
  for (const table of ["deliveries", "endpoints"]) {
    await db.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_hold ON ${table}`);
  }
}

const accept = (key: string) =>
  repo.events.accept(projectId, {
    type: "payment.captured",
    payload: { id: "pay_1" },
    idempotencyKey: key,
    requestHash: "h",
  });

/** A delivery that has finished as dead, so it can be replayed. */
async function deadDelivery(): Promise<string> {
  await accept("first");
  const row = await db.prisma.delivery.findFirstOrThrow({ where: { endpointId } });
  await db.prisma.delivery.update({
    where: { id: row.id },
    data: { status: "dead", completedAt: new Date() },
  });
  return row.id;
}

/** Deliveries no worker will ever pick up: waiting, on an endpoint that no longer exists. */
const stranded = () =>
  db.prisma.delivery.count({
    where: {
      projectId,
      status: { in: ["pending", "in_flight"] },
      endpoint: { deletedAt: { not: null } },
    },
  });

beforeAll(async () => {
  db = await startTestDb();
  repo = createRepository(db.prisma);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  projectId = (await repo.projects.create({ name: "race" })).id;
  endpointId = (
    await repo.endpoints.create(projectId, {
      url: "https://example.com/hooks",
      secretEnc: randomBytes(48),
    })
  ).id;
});
afterEach(dropHolds);

describe("deleting an endpoint during a racing write", () => {
  it("accept in progress when the delete runs: its delivery is cancelled, not stranded", async () => {
    await holdWrites("deliveries", "INSERT");
    const accepting = accept("racing");
    await wait(LET_RACER_START_MS);
    await repo.endpoints.delete(projectId, endpointId);
    expect((await accepting).outcome).toBe("created");

    expect(await stranded()).toBe(0);
    const rows = await db.prisma.delivery.findMany({ where: { endpointId } });
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("delete in progress when accept runs: the event gets no delivery for that endpoint", async () => {
    await holdWrites("endpoints", "UPDATE");
    const deleting = repo.endpoints.delete(projectId, endpointId);
    await wait(LET_RACER_START_MS);
    await accept("racing");
    expect(await deleting).toBe(true);
    expect(await stranded()).toBe(0);
  });

  it("replay in progress when the delete runs: the delivery is not stranded", async () => {
    const id = await deadDelivery();
    await holdWrites("deliveries", "UPDATE WHEN (NEW.status = 'pending' AND OLD.status = 'dead')");
    const replaying = repo.deliveries.replay(projectId, id);
    await wait(LET_RACER_START_MS);
    await repo.endpoints.delete(projectId, endpointId);
    await replaying;
    expect(await stranded()).toBe(0);
  });

  it("bulk replay in progress when the delete runs: the delivery is not stranded", async () => {
    await deadDelivery();
    await holdWrites("deliveries", "UPDATE WHEN (NEW.status = 'pending' AND OLD.status = 'dead')");
    const replaying = repo.deliveries.bulkReplay(projectId, { statuses: ["dead"] });
    await wait(LET_RACER_START_MS);
    await repo.endpoints.delete(projectId, endpointId);
    await replaying;
    expect(await stranded()).toBe(0);
  });
});
