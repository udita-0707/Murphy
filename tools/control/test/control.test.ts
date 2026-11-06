import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createControlApp, type ControlActions } from "../src/control.js";
import { classify } from "../src/traffic.js";
import { LEASE_SAFETY_MARGIN_MS } from "../../../apps/worker/src/config.js";
import { DEMO_LEASE_MS, DEMO_RETRY_SCHEDULE_MS, workerEnv } from "../src/worker-env.js";

const TOKEN = "t".repeat(64);
const PORT = 4545;

function actions(over: Partial<ControlActions> = {}): ControlActions {
  return {
    workers: () => [{ name: "worker-1", state: "running", pid: 1 }],
    killWorker: vi.fn(async () => ({ killed: "worker-1" })),
    restartPostgres: vi.fn(async () => undefined),
    failTarget: vi.fn(async () => undefined),
    targetStatus: async () => ({ failing: false, fail_until: null, received: 0 }),
    ...over,
  };
}

const app = (a = actions()) =>
  createControlApp({
    token: TOKEN,
    port: PORT,
    apiUrl: "http://127.0.0.1:1",
    sinkUrl: "http://127.0.0.1:1/_chaos/sink",
    actions: a,
  });

const auth = { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}` };

describe("who may call the control service", () => {
  it("allows the right token and host", async () => {
    expect((await request(app()).get("/status").set(auth)).status).toBe(200);
  });

  it("refuses a missing or wrong token, and does nothing", async () => {
    const a = actions();
    const none = await request(app(a)).post("/actions/kill-worker").set("host", auth.host);
    expect(none.status).toBe(401);
    const wrong = await request(app(a))
      .post("/actions/kill-worker")
      .set({ ...auth, authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
    expect(a.killWorker).not.toHaveBeenCalled();
  });

  it("refuses a wrong Host, which is what DNS rebinding looks like", async () => {
    const a = actions();
    const res = await request(app(a))
      .post("/actions/kill-worker")
      .set({ ...auth, host: "evil.example:4545" });
    expect(res.status).toBe(403);
    expect(a.killWorker).not.toHaveBeenCalled();
  });

  it("refuses anything a browser sent, even with the token", async () => {
    const a = actions();
    const res = await request(app(a))
      .post("/actions/kill-worker")
      .set({ ...auth, origin: "http://127.0.0.1:3100" });
    expect(res.status).toBe(403);
    expect(a.killWorker).not.toHaveBeenCalled();
  });
});

describe("the actions", () => {
  it("kills a worker, and records it", async () => {
    const a = actions();
    const server = app(a);
    const res = await request(server).post("/actions/kill-worker").set(auth);
    expect(res.body).toEqual({ killed: "worker-1" });
    const status = await request(server).get("/status").set(auth);
    expect((status.body as { log: { action: string }[] }).log[0]?.action).toBe("Kill a worker");
  });

  it("says when there is no worker to kill", async () => {
    const res = await request(app(actions({ killWorker: async () => null })))
      .post("/actions/kill-worker")
      .set(auth);
    expect(res.status).toBe(409);
  });

  it("restarts Postgres one at a time, answering at once", async () => {
    let finish: () => void = () => undefined;
    const a = actions({
      restartPostgres: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    const server = app(a);
    expect((await request(server).post("/actions/restart-postgres").set(auth)).status).toBe(202);
    expect((await request(server).post("/actions/restart-postgres").set(auth)).status).toBe(409);
    const during = await request(server).get("/status").set(auth);
    expect((during.body as { postgres_restarting: boolean }).postgres_restarting).toBe(true);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await request(server).post("/actions/restart-postgres").set(auth)).status).toBe(202);
    expect(a.restartPostgres).toHaveBeenCalledTimes(2);
  });

  it("records a Postgres restart that failed, and is not stuck after it", async () => {
    const server = app(
      actions({ restartPostgres: async () => Promise.reject(new Error("no docker")) }),
    );
    await request(server).post("/actions/restart-postgres").set(auth);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = (await request(server).get("/status").set(auth)).body as {
      postgres_restarting: boolean;
      log: { outcome: string; detail: string }[];
    };
    expect(status.postgres_restarting).toBe(false);
    expect(status.log[0]).toMatchObject({ outcome: "failed", detail: "no docker" });
  });

  it("makes the target fail within limits", async () => {
    const a = actions();
    const server = app(a);
    expect(
      (await request(server).post("/actions/target-fail").set(auth).send({ seconds: 10 })).status,
    ).toBe(200);
    expect(a.failTarget).toHaveBeenCalledWith(10);
  });

  it.each([0, 61, -1, 1.5, "10", null, undefined])("refuses %s seconds", async (seconds) => {
    const a = actions();
    const res = await request(app(a)).post("/actions/target-fail").set(auth).send({ seconds });
    expect(res.status).toBe(400);
    expect(a.failTarget).not.toHaveBeenCalled();
  });

  it("says when the target did not answer", async () => {
    const res = await request(
      app(actions({ failTarget: async () => Promise.reject(new Error("x")) })),
    )
      .post("/actions/target-fail")
      .set(auth)
      .send({ seconds: 5 });
    expect(res.status).toBe(502);
  });

  it("needs a credential to start traffic", async () => {
    expect((await request(app()).post("/traffic/start").set(auth).send({})).status).toBe(400);
  });

  it("status still answers when the target is down", async () => {
    const server = app(actions({ targetStatus: async () => Promise.reject(new Error("down")) }));
    const res = await request(server).get("/status").set(auth);
    expect(res.status).toBe(200);
    expect((res.body as { target: unknown }).target).toBeNull();
  });
});

describe("classify, the number the panel exists for", () => {
  it.each([
    [["succeeded"], "delivered"],
    [["dead", "succeeded"], "delivered"],
    [["pending"], "retrying"],
    [["in_flight"], "retrying"],
    [["failed"], "retrying"],
    [["dead"], "dead"],
    [["cancelled"], "lost"],
    [[], "lost"],
  ])("%j is %s", (statuses, outcome) => {
    expect(classify(statuses)).toBe(outcome);
  });
});

describe("the demo worker's settings", () => {
  it("retries for longer than the target can be told to fail, so a 500 storm cannot make dead letters", () => {
    const total = DEMO_RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(60_000);
  });

  it("keeps the lease strictly above the request limit plus the worker's own margin", () => {
    const env = workerEnv({ DATABASE_URL: "x", MURPHY_ENCRYPTION_KEY: "y" }, "w");
    expect(DEMO_LEASE_MS).toBeGreaterThan(
      Number(env.WORKER_REQUEST_TIMEOUT_MS) + LEASE_SAFETY_MARGIN_MS,
    );
    expect(env.MURPHY_MODE).toBe("local");
  });
});

describe("refusing to start outside local mode", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const run = (script: string, extra: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      // An explicit value wins over .env, so a developer's .env cannot affect this.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        MURPHY_CONTROL_TOKEN: TOKEN,
        ...extra,
      },
    });

  it.each([
    ["src/main.ts", "the control service"],
    ["src/stack.ts", "demo:stack"],
  ])(
    "%s refuses hosted mode",
    (script, name) => {
      const res = run(script, {
        MURPHY_MODE: "hosted",
        DATABASE_URL: "postgresql://u:p@localhost/d",
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${name} only runs with MURPHY_MODE=local`);
    },
    40_000,
  );

  it.each([
    ["src/main.ts", "the control service"],
    ["src/stack.ts", "demo:stack"],
  ])(
    "%s refuses a remote database",
    (script, name) => {
      const res = run(script, {
        MURPHY_MODE: "local",
        DATABASE_URL: "postgresql://u:p@db.example.com/d",
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(`${name} only runs against localhost`);
    },
    40_000,
  );

  it("the control service refuses to start without a token", () => {
    const res = run("src/main.ts", {
      MURPHY_MODE: "local",
      DATABASE_URL: "postgresql://u:p@localhost/d",
      MURPHY_CONTROL_TOKEN: "",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("MURPHY_CONTROL_TOKEN");
  }, 40_000);
});
