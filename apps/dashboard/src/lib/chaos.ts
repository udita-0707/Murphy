export interface TrafficStatus {
  state: "idle" | "running" | "draining";
  accepted: number;
  delivered: number;
  retrying: number;
  dead: number;
  lost: number;
  refused: number;
  last_checked_at: string | null;
  check_failing: boolean;
}

export interface ChaosStatus {
  workers: { name: string; state: "running" | "restarting" | "crashed"; pid: number | null }[];
  target: { failing: boolean; fail_until: string | null; received: number } | null;
  traffic: TrafficStatus | null;
  postgres_restarting: boolean;
  log: { at: string; action: string; outcome: string; detail: string | null }[];
}

export function workerLine(worker: ChaosStatus["workers"][number]): string {
  switch (worker.state) {
    case "running":
      return `${worker.name}: running, pid ${worker.pid}`;
    case "restarting":
      return `${worker.name}: killed, restarting`;
    case "crashed":
      return `${worker.name}: crashed on its own, not restarted`;
  }
}

export type Proof = { tone: "plain" | "good" | "bad" | "wait"; text: string };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function refusedLine(refused: number): string {
  return `The API refused ${refused} ${plural(refused, "send", "sends")} while it was away. ${plural(refused, "That was", "Those were")} never accepted, and retried with the same idempotency key.`;
}

/** The sentence under the counters. It claims only what the counts can back up. */
export function proofLine(traffic: TrafficStatus | null): Proof {
  if (!traffic || traffic.accepted === 0) {
    return {
      tone: "plain",
      text: "Nothing accepted yet. Start the traffic, then break something.",
    };
  }
  if (traffic.lost > 0) {
    return {
      tone: "bad",
      text: `${traffic.lost} accepted events have no delivery left. That is a real loss.`,
    };
  }
  if (traffic.check_failing) {
    return {
      tone: "wait",
      text: "The API is away, so these counts may be behind. Nothing is being assumed.",
    };
  }
  if (traffic.state === "running") {
    return { tone: "wait", text: `None lost so far, with ${traffic.retrying} still on their way.` };
  }
  if (traffic.retrying > 0) {
    return { tone: "wait", text: `Traffic stopped. Waiting on the last ${traffic.retrying}.` };
  }
  if (traffic.dead > 0) {
    return {
      tone: "plain",
      text: `None lost: ${traffic.delivered} delivered, and ${traffic.dead} in dead letters to replay.`,
    };
  }
  return { tone: "good", text: `All ${traffic.accepted} accepted events delivered. None lost.` };
}

/** How long a delivery may stay in flight before it is worth explaining. A request is limited to 5 s. */
const STUCK_MS = 6_000;

/** A delivery whose worker was killed looks frozen until its lease expires, so the panel says why. */
export function deliveryNote(
  status: string,
  firstSeenMs: number | undefined,
  nowMs: number,
): string | null {
  if (status !== "in_flight" || firstSeenMs === undefined) return null;
  return nowMs - firstSeenMs > STUCK_MS ? "waiting for the lease to expire" : null;
}

export const MAX_FAIL_SECONDS = 60;

/** The value from the seconds box, or null if it cannot be sent. */
export function parseSeconds(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_FAIL_SECONDS ? value : null;
}
