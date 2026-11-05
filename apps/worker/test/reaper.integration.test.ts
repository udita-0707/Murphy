import { encryptSecret, generateSigningSecret } from "@murphy/core";
import { createDeliveryQueue, type DeliveryQueue } from "@murphy/db";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeliveryHandler } from "../src/deliver.js";
import { FREE_REAPS, reapOnce, startReaper } from "../src/reaper.js";
import {
  createFixture,
  insertDeliveries,
  startTestDb,
  type Fixture,
  type TestDb,
} from "./helpers.js";
import { StubReceiver } from "./receiver.js";

let db: TestDb;
let queue: DeliveryQueue;
const key = randomBytes(32);
const secret = generateSigningSecret();
let receiver: StubReceiver;

beforeAll(async () => {
  db = await startTestDb();
  queue = createDeliveryQueue(db.prisma);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.prisma.delivery.deleteMany();
  receiver = new StubReceiver(secret);
  await receiver.start();
});
afterEach(async () => {
  await receiver.stop();
});

async function fixture(count = 1): Promise<Fixture> {
  const f = await createFixture(db.prisma, {
    url: receiver.url,
    secretEnc: encryptSecret(secret, key),
  });
  await insertDeliveries(db.prisma, f, count);
  return f;
}

const claim = (workerId: string) =>
  queue.claim({ workerId, batchSize: 100, projectCap: 100, leaseMs: 60_000 });
/** Simulates the lease running out (the worker died or hung). */
const expireLeases = () =>
  db.prisma.delivery.updateMany({
    where: { status: "in_flight" },
    data: { lockedUntil: new Date(Date.now() - 1_000) },
  });
const only = () => db.prisma.delivery.findFirstOrThrow();
const attempts = () => db.prisma.deliveryAttempt.findMany({ orderBy: { attemptNo: "asc" } });

