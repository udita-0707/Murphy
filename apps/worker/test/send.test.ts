import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_SNIPPET_BYTES, sendWebhook } from "../src/net/send.js";
import type { Resolver } from "../src/net/ssrf.js";

let server: Server | undefined;
const received: IncomingMessage[] = [];

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  received.length = 0;
  server = createServer((req, res) => {
    received.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  const current = server;
  server = undefined;
  if (!current) return;
  current.closeAllConnections();
  await new Promise((resolve) => current.close(resolve));
});

const base = {
  headers: { "webhook-id": "msg_1" },
  body: '{"a":1}',
  mode: "local" as const,
  timeoutMs: 2_000,
};

describe("sendWebhook", () => {
  it("connects to the pinned IP, keeps the hostname in Host and never re-resolves", async () => {
    const port = await listen((_req, res) => res.end("ok"));
    // First answer is our local server; any later lookup would point somewhere unroutable.
    const answers = [
      [{ address: "127.0.0.1", family: 4 as const }],
      [{ address: "10.255.255.1", family: 4 as const }],
    ];
    const resolver = vi.fn<Resolver>(async () => answers.shift() ?? []);

    const result = await sendWebhook({
      ...base,
      url: `http://hooks.example.test:${port}/in`,
      resolver,
    });

    expect(result).toMatchObject({ ok: true, status: 200, bodySnippet: "ok" });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0]!.headers.host).toBe(`hooks.example.test:${port}`);
    expect(received[0]!.headers["webhook-id"]).toBe("msg_1");
    expect(received[0]!.headers["content-type"]).toBe("application/json");
    expect(received[0]!.method).toBe("POST");
  });

  it("does not follow redirects (a 302 to the metadata IP comes back as a 302)", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    });
    const result = await sendWebhook({ ...base, url: `http://127.0.0.1:${port}/` });
    expect(result).toMatchObject({ ok: true, status: 302 });
    expect(received).toHaveLength(1);
  });

  it("times out when the receiver never answers", async () => {
    const port = await listen(() => {});
    const result = await sendWebhook({ ...base, url: `http://127.0.0.1:${port}/`, timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
    expect(result.durationMs).toBeGreaterThanOrEqual(250);
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it("counts a slow body against the same total timeout", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200);
      res.write("partial"); // then stall
    });
    const result = await sendWebhook({ ...base, url: `http://127.0.0.1:${port}/`, timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
    expect(result.durationMs).toBeGreaterThanOrEqual(250);
    expect(result.durationMs).toBeLessThan(2_000);
  });

  it("reads at most 1 KB of the response body", async () => {
    const port = await listen((_req, res) => res.end("x".repeat(200_000)));
    const result = await sendWebhook({ ...base, url: `http://127.0.0.1:${port}/` });
    expect(result.ok && result.bodySnippet.length).toBe(MAX_BODY_SNIPPET_BYTES);
  });

  it("surfaces Retry-After and non-2xx statuses", async () => {
    const port = await listen((_req, res) =>
      res.writeHead(429, { "retry-after": "120" }).end("slow down"),
    );
    const result = await sendWebhook({ ...base, url: `http://127.0.0.1:${port}/` });
    expect(result).toMatchObject({
      ok: true,
      status: 429,
      retryAfter: "120",
      bodySnippet: "slow down",
    });
  });

  it("blocks disallowed targets before any connection is made", async () => {
    const port = await listen((_req, res) => res.end("ok"));
    const hosted = await sendWebhook({ ...base, mode: "hosted", url: `http://127.0.0.1:${port}/` });
    expect(hosted).toMatchObject({ ok: false, kind: "ssrf_blocked" });
    const hostedHttps = await sendWebhook({
      ...base,
      mode: "hosted",
      url: `https://127.0.0.1:${port}/`,
    });
    expect(hostedHttps).toMatchObject({ ok: false, kind: "ssrf_blocked" });
    expect(hostedHttps.ok || hostedHttps.error).toMatch(/address_blocked/);
    const metadata = await sendWebhook({
      ...base,
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(metadata).toMatchObject({ ok: false, kind: "ssrf_blocked" });
    expect(received).toHaveLength(0);
  });

  it("reports connection failures as network errors", async () => {
    const port = await listen(() => {});
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
    const result = await sendWebhook({ ...base, url: `http://127.0.0.1:${port}/` });
    expect(result).toMatchObject({ ok: false, kind: "network" });
    expect(result.ok || result.error).toMatch(/ECONNREFUSED/);
  });

  it("stops when the caller aborts (worker shutdown)", async () => {
    const port = await listen(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await sendWebhook({
      ...base,
      url: `http://127.0.0.1:${port}/`,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, kind: "aborted" });
  });
});
