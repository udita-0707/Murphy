import { parseMode } from "@murphy/core";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * demo:reset destroys the database volume, so it only runs when both are true:
 * MURPHY_MODE is explicitly "local" (unset means hosted, the default) and DATABASE_URL points
 * at this machine.
 */
export function checkResetAllowed(env: NodeJS.ProcessEnv): GuardResult {
  let mode;
  try {
    mode = parseMode(env.MURPHY_MODE);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (mode !== "local") {
    return {
      ok: false,
      reason: `MURPHY_MODE is "${env.MURPHY_MODE || "hosted (unset)"}"; demo:reset only runs with MURPHY_MODE=local`,
    };
  }
  if (!env.DATABASE_URL) return { ok: false, reason: "DATABASE_URL is not set" };
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    return { ok: false, reason: "DATABASE_URL is not a valid URL" };
  }
  if (!LOCAL_HOSTS.has(host)) {
    return {
      ok: false,
      reason: `DATABASE_URL points to "${host}"; demo:reset only runs against localhost`,
    };
  }
  return { ok: true };
}

export interface Step {
  label: string;
  command: string;
  args: string[];
}

const COMPOSE = ["compose", "--env-file", ".env", "-f", "infra/docker-compose.yml"];

/** The reset, run from the repo root: wipe the volume, start infra, migrate, seed. */
export const RESET_STEPS: readonly Step[] = [
  {
    label: "Stop infra and delete its volumes",
    command: "docker",
    args: [...COMPOSE, "down", "-v"],
  },
  {
    label: "Start Postgres and Redis",
    command: "docker",
    args: [...COMPOSE, "up", "-d", "--wait"],
  },
  { label: "Apply migrations", command: "pnpm", args: ["db:migrate"] },
  { label: "Seed a fresh project", command: "pnpm", args: ["db:seed"] },
];

export type Runner = (step: Step) => number;

/** Checks the guard, then runs every step in order, stopping at the first failure. */
export function resetDemo(
  env: NodeJS.ProcessEnv,
  run: Runner,
  log: (line: string) => void,
): number {
  const guard = checkResetAllowed(env);
  if (!guard.ok) {
    log(`demo:reset refused: ${guard.reason}. Nothing was changed.`);
    return 1;
  }
  for (const step of RESET_STEPS) {
    log(`demo:reset: ${step.label}: ${step.command} ${step.args.join(" ")}`);
    const status = run(step);
    if (status !== 0) {
      log(`demo:reset: "${step.label}" failed with exit code ${status}; stopping.`);
      return status;
    }
  }
  log("demo:reset: done. The database is fresh; use the API key printed above.");
  return 0;
}
