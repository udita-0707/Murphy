import { generateSigningSecret, signHeaders } from "@murphy/core";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { murphyTarget, type MurphyTargetOptions, type TargetEvent } from "../src/index.js";

const secret = generateSigningSecret();
let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function start(
  overrides: Partial<MurphyTargetOptions> = {},
  configure: (app: express.Express) => void = () => undefined,
) {
  const events: TargetEvent[] = [];
  const app = express();
  configure(app);
  app.use(
    "/hook",
    murphyTarget({
      secret,
      onEvent: (event) => void events.push(event),
      state: (runId) => ({
        entities: { [runId]: { state: "x", effects: { credit: 1 }, balance_minor: 5 } },
      }),
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/hook`;
  return { url, events };
}

const block = (forced?: { status: number; run_handler: boolean }[]) => ({
  simulated: true,
  version: 1,
  run_id: "run-1",
  scenario: "s",
  step: "t",
  event: "payment.captured",
  entity_id: "pay_1",
  ...(forced ? { forced_responses: forced } : {}),
});

function send(url: string, body: unknown, id = "msg_1", key = secret, timestamp?: number) {
  const text = JSON.stringify(body);
  const headers = signHeaders({
    id,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    body: text,
    secrets: [key],
  });
  return fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "webhook-event-type": "payment.captured",
    },
    body: text,
  });
}

describe("murphyTarget", () => {
  it("verifies, parses and calls the handler", async () => {
    const { url, events } = await start();
    const res = await send(url, { amount: 1, _murphy: block() });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      webhookId: "msg_1",
      type: "payment.captured",
      payload: { amount: 1 },
      murphy: { simulated: true, run_id: "run-1", entity_id: "pay_1" },
    });
  });

  it("handles an ordinary event, with no block", async () => {
    const { url, events } = await start();
    expect((await send(url, { amount: 1 })).status).toBe(200);
    expect(events[0]!.murphy).toBeNull();
  });

  it("rejects a wrong key, a tampered body, missing headers and an old timestamp", async () => {
    const { url, events } = await start();
    expect((await send(url, {}, "msg_1", generateSigningSecret())).status).toBe(401);
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 3_600;
    expect((await send(url, {}, "msg_1", secret, old)).status).toBe(401);

    const headers = signHeaders({
      id: "msg_1",
      timestamp: Math.floor(Date.now() / 1000),
      body: '{"amount":1}',
      secrets: [secret],
    });
    const tampered = await fetch(url, { method: "POST", headers, body: '{"amount":2}' });
    expect(tampered.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("an unsigned request cannot force a response", async () => {
    const { url } = await start();
    const body = JSON.stringify({ _murphy: block([{ status: 503, run_handler: false }]) });
    const res = await fetch(url, { method: "POST", body });
    expect(res.status).toBe(401);
  });

  it("accepts any currently valid secret", async () => {
    const other = generateSigningSecret();
    const { url } = await start({ secret: () => [other, secret] });
    expect((await send(url, {})).status).toBe(200);
    expect((await send(url, {}, "msg_2", other)).status).toBe(200);
    expect((await send(url, {}, "msg_3", generateSigningSecret())).status).toBe(401);
  });

  it("run_handler false: forces the status and skips the handler, then behaves normally", async () => {
    const { url, events } = await start();
    const body = { _murphy: block([{ status: 503, run_handler: false }]) };
    expect((await send(url, body)).status).toBe(503);
    expect(events).toHaveLength(0);
    expect((await send(url, body)).status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it("run_handler true: runs the handler but the reply says it failed", async () => {
    const { url, events } = await start();
    const body = { _murphy: block([{ status: 503, run_handler: true }]) };
    expect((await send(url, body)).status).toBe(503);
    expect(events).toHaveLength(1);
    expect((await send(url, body)).status).toBe(200);
    expect(events).toHaveLength(2);
  });

  it("forces a list of responses in order, and counts per webhook-id", async () => {
    const { url } = await start();
    const body = {
      _murphy: block([
        { status: 500, run_handler: false },
        { status: 429, run_handler: false },
      ]),
    };
    expect((await send(url, body, "a")).status).toBe(500);
    expect((await send(url, body, "b")).status).toBe(500);
    expect((await send(url, body, "a")).status).toBe(429);
    expect((await send(url, body, "a")).status).toBe(200);
  });

  it("obeyFaults false acts like a target without the helper", async () => {
    const { url, events } = await start({ obeyFaults: false });
    const body = { _murphy: block([{ status: 503, run_handler: false }]) };
    expect((await send(url, body)).status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it("a handler that throws answers 500", async () => {
    const { url } = await start({
      onEvent: () => {
        throw new Error("boom");
      },
    });
    const res = await send(url, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });

  it("reports each arrival", async () => {
    const seen: [number, number | null][] = [];
    const { url } = await start({
      onArrival: ({ arrival, forcedStatus }) => void seen.push([arrival, forcedStatus]),
    });
    const body = { _murphy: block([{ status: 503, run_handler: false }]) };
    await send(url, body);
    await send(url, body);
    expect(seen).toEqual([
      [1, 503],
      [2, null],
    ]);
  });

  it("serves state for a run, and requires the run id", async () => {
    const { url } = await start();
    expect(await (await fetch(`${url}/state?run_id=run-9`)).json()).toEqual({
      entities: { "run-9": { state: "x", effects: { credit: 1 }, balance_minor: 5 } },
    });
    expect((await fetch(`${url}/state`)).status).toBe(400);
  });

  it("says so if mounted after express.json()", async () => {
    const { url } = await start({}, (app) => app.use(express.json()));
    const res = await send(url, {});
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/before express\.json\(\)/);
  });
});
