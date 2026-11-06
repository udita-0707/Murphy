import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDemoEndpoint,
  copyNumber,
  faultsOnAttempt,
  MurphyApiClient,
  MurphyClientError,
  prepareDemoTarget,
  startPair,
  type LiveDelivery,
} from "../src/index.js";

type Call = { method: string; url: string; body: unknown; auth: string | null };

/** Answers fetch from a route table, and records every call. */
function stubFetch(answer: (call: Call) => Response | Error) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      method: init.method ?? "GET",
      url,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) throw result;
    return result;
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const api = new MurphyApiClient({ apiUrl: "http://api/", token: "mk_test" });
const target = { targetUrl: "http://target/" };

afterEach(() => vi.unstubAllGlobals());

describe("MurphyApiClient", () => {
  it("sends the bearer token and parses JSON", async () => {
    const calls = stubFetch(() => json({ ok: true }));
    await expect(api.request("GET", "/v1/runs/1")).resolves.toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ url: "http://api/v1/runs/1", auth: "Bearer mk_test" });
  });

  it("returns text for markdown", async () => {
    stubFetch(() => new Response("# Report", { headers: { "content-type": "text/markdown" } }));
    await expect(api.request("GET", "/x")).resolves.toBe("# Report");
  });

  it("reports the API's own error message and code", async () => {
    stubFetch(() => json({ error: { code: "nope", message: "not allowed" } }, 409));
    const err = await api.request("GET", "/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MurphyClientError);
    expect(err).toMatchObject({ kind: "api_error", status: 409, code: "nope" });
    expect((err as Error).message).toBe("GET /x answered 409: not allowed");
  });

  it("says when the API cannot be reached", async () => {
    stubFetch(() => new Error("refused"));
    await expect(api.request("GET", "/x")).rejects.toMatchObject({ kind: "api_unreachable" });
  });
});

describe("prepareDemoTarget", () => {
  it("creates an endpoint, then hands its secret to the target", async () => {
    const calls = stubFetch((c) =>
      c.url.endsWith("/_secrets")
        ? new Response(null, { status: 204 })
        : json({ id: "e1", secret: "whsec_x" }),
    );
    await expect(prepareDemoTarget(api, target, "naive")).resolves.toEqual({
      endpointId: "e1",
      stateUrl: "http://target/naive/state",
    });
    expect(calls[0]?.body).toMatchObject({
      url: "http://target/naive",
      event_filter: ["__murphy_simulation__"],
    });
    expect(calls[1]).toMatchObject({ url: "http://target/_secrets", auth: null });
  });

  it("sends the admin token to the target when there is one", async () => {
    const calls = stubFetch((c) =>
      c.url.endsWith("/_secrets")
        ? new Response(null, { status: 204 })
        : json({ id: "e1", secret: "whsec_x" }),
    );
    await prepareDemoTarget(api, { ...target, adminToken: "tok" }, "naive");
    expect(calls[1]?.auth).toBe("Bearer tok");
  });

  it.each([
    ["unreachable", () => new Error("refused"), "target_unreachable"],
    ["refusing", () => new Response(null, { status: 401 }), "target_refused"],
  ] as const)("deletes the endpoint when the target is %s", async (_n, secrets, kind) => {
    const calls = stubFetch((c) => {
      if (c.url.endsWith("/_secrets")) return secrets();
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      return json({ id: "e1", secret: "whsec_x" });
    });
    await expect(prepareDemoTarget(api, target, "naive")).rejects.toMatchObject({ kind });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "http://api/v1/endpoints/e1" });
  });
});

