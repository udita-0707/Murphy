import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/chaos/[action]/route";
import Chaos from "@/app/(app)/chaos/page";
import { chaosGuard } from "@/lib/chaos-server";
import {
  deliveryNote,
  parseSeconds,
  proofLine,
  refusedLine,
  workerLine,
  type TrafficStatus,
} from "@/lib/chaos";

const LOCAL = {
  MURPHY_MODE: "local",
  DATABASE_URL: "postgresql://u:p@localhost:54320/d",
  MURPHY_CONTROL_TOKEN: "control-token",
  MURPHY_CONTROL_URL: "http://control",
  MURPHY_API_URL: "http://api",
};
const setEnv = (values: Record<string, string>) => {
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
};
const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
const post = (
  action: string,
  body: unknown = {},
  headers: Record<string, string> = { authorization: "Bearer mk_x" },
) =>
  POST(
    new Request(`http://dash/api/chaos/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    ctx(action),
  );

type Call = { url: string; init: RequestInit };
function world(api: () => Response = () => Response.json({ data: [] })) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return url.startsWith("http://api") ? api() : Response.json({ ok: true });
  });
  return calls;
}

beforeEach(() => setEnv(LOCAL));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the chaos panel refuses to run outside local mode", () => {
  it.each([
    ["hosted mode", { MURPHY_MODE: "hosted" }, "only runs with MURPHY_MODE=local"],
    ["an unset mode", { MURPHY_MODE: "" }, "only runs with MURPHY_MODE=local"],
    [
      "a remote database",
      { DATABASE_URL: "postgresql://u:p@db.example.com/d" },
      "only runs against localhost",
    ],
    ["no database", { DATABASE_URL: "" }, "DATABASE_URL is not set"],
    ["no control service", { MURPHY_CONTROL_TOKEN: "" }, "pnpm demo:stack"],
  ])("refuses %s: every action answers 403, and nothing is called", async (_name, env, reason) => {
    setEnv(env);
    const calls = world();
    for (const action of [
      "kill-worker",
      "restart-postgres",
      "target-fail",
      "traffic-start",
      "traffic-stop",
    ]) {
      const res = await post(action);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("local_only");
      expect(body.error.message).toContain(reason);
    }
    expect(calls).toEqual([]);
  });

  it("the read-only status refuses too", async () => {
    setEnv({ MURPHY_MODE: "hosted" });
    const calls = world();
    const res = await GET(
      new Request("http://dash/api/chaos/status", { headers: { authorization: "Bearer mk_x" } }),
      ctx("status"),
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("the guard allows only local mode, a local database and a control service", () => {
    expect(chaosGuard(LOCAL as unknown as NodeJS.ProcessEnv)).toEqual({ ok: true });
    expect(chaosGuard({ ...LOCAL, MURPHY_MODE: "hosted" } as unknown as NodeJS.ProcessEnv).ok).toBe(
      false,
    );
  });

  it("the page says local only, and draws no buttons", () => {
    setEnv({ MURPHY_MODE: "hosted" });
    render(Chaos());
    expect(screen.getByText("Chaos panel: local only")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("in local mode", () => {
  it("needs a credential", async () => {
    const calls = world();
    expect((await post("kill-worker", {}, {})).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("refuses a credential the API refuses, before touching any process", async () => {
    const calls = world(() => Response.json({ error: { message: "no" } }, { status: 401 }));
    expect((await post("kill-worker")).status).toBe(401);
    expect(calls.some((c) => c.url.startsWith("http://control"))).toBe(false);
  });

  it("keeps working while the API is down, because Postgres restarting is the point", async () => {
    const calls = world(() => Response.json({ error: { message: "db down" } }, { status: 500 }));
    expect((await post("restart-postgres")).status).toBe(200);
    expect(calls.some((c) => c.url === "http://control/actions/restart-postgres")).toBe(true);
  });

  it("refuses a cookie session without its CSRF token", async () => {
    vi.stubEnv("DASHBOARD_URL", "http://dash");
    const calls = world();
    const res = await post(
      "kill-worker",
      {},
      { cookie: "murphy_session=ms_x", origin: "http://dash" },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("sends the control token to the service, and never back to the browser", async () => {
    const calls = world();
    const res = await post("kill-worker");
    expect(res.status).toBe(200);
    const sent = calls.find((c) => c.url.startsWith("http://control"))!;
    expect(new Headers(sent.init.headers).get("authorization")).toBe("Bearer control-token");
    expect(await res.text()).not.toContain("control-token");
  });

  it("uses a fixed list of actions: nothing else reaches the service", async () => {
    const calls = world();
    for (const name of ["../../etc", "constructor", "__proto__", "status"]) {
      expect((await post(name)).status).toBe(404);
    }
    expect(calls.some((c) => c.url.startsWith("http://control"))).toBe(false);
  });

  it("passes only the seconds to the target action", async () => {
    const calls = world();
    await post("target-fail", { seconds: 7, command: "rm" });
    const sent = calls.find((c) => c.url.startsWith("http://control"))!;
    expect(JSON.parse(sent.init.body as string)).toEqual({ seconds: 7 });
  });

  it("starts traffic as the signed-in project", async () => {
    const calls = world();
    await post("traffic-start");
    const sent = calls.find((c) => c.url.startsWith("http://control"))!;
    expect(JSON.parse(sent.init.body as string)).toEqual({ token: "mk_x" });
  });

  it("says when the control service is not there", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("http://api")) return Response.json({ data: [] });
      throw new Error("refused");
    });
    const res = await post("kill-worker");
    expect(res.status).toBe(502);
  });
});

describe("the proof line claims only what the counts back up", () => {
  const traffic = (over: Partial<TrafficStatus>): TrafficStatus => ({
    state: "idle",
    accepted: 10,
    delivered: 10,
    retrying: 0,
    dead: 0,
    lost: 0,
    refused: 0,
    last_checked_at: null,
    check_failing: false,
    ...over,
  });

  it("says nothing before there is traffic", () => {
    expect(proofLine(null).text).toContain("Nothing accepted yet");
    expect(proofLine(traffic({ accepted: 0 })).text).toContain("Nothing accepted yet");
  });
  it("only says all delivered when traffic has stopped and all are in", () => {
    expect(proofLine(traffic({}))).toEqual({
      tone: "good",
      text: "All 10 accepted events delivered. None lost.",
    });
  });
  it("does not claim victory while traffic runs", () => {
    expect(proofLine(traffic({ state: "running", retrying: 2 })).tone).toBe("wait");
  });
  it("does not claim victory with some still on their way", () => {
    expect(proofLine(traffic({ state: "draining", delivered: 8, retrying: 2 })).text).toContain(
      "Waiting on the last 2",
    );
  });
  it("says a loss plainly, above everything else", () => {
    expect(proofLine(traffic({ lost: 1, check_failing: true })).tone).toBe("bad");
  });
  it("assumes nothing while the API is away", () => {
    expect(proofLine(traffic({ check_failing: true })).tone).toBe("wait");
  });
  it("counts dead letters as replayable, not as delivered", () => {
    expect(proofLine(traffic({ delivered: 9, dead: 1 })).text).toBe(
      "None lost: 9 delivered, and 1 in dead letters to replay.",
    );
  });
});

describe("helpers", () => {
  it("says a crashed worker crashed, and never calls it running", () => {
    expect(workerLine({ name: "w", state: "crashed", pid: null })).toBe(
      "w: crashed on its own, not restarted",
    );
    expect(workerLine({ name: "w", state: "restarting", pid: null })).toBe("w: killed, restarting");
    expect(workerLine({ name: "w", state: "running", pid: 5 })).toBe("w: running, pid 5");
  });
  it("gets one refused send right", () => {
    expect(refusedLine(1)).toContain("refused 1 send while");
    expect(refusedLine(2)).toContain("refused 2 sends while");
  });
  it("explains a delivery that looks frozen", () => {
    expect(deliveryNote("in_flight", 0, 7_000)).toBe("waiting for the lease to expire");
    expect(deliveryNote("in_flight", 0, 1_000)).toBeNull();
    expect(deliveryNote("succeeded", 0, 7_000)).toBeNull();
    expect(deliveryNote("in_flight", undefined, 7_000)).toBeNull();
  });
  it("accepts only whole seconds in range", () => {
    expect(parseSeconds("15")).toBe(15);
    for (const bad of ["0", "61", "1.5", "abc", ""]) expect(parseSeconds(bad)).toBeNull();
  });
});
