import { createDeliveryQueue, type DeliveryQueue } from "@murphy/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Worker } from "../src/worker.js";
import { createFixture, insertDeliveries, startTestDb, type TestDb } from "./helpers.js";

let db: TestDb;
let queue: DeliveryQueue;
const lease = { leaseMs: 60_000 };

beforeAll(async () => {
  db = await startTestDb();
  queue = createDeliveryQueue(db.prisma);
});

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.prisma.delivery.deleteMany();
});

describe("claim", () => {
  it("leases due rows to the worker", async () => {
    const f = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, f, 3);
    const before = Date.now();
    const claimed = await queue.claim({ workerId: "w1", batchSize: 10, projectCap: 10, ...lease });
    expect(claimed).toHaveLength(3);
    for (const d of claimed) {
      expect(d).toMatchObject({ status: "in_flight", lockedBy: "w1", projectId: f.projectId });
      expect(d.lockedUntil.getTime()).toBeGreaterThan(before + 55_000);
    }
    expect(await queue.claim({ workerId: "w2", batchSize: 10, projectCap: 10, ...lease })).toEqual(
      [],
    );
  });

  it("skips future, parked (disabled/paused) and deleted-endpoint deliveries", async () => {
    const future = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, future, 2, 60_000);
    for (const status of ["disabled", "paused"] as const) {
      await insertDeliveries(db.prisma, await createFixture(db.prisma, { status }), 2);
    }
    const deleted = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, deleted, 2);
    await db.prisma.endpoint.update({
      where: { id: deleted.endpointId },
      data: { deletedAt: new Date() },
    });

    expect(
      await queue.claim({ workerId: "w1", batchSize: 100, projectCap: 100, ...lease }),
    ).toEqual([]);

    // Re-activating a parked endpoint releases its deliveries.
    const parked = await db.prisma.endpoint.findFirstOrThrow({ where: { status: "paused" } });
    await db.prisma.endpoint.update({ where: { id: parked.id }, data: { status: "active" } });
    const released = await queue.claim({
      workerId: "w1",
      batchSize: 100,
      projectCap: 100,
      ...lease,
    });
    expect(released.map((d) => d.endpointId)).toEqual([parked.id, parked.id]);
  });

  it("takes the oldest due rows first", async () => {
    const f = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, f, 5);
    const all = await db.prisma.delivery.findMany({ orderBy: { nextAttemptAt: "asc" } });
    const claimed = await queue.claim({ workerId: "w1", batchSize: 2, projectCap: 10, ...lease });
    expect(claimed.map((d) => d.id).sort()).toEqual(
      all
        .slice(0, 2)
        .map((d) => d.id)
        .sort(),
    );
  });

  it("caps how many rows one project contributes per claim", async () => {
    const a = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, a, 20);
    const claimed = await queue.claim({ workerId: "w1", batchSize: 100, projectCap: 5, ...lease });
    expect(claimed).toHaveLength(5);
  });

  it("claims project B's single delivery in the same batch as project A's 1000", async () => {
    const a = await createFixture(db.prisma);
    const b = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, a, 1000, -60_000); // A's backlog is older than B's.
    await insertDeliveries(db.prisma, b, 1);

    const claimed = await queue.claim({ workerId: "w1", batchSize: 10, projectCap: 10, ...lease });
    expect(claimed).toHaveLength(10);
    expect(claimed.filter((d) => d.projectId === b.projectId)).toHaveLength(1);
    expect(claimed.filter((d) => d.projectId === a.projectId)).toHaveLength(9);
  });

  it("round-robins across projects when the batch is smaller than the total of caps", async () => {
    const projects = await Promise.all(Array.from({ length: 4 }, () => createFixture(db.prisma)));
    for (const p of projects) await insertDeliveries(db.prisma, p, 10);
    const claimed = await queue.claim({ workerId: "w1", batchSize: 8, projectCap: 10, ...lease });
    const perProject = projects.map(
      (p) => claimed.filter((d) => d.projectId === p.projectId).length,
    );
    expect(perProject).toEqual([2, 2, 2, 2]);
  });

  it("never gives the same row to two concurrent workers", async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => createFixture(db.prisma)));
    for (const f of fixtures) await insertDeliveries(db.prisma, f, 60);

    const drain = async (workerId: string) => {
      const ids: string[] = [];
      for (;;) {
        const claimed = await queue.claim({ workerId, batchSize: 7, projectCap: 3, ...lease });
        if (claimed.length === 0) return ids;
        ids.push(...claimed.map((d) => d.id));
      }
    };
    const results = await Promise.all(["w1", "w2", "w3", "w4"].map(drain));
    const all = results.flat();
    expect(all).toHaveLength(300);
    expect(new Set(all).size).toBe(300);
    expect(results.every((ids) => ids.length > 0)).toBe(true);

    const rows = await db.prisma.delivery.findMany();
    for (const [i, ids] of results.entries()) {
      const owned = new Set(ids);
      for (const row of rows.filter((r) => owned.has(r.id))) expect(row.lockedBy).toBe(`w${i + 1}`);
    }
  });
});

