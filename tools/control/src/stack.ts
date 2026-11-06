import { checkLocalOnly } from "@murphy/core";
import { config as loadDotenv } from "dotenv";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `pnpm demo:stack`: the API, demo target, dashboard and control service together, with the control service owning the
 * workers so the panel can kill one. It needs Postgres up (`pnpm infra:up`) and refuses anywhere but local mode.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotenv({ path: path.join(root, ".env"), quiet: true });

const guard = checkLocalOnly(process.env, "demo:stack");
if (!guard.ok) {
  console.error(`demo:stack refused: ${guard.reason}. Nothing was started.`);
  process.exit(1);
}

const DASHBOARD_PORT = process.env.DASHBOARD_PORT ?? "3100";
const env: NodeJS.ProcessEnv = {
  ...process.env,
  // Random per start, and only ever in these processes' environments.
  MURPHY_CONTROL_TOKEN: randomBytes(32).toString("hex"),
  DASHBOARD_URL: process.env.DASHBOARD_URL ?? `http://127.0.0.1:${DASHBOARD_PORT}`,
};

const dashboard = path.join(root, "apps/dashboard");

console.log("[demo:stack] building the dashboard");
const built = spawnSync("pnpm", ["exec", "next", "build"], {
  cwd: dashboard,
  env: { ...env, NODE_ENV: "production" },
  stdio: "inherit",
});
if (built.status !== 0) {
  console.error("[demo:stack] the dashboard did not build. Nothing was started.");
  process.exit(built.status ?? 1);
}

const children: ChildProcess[] = [];
let stopping = false;

function start(
  name: string,
  cwd: string,
  command: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  const child = spawn(command, args, {
    cwd: path.join(root, cwd),
    env: { ...env, ...extra },
    stdio: "inherit",
    detached: true,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(
      `[demo:stack] ${name} exited (code ${code}, signal ${signal}). Stopping the stack.`,
    );
    stop(1);
  });
}

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  setTimeout(() => process.exit(code), 3_000).unref();
}

const tsx = [process.execPath, "--import", "tsx"] as const;
start("the API", "apps/api", tsx[0], [tsx[1], tsx[2], "src/server.ts"]);
start("the demo target", "tools/demo-target", tsx[0], [tsx[1], tsx[2], "src/main.ts"]);
start("the control service", "tools/control", tsx[0], [tsx[1], tsx[2], "src/main.ts"]);
start(
  "the dashboard",
  "apps/dashboard",
  "pnpm",
  ["exec", "next", "start", "-p", DASHBOARD_PORT, "-H", "127.0.0.1"],
  {
    NODE_ENV: "production",
  },
);

console.log(
  `[demo:stack] open http://127.0.0.1:${DASHBOARD_PORT}, and press Ctrl-C to stop everything`,
);

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
