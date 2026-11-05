import { hash01 } from "./plan.js";
import type { Profile, ReceiverAction } from "./types.js";

/** Longer than the worker's request timeout, so the worker gives up first. */
export const HANG_MS = 3000;

export interface Decision {
  action: ReceiverAction;
  delayMs: number;
}

/** Whether the handler's side effect runs for this action. */
export function isProcessed(action: ReceiverAction): boolean {
  return (
    action === "ok" ||
    action === "slow" ||
    action === "hang" ||
    action === "process_then_500" ||
    action === "process_then_reset"
  );
}

/** Whether the worker can have heard a 2xx for this action. */
export function isClean2xx(action: ReceiverAction): boolean {
  return action === "ok" || action === "slow";
}

/**
 * What the receiver does with one arrival. Pure: it depends on the seed and the message, never on
 * timing, so the same seed makes the same decisions in any interleaving. `goneReached` says the
 * gone endpoint has passed its message limit and this message is new to it.
 */
export function decide(input: {
  seed: number;
  endpoint: string;
  profile: Profile;
  webhookId: string;
  arrival: number;
  goneReached: boolean;
}): Decision {
  const { seed, endpoint, profile, webhookId, arrival, goneReached } = input;
  const roll = hash01(seed, endpoint, webhookId, arrival);
  const second = hash01(seed, endpoint, webhookId, arrival, "delay");
  switch (profile) {
    case "control":
    case "toggled":
    case "parked":
    case "deleted":
      return { action: "ok", delayMs: 0 };
    case "flaky":
      return { action: roll < 0.3 ? "fail_500" : "ok", delayMs: 0 };
    case "slow":
      if (roll < 0.15) return { action: "hang", delayMs: HANG_MS };
      if (roll < 0.55) return { action: "slow", delayMs: Math.round(300 + second * 900) };
      return { action: "ok", delayMs: 0 };
    case "lost_ack":
      if (roll < 0.25) return { action: "process_then_500", delayMs: 0 };
      if (roll < 0.35) return { action: "process_then_reset", delayMs: 0 };
      return { action: "ok", delayMs: 0 };
    case "always_500":
      return { action: "fail_500", delayMs: 0 };
    case "gone":
      return { action: goneReached ? "gone_410" : "ok", delayMs: 0 };
  }
}
