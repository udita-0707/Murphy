import { encryptSecret, generateSigningSecret, verify } from "@murphy/core";
import { createDeliveryQueue, createRepository, type DeliveryQueue } from "@murphy/db";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeliveryHandler } from "../src/deliver.js";
import { createFixture, insertDeliveries, startTestDb, type TestDb } from "./helpers.js";
import { StubReceiver } from "./receiver.js";

let db: TestDb;
let queue: DeliveryQueue;

beforeAll(async () => {
  db = await startTestDb();
  queue = createDeliveryQueue(db.prisma);
});
afterAll(async () => {
  await db?.stop();
});

describe("replay", () => {
  it("a delivery replayed an hour after the original still verifies", async () => {
    const key = randomBytes(32);
    const secret = generateSigningSecret();
    let clockMs = Date.parse("2026-11-12T10:00:00Z");
    // The receiver checks signatures against the same (fake) wall clock, 5-minute tolerance.
    const receiver = new StubReceiver(secret, () => Math.floor(clockMs / 1000));
    await receiver.start();
    try {
      const f = await createFixture(db.prisma, {
        url: receiver.url,
        secretEnc: encryptSecret(secret, key),
      });
      await insertDeliveries(db.prisma, f, 1);
      const handler = createDeliveryHandler({
        queue,
        workerId: "w1",
        encryptionKey: key,
        mode: "local",
        requestTimeoutMs: 2_000,
        now: () => new Date(clockMs),
      });
      const runOnce = async () => {
        const claimed = await queue.claim({
          workerId: "w1",
          batchSize: 10,
          projectCap: 10,
          leaseMs: 60_000,
        });
        for (const d of claimed) await handler(d, new AbortController().signal);
        return claimed.length;
      };

      expect(await runOnce()).toBe(1);
      const delivery = await db.prisma.delivery.findFirstOrThrow({ where: { eventId: f.eventId } });
      expect(delivery.status).toBe("succeeded");

      // An hour later the developer replays it.
      clockMs += 3_600_000;
      const replay = await createRepository(db.prisma).deliveries.replay(f.projectId, delivery.id);
      expect(replay.outcome).toBe("replayed");
      expect(await runOnce()).toBe(1);

      const [original, replayed] = receiver.received;
      expect(original!.valid).toBe(true);
      expect(replayed!.valid).toBe(true);
      expect(replayed!.headers["webhook-id"]).toBe(original!.headers["webhook-id"]);
      expect(
        Number(replayed!.headers["webhook-timestamp"]) -
          Number(original!.headers["webhook-timestamp"]),
      ).toBe(3600);

      // Re-sending the original signature an hour later would have been rejected.
      expect(
        verify({
          id: original!.headers["webhook-id"] as string,
          timestamp: original!.headers["webhook-timestamp"] as string,
          signature: original!.headers["webhook-signature"] as string,
          body: original!.body,
          secret,
          now: Math.floor(clockMs / 1000),
        }),
      ).toEqual({ valid: false, reason: "timestamp_too_old" });

      // The log keeps counting across the replay; the backoff counter restarted.
      const attempts = await db.prisma.deliveryAttempt.findMany({
        where: { deliveryId: delivery.id },
        orderBy: { attemptNo: "asc" },
      });
      expect(attempts.map((a) => [a.attemptNo, a.responseStatus])).toEqual([
        [1, 200],
        [2, 200],
      ]);
      expect(
        await db.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).toMatchObject({
        status: "succeeded",
        attemptCount: 1,
      });
    } finally {
      await receiver.stop();
    }
  });
});
