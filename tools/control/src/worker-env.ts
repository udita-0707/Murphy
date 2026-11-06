export const WORKER_COUNT = 2;

/**
 * Shortened retries, so a recovery fits on a stage. Allowed in local mode only (ADR 010), and the panel says so on
 * screen. They add up to about 71 s, longer than the longest the target can be told to fail.
 */
export const DEMO_RETRY_SCHEDULE_MS = [1_000, 2_000, 3_000, 5_000, 5_000, 10_000, 15_000, 30_000];

/** The worker wants the lease strictly above the 5 s request limit plus its 15 s safety margin. */
export const DEMO_LEASE_MS = 21_000;

export function workerEnv(env: NodeJS.ProcessEnv, name: string): Record<string, string> {
  return {
    DATABASE_URL: env.DATABASE_URL ?? "",
    MURPHY_ENCRYPTION_KEY: env.MURPHY_ENCRYPTION_KEY ?? "",
    MURPHY_MODE: "local",
    WORKER_ID: name,
    WORKER_POLL_MS: "200",
    WORKER_LEASE_MS: String(DEMO_LEASE_MS),
    WORKER_REQUEST_TIMEOUT_MS: "5000",
    WORKER_REAP_INTERVAL_MS: "1000",
    WORKER_SHUTDOWN_TIMEOUT_MS: "3000",
    WORKER_RETRY_SCHEDULE_MS: DEMO_RETRY_SCHEDULE_MS.join(","),
  };
}