describe("startPair", () => {
  /** A working API and target, except for what `fail` refuses. */
  function stack(fail: (c: Call) => Response | null = () => null) {
    let endpoint = 0;
    return stubFetch((c) => {
      const failure = fail(c);
      if (failure) return failure;
      if (c.url.endsWith("/_secrets")) return new Response(null, { status: 204 });
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      if (c.url.endsWith("/v1/endpoints")) {
        endpoint += 1;
        return json({ id: `e${endpoint}`, secret: "whsec_x" });
      }
      const body = c.body as { target_label: string; seed: number };
      return json({ id: `run-${body.target_label}`, seed: body.seed }, 202);
    });
  }

  it("starts both handlers with the same scenario and seed", async () => {
    const calls = stack();
    const pair = await startPair(api, target, { scenarioId: "s1", seed: 42 });
    expect(pair.naive).toMatchObject({ outcome: "started", runId: "run-naive", seed: 42 });
    expect(pair.idempotent).toMatchObject({ outcome: "started", runId: "run-idempotent" });
    const runs = calls.filter((c) => c.url.endsWith("/v1/runs"));
    expect(runs.map((c) => c.body)).toEqual([
      expect.objectContaining({ scenario_id: "s1", seed: 42, target_label: "naive" }),
      expect.objectContaining({ scenario_id: "s1", seed: 42, target_label: "idempotent" }),
    ]);
  });

  it("creates endpoints before starting any run", async () => {
    const calls = stack();
    await startPair(api, target, { scenarioId: "s1" });
    const lastSecret = calls.map((c) => c.url).lastIndexOf("http://target/_secrets");
    const firstRun = calls.findIndex((c) => c.url.endsWith("/v1/runs"));
    expect(lastSecret).toBeLessThan(firstRun);
  });

  it("reports a side that did not start, leaves the other running, and removes the unused endpoint", async () => {
    const calls = stack((c) => {
      const body = c.body as { target_label?: string } | undefined;
      return c.url.endsWith("/v1/runs") && body?.target_label === "idempotent"
        ? json({ error: { message: "busy" } }, 429)
        : null;
    });
    const pair = await startPair(api, target, { scenarioId: "s1" });
    expect(pair.naive.outcome).toBe("started");
    expect(pair.idempotent).toEqual({
      handler: "idempotent",
      outcome: "did_not_start",
      reason: "POST /v1/runs answered 429: busy",
    });
    const deleted = calls.filter((c) => c.method === "DELETE");
    expect(deleted).toHaveLength(1);
  });

  it("does not start a side whose endpoint could not be prepared", async () => {
    let refused = false;
    const calls = stack((c) => {
      if (c.url.endsWith("/_secrets") && !refused) {
        refused = true;
        return new Response(null, { status: 500 });
      }
      return null;
    });
    const pair = await startPair(api, target, { scenarioId: "s1" });
    const outcomes = [pair.naive.outcome, pair.idempotent.outcome].sort();
    expect(outcomes).toEqual(["did_not_start", "started"]);
    expect(calls.filter((c) => c.url.endsWith("/v1/runs"))).toHaveLength(1);
  });
});

describe("cleanupDemoEndpoint", () => {
  const scene = (run: object, endpoint: Response | object) =>
    stubFetch((c) => {
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      if (c.url.includes("/v1/runs/")) return json({ endpoint_id: "e1", ...run });
      return endpoint instanceof Response ? endpoint : json(endpoint);
    });
  const ours = { description: "murphy run: naive", event_filter: ["__murphy_simulation__"] };
  const deletes = (calls: Call[]) => calls.filter((c) => c.method === "DELETE");

  it("deletes its own endpoint once the report is stored", async () => {
    const calls = scene({ report_ready: true }, ours);
    await expect(cleanupDemoEndpoint(api, "r1")).resolves.toBe("deleted");
    expect(deletes(calls)[0]?.url).toBe("http://api/v1/endpoints/e1");
  });

  it("keeps it while the run is still going", async () => {
    const calls = scene({ report_ready: false }, ours);
    await expect(cleanupDemoEndpoint(api, "r1")).resolves.toBe("kept");
    expect(deletes(calls)).toHaveLength(0);
  });

  it.each([
    ["another description", { ...ours, description: "my real endpoint" }],
    ["no description", { ...ours, description: null }],
    ["ordinary traffic", { ...ours, event_filter: [] }],
    ["an extra filter", { ...ours, event_filter: ["__murphy_simulation__", "x"] }],
  ])("never deletes an endpoint it did not create: %s", async (_name, endpoint) => {
    const calls = scene({ report_ready: true }, endpoint);
    await expect(cleanupDemoEndpoint(api, "r1")).resolves.toBe("kept");
    expect(deletes(calls)).toHaveLength(0);
  });

  it("is safe to call twice", async () => {
    scene({ report_ready: true }, json({ error: { message: "gone" } }, 404));
    await expect(cleanupDemoEndpoint(api, "r1")).resolves.toBe("kept");
  });
});

describe("timeline helpers", () => {
  const deliveries: LiveDelivery[] = [
    {
      delivery_id: "later",
      step: "confirmed",
      attempts: [{ attempt_no: 1, at_ms: 4400, status: 200, error: null }],
    },
    {
      delivery_id: "first",
      step: "confirmed",
      attempts: [{ attempt_no: 1, at_ms: 2870, status: 200, error: null }],
    },
  ];

  it("numbers copies by when they were first sent", () => {
    expect(copyNumber(deliveries, "confirmed", "first")).toBe(1);
    expect(copyNumber(deliveries, "confirmed", "later")).toBe(2);
  });

  it("shows a duplicate only on the later copy", () => {
    expect(faultsOnAttempt(deliveries, ["duplicate"], "confirmed", "first", 1)).toEqual([]);
    expect(faultsOnAttempt(deliveries, ["duplicate"], "confirmed", "later", 1)).toEqual([
      "duplicate",
    ]);
  });

  it("shows other faults only on the first attempt of the first copy", () => {
    expect(faultsOnAttempt(deliveries, ["delay"], "confirmed", "first", 1)).toEqual(["delay"]);
    expect(faultsOnAttempt(deliveries, ["delay"], "confirmed", "first", 2)).toEqual([]);
    expect(faultsOnAttempt(deliveries, ["delay"], "confirmed", "later", 1)).toEqual([]);
  });
});
