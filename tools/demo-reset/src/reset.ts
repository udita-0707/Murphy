import { checkLocalOnly, type GuardResult } from "@murphy/core";

export type { GuardResult };

/** demo:reset destroys the database volume, so it uses the local-only guard. */
export function checkResetAllowed(env: NodeJS.ProcessEnv): GuardResult {
  return checkLocalOnly(env, "demo:reset");
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
