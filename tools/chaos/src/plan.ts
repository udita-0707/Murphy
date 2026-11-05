import { createHash } from "node:crypto";
import type { ChaosPlan, PlanEndpoint, PlanEvent, PlanFault } from "./types.js";

/** A number in [0, 1) fixed by its inputs. */
export function hash01(...parts: (string | number)[]): number {
  const digest = createHash("sha256").update(parts.join("|")).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** Small seeded generator (mulberry32) for building the plan. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  return {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
  };
}

export const EVENT_TYPES = ["payment.captured", "refund.created", "kyc.verified"] as const;

/**
 * Same number of retries as production (8), compressed from over 10 hours to about 20 seconds.
 */
export const COMPRESSED_RETRY_SCHEDULE_MS = [200, 500, 1000, 1500, 2000, 3000, 4000, 5000];

const ENDPOINTS: PlanEndpoint[] = [
  { key: "a-control", projectKey: "project-a", profile: "control", filter: [] },
  {
    key: "a-flaky",
    projectKey: "project-a",
    profile: "flaky",
    filter: ["payment.captured", "refund.created"],
  },
  { key: "a-slow", projectKey: "project-a", profile: "slow", filter: [] },
  { key: "b-lost-ack", projectKey: "project-b", profile: "lost_ack", filter: [] },
  // One event type only: each of these takes 9 attempts, which would dominate the run otherwise.
  { key: "b-always-500", projectKey: "project-b", profile: "always_500", filter: ["kyc.verified"] },
  { key: "b-gone", projectKey: "project-b", profile: "gone", filter: [] },
  { key: "c-toggled", projectKey: "project-c", profile: "toggled", filter: [] },
  { key: "c-parked", projectKey: "project-c", profile: "parked", filter: [] },
  { key: "c-deleted", projectKey: "project-c", profile: "deleted", filter: [] },
];

export interface PlanOptions {
  seed: number;
  events?: number;
  rate?: number;
  workers?: number;
}

/** The whole run as data: the same seed and options always give the same plan. */
export function makePlan(options: PlanOptions): ChaosPlan {
  const { seed, events: eventCount = 3000, rate = 50, workers = 3 } = options;
  const rng = generator(seed);
  const loadMs = Math.round((eventCount / rate) * 1000);
  const projects = ["project-a", "project-b", "project-c"];

  const events: PlanEvent[] = [];
  for (let seq = 0; seq < eventCount; seq++) {
    const roll = rng.next();
    const projectKey = roll < 0.4 ? projects[0]! : roll < 0.75 ? projects[1]! : projects[2]!;
    events.push({
      seq,
      idempotencyKey: `chaos-${seed}-${seq}`,
      logicalId: `lg_${seed}_${seq}`,
      projectKey,
      type: EVENT_TYPES[rng.int(0, EVENT_TYPES.length - 1)]!,
      amount: rng.int(100, 500_000),
      atMs: Math.round((seq / eventCount) * loadMs),
      resend: rng.next() < 0.05,
    });
  }

  const at = (from: number, to: number) => Math.round(rng.between(from, to) * loadMs);
  const faults: PlanFault[] = [];
  const kills = rng.int(3, 5);
  for (let i = 0; i < kills; i++) {
    faults.push({
      atMs: at(0.1, 0.9),
      action: "kill_worker",
      worker: rng.int(0, workers - 1),
      respawnMs: rng.int(500, 3000),
    });
  }
  faults.push({ atMs: at(0.15, 0.45), action: "kill_api", respawnMs: rng.int(300, 1500) });
  faults.push({ atMs: at(0.55, 0.85), action: "kill_api", respawnMs: rng.int(300, 1500) });
  faults.push({ atMs: at(0.2, 0.4), action: "restart_postgres" });
  faults.push({ atMs: at(0.6, 0.8), action: "restart_postgres" });
  faults.push({ atMs: at(0.3, 0.4), action: "disable_endpoint", endpoint: "c-toggled" });
  faults.push({ atMs: at(0.55, 0.65), action: "enable_endpoint", endpoint: "c-toggled" });
  faults.push({ atMs: at(0.45, 0.6), action: "disable_endpoint", endpoint: "c-parked" });
  faults.push({ atMs: at(0.5, 0.7), action: "delete_endpoint", endpoint: "c-deleted" });
  faults.sort((a, b) => a.atMs - b.atMs);

  return {
    seed,
    workers,
    loadMs,
    retryScheduleMs: COMPRESSED_RETRY_SCHEDULE_MS,
    requestTimeoutMs: 2000,
    // The worker's own safety check requires more than the request timeout plus 15 s.
    leaseMs: 18_000,
    goneAfter: Math.max(5, Math.floor(eventCount * 0.05)),
    projects,
    endpoints: ENDPOINTS,
    events,
    faults,
  };
}

export function planHash(plan: ChaosPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16);
}
