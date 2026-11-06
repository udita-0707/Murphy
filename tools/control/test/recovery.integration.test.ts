import { Processes } from "@murphy/chaos/procs";
import { MurphyApiClient } from "@murphy/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "../../../packages/cli/test/stack.js";
import { createControlApp, type ControlActions } from "../src/control.js";
import { workerEnv } from "../src/worker-env.js";

const TOKEN = "t".repeat(64);
const PORT = 4545;
const auth = { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}` };

let stack: Stack;
let processes: Processes;
const workers: { name: string; managed: ReturnType<Processes["start"]> | null }[] = [];

beforeAll(async () => {
  // No worker of its own: the two below, with the panel's real settings, must do all the work.
  stack = await startStack({}, { worker: false });
  processes = new Processes(mkdtempSync(path.join(tmpdir(), "murphy-control-")));
}, 300_000);

afterAll(async () => {
  for (const w of workers) if (w.managed) await processes.kill(w.managed);
  await stack?.stop();
}, 60_000);

interface Status {
  traffic: {
    state: string;
    accepted: number;
    delivered: number;
    retrying: number;
    dead: number;
    lost: number;
  };
  target: { received: number };
}

describe("real traffic through real faults", () => {
  it("kills a worker and fails the target, and every accepted event is accounted for", async () => {
    const startWorker = (name: string, databaseUrl: string, key: string) =>
      processes.start({
        name,
        cwd: "apps/worker",
        script: "src/main.ts",
        env: workerEnv({ DATABASE_URL: databaseUrl, MURPHY_ENCRYPTION_KEY: key }, name),
      });
    for (const name of ["worker-a", "worker-b"]) {
      workers.push({ name, managed: startWorker(name, stack.databaseUrl, stack.encryptionKey) });
    }

    const actions: ControlActions = {
      workers: () =>
        workers.map((w) => ({
          name: w.name,
          state: w.managed ? "running" : "restarting",
          pid: w.managed?.child.pid ?? null,
        })),
      killWorker: async () => {
        const w = workers.find((x) => x.managed);
        if (!w?.managed) return null;
        await processes.kill(w.managed);
        w.managed = null;
        return { killed: w.name };
      },
      restartPostgres: async () => undefined,
      failTarget: async (seconds) => {
        const res = await fetch(`${stack.targetUrl}/_chaos/fail`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seconds }),
        });
        if (!res.ok) throw new Error(`target answered ${res.status}`);
      },
      targetStatus: async () =>
        (await (await fetch(`${stack.targetUrl}/_chaos/status`)).json()) as {
          failing: boolean;
          fail_until: string | null;
          received: number;
        },
    };

    const app = createControlApp({
      token: TOKEN,
      port: PORT,
      apiUrl: stack.apiUrl,
      sinkUrl: `${stack.targetUrl}/_chaos/sink`,
      actions,
      trafficIntervalMs: 100,
    });
    const status = async () => (await request(app).get("/status").set(auth)).body as Status;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      expect(
        (await request(app).post("/traffic/start").set(auth).send({ token: stack.apiKey })).status,
      ).toBe(202);
      await sleep(1_000);
      expect((await request(app).post("/actions/kill-worker").set(auth)).status).toBe(200);
      await sleep(500);
      expect(
        (await request(app).post("/actions/target-fail").set(auth).send({ seconds: 3 })).status,
      ).toBe(200);
      await sleep(4_000);
      await request(app).post("/traffic/stop").set(auth);

      const deadline = Date.now() + 60_000;
      let final = await status();
      while (final.traffic.state !== "idle" && Date.now() < deadline) {
        await sleep(500);
        final = await status();
      }

      // Nothing crashed by itself. A worker that dies on start must fail this test.
      expect(processes.unexpectedExits).toEqual([]);
      expect(final.traffic.state).toBe("idle");
      expect(final.traffic.accepted).toBeGreaterThan(10);
      expect(final.traffic.lost).toBe(0);
      expect(final.traffic.dead).toBe(0);
      expect(final.traffic.retrying).toBe(0);
      expect(final.traffic.delivered).toBe(final.traffic.accepted);
      // A second opinion, from the receiving side: every accepted event really arrived.
      expect(final.target.received).toBe(final.traffic.accepted);

      // The failure really happened: some delivery took more than one attempt.
      const api = new MurphyApiClient({ apiUrl: stack.apiUrl, token: stack.apiKey });
      const page = await api.request<{ data: { attempt_count: number }[] }>(
        "GET",
        "/v1/deliveries?limit=100",
      );
      expect(page.data.some((d) => d.attempt_count > 1)).toBe(true);
    } finally {
      app.dispose();
    }
  }, 120_000);
});