describe("reaper", () => {
  it("returns an abandoned delivery to pending so a second worker completes it", async () => {
    await fixture();
    const [abandoned] = await claim("w-dead"); // worker w-dead dies here
    expect(abandoned).toBeDefined();

    expect(await reapOnce(queue)).toEqual([]); // lease not expired yet
    await expireLeases();
    const reaped = await reapOnce(queue);
    expect(reaped).toEqual([
      {
        id: abandoned!.id,
        projectId: abandoned!.projectId,
        previousWorker: "w-dead",
        reapCount: 1,
        outcome: "pending",
      },
    ]);

    const d = await only();
    expect(d).toMatchObject({
      status: "pending",
      lockedBy: null,
      lockedUntil: null,
      attemptCount: 0,
      reapCount: 1,
    });
    // Postgres and the host have separate clocks, so allow for skew.
    expect(d.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await attempts()).toMatchObject([
      { attemptNo: 1, error: "lease_expired", responseStatus: null },
    ]);

    // A healthy worker picks it up and delivers it.
    const [retry] = await claim("w-alive");
    await createDeliveryHandler({
      queue,
      workerId: "w-alive",
      encryptionKey: key,
      mode: "local",
      requestTimeoutMs: 2_000,
    })(retry!, new AbortController().signal);

    expect(await only()).toMatchObject({ status: "succeeded", attemptCount: 1, lockedBy: null });
    expect((await attempts()).map((a) => [a.attemptNo, a.error, a.responseStatus])).toEqual([
      [1, "lease_expired", null],
      [2, null, 200],
    ]);
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]!.valid).toBe(true);
  });

  it("ignores a late write from the worker whose lease was reaped", async () => {
    await fixture();
    const [stale] = await claim("w-slow");
    await expireLeases();
    await reapOnce(queue);
    await claim("w-new");

    // w-slow finally finishes and tries to record success: logged, but the row is not touched.
    const result = await queue.recordAttempt(
      stale!.id,
      stale!.claimToken,
      {
        startedAt: new Date(),
        durationMs: 70_000,
        requestHeaders: {},
        responseStatus: 200,
        responseBodySnippet: "ok",
        error: null,
      },
      { kind: "succeeded", attemptCount: 1, clientErrorCount: 0, lastStatusCode: 200 },
    );
    expect(result).toEqual({ applied: false, attemptNo: 2 });
    expect(await only()).toMatchObject({ status: "in_flight", lockedBy: "w-new", attemptCount: 0 });
  });

  // Regression, seed 1990363018: the guard could not tell two leases of the same worker apart.
  it("ignores a late write from a lost lease when the same worker holds a newer lease", async () => {
    await fixture();
    const [stale] = await claim("w-same");
    await expireLeases();
    await reapOnce(queue);
    const [current] = await claim("w-same");
    expect(current!.claimToken).not.toBe(stale!.claimToken);

    const log = {
      startedAt: new Date(),
      durationMs: 1,
      requestHeaders: {},
      responseStatus: 500,
      responseBodySnippet: null,
      error: null,
    };
    const failed = {
      kind: "retry",
      attemptCount: 1,
      clientErrorCount: 0,
      delayMs: 1_000,
      lastStatusCode: 500,
      lastError: "HTTP 500",
    } as const;

    expect(await queue.recordAttempt(stale!.id, stale!.claimToken, log, failed)).toEqual({
      applied: false,
      attemptNo: 2,
    });
    expect(await only()).toMatchObject({
      status: "in_flight",
      lockedBy: "w-same",
      claimToken: current!.claimToken,
      attemptCount: 0,
    });

    expect((await queue.recordAttempt(current!.id, current!.claimToken, log, failed)).applied).toBe(
      true,
    );
    expect(await only()).toMatchObject({ status: "pending", attemptCount: 1, claimToken: null });
  });

  it("increments attempt_count in place, whatever value the outcome was computed from", async () => {
    await fixture();
    await db.prisma.delivery.updateMany({ data: { attemptCount: 5 } });
    const [claimed] = await claim("w");
    await queue.recordAttempt(
      claimed!.id,
      claimed!.claimToken,
      {
        startedAt: new Date(),
        durationMs: 1,
        requestHeaders: {},
        responseStatus: 500,
        responseBodySnippet: null,
        error: null,
      },
      {
        kind: "retry",
        attemptCount: 1, // stale: computed from an old read
        clientErrorCount: 0,
        delayMs: 1_000,
        lastStatusCode: 500,
        lastError: "HTTP 500",
      },
    );
    expect(await only()).toMatchObject({ attemptCount: 6 });
  });

  it("follows a replacement schedule when the poison guard counts a reap", async () => {
    await fixture();
    await db.prisma.delivery.updateMany({ data: { reapCount: FREE_REAPS } });
    await claim("w");
    await expireLeases();
    const [reaped] = await reapOnce(queue, 100, [60_000]);
    expect(reaped).toMatchObject({ outcome: "retry" });
    expect((await only()).nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(30_000);

    await db.prisma.delivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await claim("w");
    await expireLeases();
    const [exhausted] = await reapOnce(queue, 100, [60_000]);
    expect(exhausted).toMatchObject({ outcome: "dead" });
  });

  it(`does not count the first ${FREE_REAPS} reaps, then counts each one as an attempt (poison guard)`, async () => {
    await fixture();
    for (let i = 1; i <= FREE_REAPS; i++) {
      await claim(`w${i}`);
      await expireLeases();
      const [r] = await reapOnce(queue);
      expect(r).toMatchObject({ reapCount: i, outcome: "pending" });
      expect(await only()).toMatchObject({ status: "pending", attemptCount: 0, reapCount: i });
    }

    await claim("w4");
    await expireLeases();
    const [fourth] = await reapOnce(queue);
    expect(fourth).toMatchObject({ reapCount: 4, outcome: "retry" });
    const d = await only();
    expect(d).toMatchObject({ status: "pending", attemptCount: 1, reapCount: 4 });
    const delay = d.nextAttemptAt.getTime() - Date.now();
    expect(delay).toBeGreaterThan(3_000); // first backoff step, 5 s +/- 20%
    expect(delay).toBeLessThan(6_500);
    const log = await attempts();
    expect(log.map((a) => a.attemptNo)).toEqual([1, 2, 3, 4]);
    expect(log[3]!.error).toBe("lease_expired: reaped 4 times, counted as attempt 1");
  });

  it("kills a poison delivery once counted reaps exhaust the schedule", async () => {
    await fixture();
    await db.prisma.delivery.updateMany({ data: { attemptCount: 8, reapCount: FREE_REAPS } });
    await claim("w1");
    await expireLeases();
    const [r] = await reapOnce(queue);
    expect(r).toMatchObject({ outcome: "dead", reapCount: FREE_REAPS + 1 });
    expect(await only()).toMatchObject({ status: "dead", attemptCount: 9, lockedBy: null });
  });

  it("never reaps the same row twice when reapers run concurrently", async () => {
    await fixture(40);
    await claim("w-dead");
    await expireLeases();
    const results = await Promise.all([
      reapOnce(queue, 15),
      reapOnce(queue, 15),
      reapOnce(queue, 15),
      reapOnce(queue, 15),
    ]);
    const ids = results.flat().map((r) => r.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(await db.prisma.deliveryAttempt.count()).toBe(40);
    expect(await db.prisma.delivery.count({ where: { status: "pending" } })).toBe(40);
  });

  it("leaves live leases and finished deliveries alone", async () => {
    await fixture(3);
    await claim("w-alive"); // three live 60 s leases
    expect(await reapOnce(queue)).toEqual([]);
    expect(await db.prisma.delivery.count({ where: { status: "in_flight" } })).toBe(3);

    // A finished delivery with a stale locked_until is not in_flight, so it is not reaped.
    const [one] = await db.prisma.delivery.findMany({ take: 1 });
    await db.prisma.delivery.update({
      where: { id: one!.id },
      data: { status: "succeeded", lockedUntil: new Date(Date.now() - 60_000) },
    });
    expect(await reapOnce(queue)).toEqual([]);
  });

  it("runs on an interval until stopped", async () => {
    await fixture(2);
    await claim("w-dead");
    await expireLeases();
    const seen: number[] = [];
    const stop = startReaper({ queue, intervalMs: 50, onReap: (r) => seen.push(r.length) });
    const start = Date.now();
    while (seen.length === 0 && Date.now() - start < 5_000)
      await new Promise((r) => setTimeout(r, 20));
    await stop();
    expect(seen).toEqual([2]);
    expect(await db.prisma.delivery.count({ where: { status: "pending" } })).toBe(2);
  });
});
