import { encryptSecret, generateSigningSecret, verify } from "@murphy/core";
import { createDeliveryQueue, createRepository, type DeliveryQueue } from "@murphy/db";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeliveryHandler, USER_AGENT, webhookId } from "../src/deliver.js";
import type { MurphyMode } from "../src/net/ssrf.js";
import {
  createFixture,
  insertDeliveries,
  startTestDb,
  type Fixture,
  type TestDb,
} from "./helpers.js";
import { hang, status, StubReceiver } from "./receiver.js";

let db: TestDb;
let queue: DeliveryQueue;
const key = randomBytes(32);
const secret = generateSigningSecret();
let receiver: StubReceiver;
const WORKER = "w-test";

beforeAll(async () => {
  db = await startTestDb();
  queue = createDeliveryQueue(db.prisma);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  receiver = new StubReceiver(secret);
  await receiver.start();
});
afterEach(async () => {
  await receiver.stop();
});

async function fixture(url = receiver.url): Promise<Fixture> {
  const f = await createFixture(db.prisma, { url, secretEnc: encryptSecret(secret, key) });
  await insertDeliveries(db.prisma, f, 1);
  return f;
}

function handler(overrides: { mode?: MurphyMode; timeoutMs?: number; now?: () => Date } = {}) {
  return createDeliveryHandler({
    queue,
    workerId: WORKER,
    encryptionKey: key,
    mode: overrides.mode ?? "local",
    requestTimeoutMs: overrides.timeoutMs ?? 2_000,
    now: overrides.now,
    random: () => 0.5,
  });
}

/** Claims everything due for this test's project and runs one attempt per delivery. */
async function runOnce(f: Fixture, h = handler()): Promise<number> {
  const claimed = (
    await queue.claim({ workerId: WORKER, batchSize: 100, projectCap: 100, leaseMs: 60_000 })
  ).filter((d) => d.projectId === f.projectId);
  for (const d of claimed) await h(d, new AbortController().signal);
  return claimed.length;
}

const delivery = (f: Fixture) =>
  db.prisma.delivery.findFirstOrThrow({ where: { eventId: f.eventId } });
const attempts = async (f: Fixture) =>
  db.prisma.deliveryAttempt.findMany({
    where: { delivery: { eventId: f.eventId } },
    orderBy: { attemptNo: "asc" },
  });
/** Makes a scheduled retry due now instead of waiting for the backoff. */
const pullForward = (f: Fixture) =>
  db.prisma.delivery.updateMany({
    where: { eventId: f.eventId },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });

