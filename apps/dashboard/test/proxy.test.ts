import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/v1/[...path]/route";

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

function stubUpstream(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the API proxy", () => {
  it("forwards the path, query and bearer token, and nothing else", async () => {
    vi.stubEnv("MURPHY_API_URL", "http://api:1/");
    const calls = stubUpstream(() => Response.json({ data: [] }));
    const res = await GET(
      new Request("http://dash/api/v1/deliveries?status=dead", {
        headers: {
          authorization: "Bearer mk_x",
          cookie: "murphy-theme=night; other=secret",
          "x-forwarded-for": "1.2.3.4",
        },
      }),
      ctx("deliveries"),
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe("http://api:1/v1/deliveries?status=dead");
    const sent = new Headers(calls[0]?.init.headers);
    expect(sent.get("authorization")).toBe("Bearer mk_x");
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("forwards a body and an idempotency key", async () => {
    const calls = stubUpstream(() => Response.json({ id: "1" }, { status: 202 }));
    const res = await POST(
      new Request("http://dash/api/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "k" },
        body: '{"a":1}',
      }),
      ctx("events"),
    );
    expect(res.status).toBe(202);
    const sent = calls[0]?.init;
    expect(new Headers(sent?.headers).get("idempotency-key")).toBe("k");
    expect(new TextDecoder().decode(sent?.body as ArrayBuffer)).toBe('{"a":1}');
  });

  it("passes the API's own errors through unchanged", async () => {
    stubUpstream(() => Response.json({ error: { code: "unauthorized" } }, { status: 401 }));
    const res = await GET(new Request("http://dash/api/v1/runs"), ctx("runs"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized" } });
  });

  it("answers 502 when the API is down", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("refused");
    });
    const res = await GET(new Request("http://dash/api/v1/runs"), ctx("runs"));
    expect(res.status).toBe(502);
  });

  it.each([[".."], ["."], ["a/b"], ["a\\b"]])("refuses the path segment %s", async (segment) => {
    const calls = stubUpstream(() => Response.json({}));
    const res = await GET(new Request("http://dash/api/v1/x"), ctx("runs", segment));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("encodes a path segment, so it stays one segment", async () => {
    const calls = stubUpstream(() => Response.json({}));
    await GET(new Request("http://dash/api/v1/x"), ctx("runs", "a?b=c"));
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/v1/runs/a%3Fb%3Dc");
  });
});
