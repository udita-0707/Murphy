import { generateSigningSecret, signHeaders } from "@murphy/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseReceiverArgs } from "../src/args.js";
import { applyPatch, type Receiver, startReceiver } from "../src/receiver.js";

const secret = generateSigningSecret();
let receiver: Receiver | undefined;
const lines: string[] = [];

afterEach(async () => {
  await receiver?.close();
  receiver = undefined;
  lines.length = 0;
});

async function start(
  options: Parameters<typeof startReceiver>[0] extends infer O ? Partial<O> : never = {},
) {
  receiver = await startReceiver({ port: 0, secret, log: (l) => lines.push(l), ...options });
  return receiver;
}

function send(url: string, id = "msg_1", signWith = secret, body = '{"amount":49900}') {
  const headers = signHeaders({
    id,
    timestamp: Math.floor(Date.now() / 1000),
    body,
    secrets: [signWith],
  });
  return fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
  });
}

const control = (r: Receiver, patch?: object) =>
  fetch(
    r.url.replace("/webhooks", "/_control"),
    patch ? { method: "POST", body: JSON.stringify(patch) } : {},
  );

describe("dev receiver", () => {
  it("accepts and logs correctly signed webhooks", async () => {
    const r = await start();
    const res = await send(r.url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(r.received).toMatchObject([
      { webhookId: "msg_1", signature: "valid", duplicate: false, status: 200 },
    ]);
    expect(lines.at(-1)).toMatch(/id=msg_1 signature=valid -> 200/);
  });

  it("rejects invalid signatures with 401 and says why", async () => {
    const r = await start();
    const res = await send(r.url, "msg_2", generateSigningSecret());
    expect(res.status).toBe(401);
    expect(r.received[0]).toMatchObject({ signature: "invalid", reason: "no_matching_signature" });
    expect(lines.at(-1)).toMatch(/signature=invalid \(no_matching_signature\) -> 401/);
  });

  it("does not check signatures without a secret", async () => {
    receiver = await startReceiver({ port: 0, log: () => {} });
    const res = await fetch(receiver.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(receiver.received[0]!.signature).toBe("unchecked");
  });

  it("flags repeated webhook-ids as duplicates", async () => {
    const r = await start();
    await send(r.url, "msg_dup");
    await send(r.url, "msg_dup");
    expect(r.received.map((x) => x.duplicate)).toEqual([false, true]);
    expect(lines.at(-1)).toMatch(/DUPLICATE/);
  });

  it("fails the first N requests with the given status and Retry-After", async () => {
    const r = await start({ fail: 2, status: 503, retryAfter: 7 });
    const first = await send(r.url);
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("7");
    expect((await send(r.url)).status).toBe(503);
    const third = await send(r.url);
    expect(third.status).toBe(200);
    expect(third.headers.get("retry-after")).toBeNull();
  });

  it("delays responses", async () => {
    const r = await start({ delayMs: 200 });
    const started = Date.now();
    await send(r.url);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it("changes behaviour at runtime through /_control and reports counts", async () => {
    const r = await start();
    const res = await control(r, { fail: 1, status: 429, retryAfter: 3 });
    expect(res.status).toBe(200);
    expect((await send(r.url, "msg_a")).status).toBe(429);
    expect((await send(r.url, "msg_b")).status).toBe(200);
    await send(r.url, "msg_b");
    await send(r.url, "msg_c", generateSigningSecret());
    const state = await (await control(r)).json();
    expect(state).toEqual({
      behaviour: { fail: 0, status: 429, delayMs: 0, retryAfter: 3 },
      received: 4,
      valid: 3,
      invalid: 1,
      duplicates: 1,
    });
    expect((await control(r, { colour: "red" })).status).toBe(400);
  });

  it("validates control patches", () => {
    const behaviour = { fail: 0, status: 500, delayMs: 0, retryAfter: null };
    expect(applyPatch(behaviour, { fail: -1 })).toMatch(/fail/);
    expect(applyPatch(behaviour, { status: 99 })).toMatch(/status/);
    expect(applyPatch(behaviour, { retryAfter: "soon" })).toMatch(/retryAfter/);
    expect(behaviour).toEqual({ fail: 0, status: 500, delayMs: 0, retryAfter: null });
    expect(applyPatch(behaviour, { fail: 2, retryAfter: null, delayMs: 10 })).toBeNull();
    expect(behaviour).toMatchObject({ fail: 2, delayMs: 10 });
  });
});

describe("parseReceiverArgs", () => {
  it("uses defaults, environment variables, then flags", () => {
    expect(parseReceiverArgs([], {})).toEqual({
      port: 4242,
      secret: undefined,
      fail: 0,
      status: 500,
      delayMs: 0,
      retryAfter: null,
    });
    expect(
      parseReceiverArgs([], {
        RECEIVER_PORT: "5000",
        RECEIVER_SECRET: "whsec_x",
        RECEIVER_FAIL: "2",
      }),
    ).toMatchObject({
      port: 5000,
      secret: "whsec_x",
      fail: 2,
    });
    expect(
      parseReceiverArgs(
        [
          "--port",
          "6000",
          "--fail",
          "3",
          "--status",
          "503",
          "--delay-ms",
          "8000",
          "--retry-after",
          "5",
          "--secret",
          "whsec_y",
        ],
        { RECEIVER_PORT: "5000" },
      ),
    ).toEqual({
      port: 6000,
      secret: "whsec_y",
      fail: 3,
      status: 503,
      delayMs: 8000,
      retryAfter: 5,
    });
  });

  it("rejects bad values and unknown flags", () => {
    expect(() => parseReceiverArgs(["--status", "700"], {})).toThrow(/--status/);
    expect(() => parseReceiverArgs(["--fail", "-1"], {})).toThrow(/--fail/);
    expect(() => parseReceiverArgs(["--colour", "red"], {})).toThrow();
    expect(parseReceiverArgs(["--help"], {})).toBe("help");
  });
});