describe("delivery execution", () => {
  it("delivers a signed request that verifies and logs the attempt", async () => {
    const f = await fixture();
    expect(await runOnce(f)).toBe(1);

    expect(receiver.received).toHaveLength(1);
    const req = receiver.received[0]!;
    expect(req.valid).toBe(true);
    expect(req.headers["webhook-id"]).toBe(webhookId(f.eventId));
    expect(req.headers["webhook-id"]).toBe(`msg_${f.eventId}`);
    expect(req.headers["user-agent"]).toBe(USER_AGENT);
    expect(JSON.parse(req.body)).toEqual({ id: "pay_1", amount: 49900 });

    const d = await delivery(f);
    expect(d).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
      lastStatusCode: 200,
      lockedBy: null,
    });
    expect(d.completedAt).not.toBeNull();

    const [a] = await attempts(f);
    expect(a).toMatchObject({
      attemptNo: 1,
      responseStatus: 200,
      responseBodySnippet: "ok",
      error: null,
    });
    expect(a!.projectId).toBe(f.projectId);
    const logged = a!.requestHeaders as Record<string, string>;
    expect(logged["webhook-signature"]).toBe(req.headers["webhook-signature"]);
    expect(JSON.stringify(a)).not.toContain(secret);
    expect(JSON.stringify(a)).not.toContain(secret.slice("whsec_".length));
  });

  it("retries a 500 twice, then succeeds, with a fresh timestamp and signature each time", async () => {
    const f = await fixture();
    receiver.script(status(500), status(500));
    let clock = Date.parse("2026-11-12T10:00:00Z");
    const h = handler({ now: () => new Date((clock += 37_000)) });

    await runOnce(f, h);
    expect(await delivery(f)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastStatusCode: 500,
    });
    const after1 = await delivery(f);
    expect(after1.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(3_000); // ~5 s backoff
    expect(await runOnce(f, h)).toBe(0); // not due yet

    await pullForward(f);
    await runOnce(f, h);
    expect(await delivery(f)).toMatchObject({ status: "pending", attemptCount: 2 });
    await pullForward(f);
    await runOnce(f, h);
    expect(await delivery(f)).toMatchObject({
      status: "succeeded",
      attemptCount: 3,
      lastStatusCode: 200,
      lastError: null,
    });

    expect((await attempts(f)).map((a) => [a.attemptNo, a.responseStatus])).toEqual([
      [1, 500],
      [2, 500],
      [3, 200],
    ]);
    const ids = new Set(receiver.received.map((r) => r.headers["webhook-id"]));
    const timestamps = new Set(receiver.received.map((r) => r.headers["webhook-timestamp"]));
    const signatures = new Set(receiver.received.map((r) => r.headers["webhook-signature"]));
    expect(ids.size).toBe(1);
    expect(timestamps.size).toBe(3);
    expect(signatures.size).toBe(3);
    expect(receiver.received.every((r) => r.valid)).toBe(true);
  });

  it("treats a timeout as retryable", async () => {
    const f = await fixture();
    receiver.script(hang);
    await runOnce(f, handler({ timeoutMs: 300 }));
    const d = await delivery(f);
    expect(d).toMatchObject({ status: "pending", attemptCount: 1, lastStatusCode: null });
    expect(d.lastError).toMatch(/^timeout/);
    const [a] = await attempts(f);
    expect(a!.error).toMatch(/^timeout/);
    expect(a!.durationMs).toBeGreaterThanOrEqual(250);
  });

  it("honours Retry-After on a 429", async () => {
    const f = await fixture();
    receiver.script(status(429, { "retry-after": "120" }));
    await runOnce(f);
    const d = await delivery(f);
    expect(d).toMatchObject({ status: "pending", lastStatusCode: 429 });
    const delay = d.nextAttemptAt.getTime() - Date.now();
    expect(delay).toBeGreaterThan(110_000);
    expect(delay).toBeLessThan(125_000);
  });

  it("goes dead once attempts are exhausted", async () => {
    const f = await fixture();
    await db.prisma.delivery.updateMany({
      where: { eventId: f.eventId },
      data: { attemptCount: 8 },
    });
    receiver.script(status(503));
    await runOnce(f);
    expect(await delivery(f)).toMatchObject({
      status: "dead",
      attemptCount: 9,
      lastStatusCode: 503,
    });
  });

  it("retries 404 at most twice, then dead", async () => {
    const f = await fixture();
    receiver.setFallback(status(404));
    for (let i = 0; i < 3; i++) {
      await pullForward(f);
      await runOnce(f);
    }
    expect(await delivery(f)).toMatchObject({
      status: "dead",
      attemptCount: 3,
      clientErrorCount: 3,
      lastStatusCode: 404,
    });
    await pullForward(f);
    expect(await runOnce(f)).toBe(0);
    expect(receiver.received).toHaveLength(3);
  });

  it.each([422, 302])("kills a %s without retrying", async (code) => {
    const f = await fixture();
    receiver.script(status(code, code === 302 ? { location: "http://169.254.169.254/" } : {}));
    await runOnce(f);
    expect(await delivery(f)).toMatchObject({
      status: "dead",
      attemptCount: 1,
      lastStatusCode: code,
    });
    expect(receiver.received).toHaveLength(1);
  });

  it("410 kills the delivery, disables the endpoint and parks its other deliveries", async () => {
    const f = await fixture();
    await insertDeliveries(db.prisma, f, 2); // siblings for the same endpoint
    receiver.script(status(410));
    const repo = createRepository(db.prisma);

    // Claim one at a time so only the first gets the 410.
    const [first] = await queue.claim({
      workerId: WORKER,
      batchSize: 1,
      projectCap: 1,
      leaseMs: 60_000,
    });
    await handler()(first!, new AbortController().signal);

    const rows = await db.prisma.delivery.findMany({ where: { eventId: f.eventId } });
    expect(rows.filter((r) => r.status === "dead")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
    const endpoint = await repo.endpoints.get(f.projectId, f.endpointId);
    expect(endpoint).toMatchObject({ status: "disabled" });
    expect(endpoint!.disabledAt).not.toBeNull();

    // Parked: not claimed while disabled.
    expect(await runOnce(f)).toBe(0);

    // PATCH status=active releases them.
    await repo.endpoints.update(f.projectId, f.endpointId, { status: "active" });
    expect(await runOnce(f)).toBe(2);
    const after = await db.prisma.delivery.findMany({ where: { eventId: f.eventId } });
    expect(after.filter((r) => r.status === "succeeded")).toHaveLength(2);
  });

  it("kills deliveries to blocked targets without sending anything", async () => {
    const f = await fixture(receiver.url); // http://127.0.0.1 is blocked in hosted mode
    await runOnce(f, handler({ mode: "hosted" }));
    const d = await delivery(f);
    expect(d).toMatchObject({ status: "dead", lastStatusCode: null });
    expect(d.lastError).toMatch(/ssrf_blocked: scheme_not_allowed/);
    expect(receiver.received).toHaveLength(0);
    expect((await attempts(f))[0]!.error).toMatch(/ssrf_blocked/);
  });

  it("keeps a delivery cancelled if its endpoint is deleted mid-request (attempt still logged)", async () => {
    const f = await fixture();
    const repo = createRepository(db.prisma);
    receiver.script((_req, res) => {
      // Delete the endpoint while the request is in flight, then answer 200.
      void repo.endpoints.delete(f.projectId, f.endpointId).then(() => res.end("ok"));
    });
    await runOnce(f);
    expect(await delivery(f)).toMatchObject({ status: "cancelled" });
    const [a] = await attempts(f);
    expect(a).toMatchObject({ attemptNo: 1, responseStatus: 200 });
  });

  it("logs a shutdown abort without changing the delivery", async () => {
    const f = await fixture();
    receiver.script(hang);
    const [claimed] = (
      await queue.claim({ workerId: WORKER, batchSize: 100, projectCap: 100, leaseMs: 60_000 })
    ).filter((d) => d.projectId === f.projectId);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await handler()(claimed!, controller.signal);
    expect(await delivery(f)).toMatchObject({
      status: "in_flight",
      attemptCount: 0,
      lockedBy: WORKER,
    });
    expect((await attempts(f))[0]!.error).toBe("worker_shutdown");
  });

  it("signs with the endpoint secret that only the worker decrypts", async () => {
    const f = await fixture();
    await runOnce(f);
    const req = receiver.received[0]!;
    const wrong = verify({
      id: req.headers["webhook-id"] as string,
      timestamp: req.headers["webhook-timestamp"] as string,
      signature: req.headers["webhook-signature"] as string,
      body: req.body,
      secret: generateSigningSecret(),
    });
    expect(wrong.valid).toBe(false);
  });
});
