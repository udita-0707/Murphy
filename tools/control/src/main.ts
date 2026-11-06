import { Processes } from "@murphy/chaos/procs";
import { checkLocalOnly } from "@murphy/core";
import { config as loadDotenv } from "dotenv";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createControlApp, type ControlActions } from "./control.js";
import { workerEnv, WORKER_COUNT } from "./worker-env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: path.join(root, ".env"), quiet: true });

// The first thing it does. Everything below can break processes, so it must never run anywhere else.
const guard = checkLocalOnly(process.env, "the control service");
if (!guard.ok) {
  console.error(`control service refused: ${guard.reason}. Nothing was started.`);
  process.exit(1);
}
const token = process.env.MURPHY_CONTROL_TOKEN;
if (!token || token.length < 32) {
  console.error(
    "control service refused: MURPHY_CONTROL_TOKEN must be set. Use `pnpm demo:stack`.",
  );
  process.exit(1);
}

const port = Number(process.env.MURPHY_CONTROL_PORT ?? 4545);
const apiUrl = process.env.MURPHY_API_URL ?? "http://127.0.0.1:3000";
const targetUrl = (process.env.MURPHY_TARGET_URL ?? "http://127.0.0.1:4343").replace(/\/$/, "");
const composeProject = process.env.MURPHY_COMPOSE_PROJECT ?? "murphy";
if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProject)) {
  console.error("control service refused: MURPHY_COMPOSE_PROJECT is not a valid project name.");
  process.exit(1);
}

const logDir = path.join(root, ".chaos/control");
mkdirSync(logDir, { recursive: true });
const processes = new Processes(logDir);

type Managed = ReturnType<Processes["start"]>;
interface Slot {
  name: string;
  managed: Managed | null;
  generation: number;
  /** Set when the process exited without being asked to. It is not restarted: that would hide a bug. */
  crashed: boolean;
}

const slots: Slot[] = Array.from({ length: WORKER_COUNT }, (_, i) => ({
  name: `worker-${i + 1}`,
  managed: null,
  generation: 0,
  crashed: false,
}));

function startWorker(slot: Slot): void {
  slot.generation += 1;
  const managed = processes.start({
    name: `${slot.name}-${slot.generation}`,
    cwd: "apps/worker",
    script: "src/main.ts",
    env: workerEnv(process.env, slot.name),
  });
  slot.managed = managed;
  slot.crashed = false;
  void managed.exited.then(() => {
    // Still the current process, so nobody asked it to stop.
    if (slot.managed !== managed) return;
    slot.managed = null;
    slot.crashed = true;
    console.error(`[control] ${slot.name} exited on its own. See .chaos/control/ for its log.`);
  });
}

const run = promisify(execFile);

const actions: ControlActions = {
  workers: () =>
    slots.map((slot) => ({
      name: slot.name,
      state: slot.managed ? "running" : slot.crashed ? "crashed" : "restarting",
      pid: slot.managed?.child.pid ?? null,
    })),

  killWorker: async () => {
    const slot = slots.find((s) => s.managed !== null);
    if (!slot?.managed) return null;
    const victim = slot.managed;
    slot.managed = null;
    await processes.kill(victim);
    setTimeout(() => startWorker(slot), 3_000);
    return { killed: slot.name };
  },

  // Fixed arguments and no shell: nothing from a request can reach this command.
  restartPostgres: async () => {
    await run(
      "docker",
      [
        "compose",
        "-p",
        composeProject,
        "--env-file",
        ".env",
        "-f",
        "infra/docker-compose.yml",
        "restart",
        "--timeout",
        "0",
        "postgres",
      ],
      { cwd: root, timeout: 60_000 },
    );
  },

  failTarget: async (seconds) => {
    const res = await fetch(`${targetUrl}/_chaos/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seconds }),
    });
    if (!res.ok) throw new Error(`the demo target answered ${res.status}`);
  },

  targetStatus: async () => {
    const res = await fetch(`${targetUrl}/_chaos/status`);
    return res.ok
      ? ((await res.json()) as { failing: boolean; fail_until: string | null; received: number })
      : null;
  },
};

for (const slot of slots) startWorker(slot);

const app = createControlApp({
  token,
  port,
  apiUrl,
  sinkUrl: `${targetUrl}/_chaos/sink`,
  actions,
});

// Loopback only, whatever else is configured.
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`[control] http://127.0.0.1:${port}, ${WORKER_COUNT} workers, local mode`);
});

function shutdown(): void {
  app.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