describe("Worker loop", () => {
  it("processes every due delivery with bounded concurrency", async () => {
    const f = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, f, 25);
    let active = 0;
    let peak = 0;
    const done: string[] = [];
    const worker = new Worker({
      queue,
      workerId: "w1",
      batchSize: 10,
      projectCap: 100,
      concurrency: 4,
      pollMs: 20,
      leaseMs: 60_000,
      handler: async (delivery) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        await db.prisma.delivery.update({
          where: { id: delivery.id },
          data: { status: "succeeded", lockedBy: null, lockedUntil: null },
        });
        done.push(delivery.id);
        active--;
      },
    });
    worker.start();
    await waitFor(() => done.length === 25);
    expect(await worker.stop(1_000)).toBe(0);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(new Set(done).size).toBe(25);
  });

  it("on shutdown stops claiming, then releases leases that did not finish in time", async () => {
    const f = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, f, 6);
    const started: string[] = [];
    const worker = new Worker({
      queue,
      workerId: "w-stop",
      batchSize: 10,
      projectCap: 100,
      concurrency: 3,
      pollMs: 20,
      leaseMs: 60_000,
      // Hangs until aborted, like a slow receiver.
      handler: (delivery, signal) => {
        started.push(delivery.id);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      onError: () => {},
    });
    worker.start();
    await waitFor(() => started.length === 3);
    const released = await worker.stop(100);
    expect(released).toBe(3);
    expect(worker.activeCount).toBe(0);

    const rows = await db.prisma.delivery.findMany();
    expect(rows.every((r) => r.status === "pending" && r.lockedBy === null)).toBe(true);
    expect(rows.every((r) => r.attemptCount === 0)).toBe(true);
  });

  it("lets in-flight work finish when it completes within the shutdown timeout", async () => {
    const f = await createFixture(db.prisma);
    await insertDeliveries(db.prisma, f, 1);
    let finished = false;
    const worker = new Worker({
      queue,
      workerId: "w-graceful",
      batchSize: 10,
      projectCap: 10,
      concurrency: 2,
      pollMs: 20,
      leaseMs: 60_000,
      handler: async (delivery) => {
        await new Promise((r) => setTimeout(r, 150));
        await db.prisma.delivery.update({
          where: { id: delivery.id },
          data: { status: "succeeded", lockedBy: null, lockedUntil: null },
        });
        finished = true;
      },
    });
    worker.start();
    await waitFor(() => worker.activeCount === 1);
    expect(await worker.stop(2_000)).toBe(0);
    expect(finished).toBe(true);
    expect((await db.prisma.delivery.findFirstOrThrow()).status).toBe("succeeded");
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
