import { hostname } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseEncryptionKey, parseMode } from "@murphy/core";
import { config as loadDotenv } from "dotenv";
import type { MurphyMode } from "@murphy/core";

/** The lease must outlast a request by at least this much, or a slow but healthy request
 * could be reaped and sent twice. */
export const LEASE_SAFETY_MARGIN_MS = 15_000;

export interface WorkerConfig {
  databaseUrl: string;
  encryptionKey: Buffer;
  /** hosted (default): https and public addresses only. local: also http, loopback, LAN. */
  mode: MurphyMode;
  workerId: string;
  /** Maximum deliveries claimed per poll. */
  batchSize: number;
  /** Maximum deliveries one project may contribute to a single claim. */
  projectCap: number;
  /** Maximum deliveries executing at once in this process. */
  concurrency: number;
  /** Sleep between polls when there is no work. */
  pollMs: number;
  leaseMs: number;
  requestTimeoutMs: number;
  /** How often this worker looks for expired leases. */
  reapIntervalMs: number;
  /** How long graceful shutdown waits for in-flight deliveries before releasing them. */
  shutdownTimeoutMs: number;
}

/** Loads the repo-root .env (if present) without overriding variables already set. */
export function loadEnvFile(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  loadDotenv({ path: path.join(root, ".env"), quiet: true });
}

export function makeWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see .env.example)");
  }
  const config: WorkerConfig = {
    databaseUrl: env.DATABASE_URL,
    encryptionKey: parseEncryptionKey(env.MURPHY_ENCRYPTION_KEY),
    mode: parseMode(env.MURPHY_MODE),
    workerId: env.WORKER_ID || makeWorkerId(),
    batchSize: intFromEnv(env, "WORKER_BATCH_SIZE", 50, 1),
    projectCap: intFromEnv(env, "WORKER_PROJECT_CAP", 10, 1),
    concurrency: intFromEnv(env, "WORKER_CONCURRENCY", 20, 1),
    pollMs: intFromEnv(env, "WORKER_POLL_MS", 500, 10),
    leaseMs: intFromEnv(env, "WORKER_LEASE_MS", 60_000, 1_000),
    requestTimeoutMs: intFromEnv(env, "WORKER_REQUEST_TIMEOUT_MS", 10_000, 100),
    shutdownTimeoutMs: intFromEnv(env, "WORKER_SHUTDOWN_TIMEOUT_MS", 15_000, 0),
    reapIntervalMs: intFromEnv(env, "WORKER_REAP_INTERVAL_MS", 10_000, 100),
  };
  assertLeaseOutlastsRequest(config);
  return config;
}

/** Fails fast when a lease could expire while its request is still legitimately running. */
export function assertLeaseOutlastsRequest(
  config: Pick<WorkerConfig, "leaseMs" | "requestTimeoutMs">,
): void {
  const minimum = config.requestTimeoutMs + LEASE_SAFETY_MARGIN_MS;
  if (config.leaseMs <= minimum) {
    throw new Error(
      `WORKER_LEASE_MS (${config.leaseMs}) must be greater than WORKER_REQUEST_TIMEOUT_MS ` +
        `(${config.requestTimeoutMs}) + ${LEASE_SAFETY_MARGIN_MS} ms safety margin = ${minimum} ms`,
    );
  }
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}
