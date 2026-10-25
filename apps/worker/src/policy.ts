import { isRetryable, nextRetryDelay } from "@murphy/core";
import type { AttemptOutcome } from "@murphy/db";
import type { SendResult } from "./net/send.js";

/** 400, 401, 403 and 404 are usually configuration errors: retried at most this many times
 * since the last replay, then dead. */
export const CLIENT_ERROR_MAX_RETRIES = 2;
const CLIENT_ERRORS = new Set([400, 401, 403, 404]);

/** DNS problems may be transient; every other SSRF rejection is permanent. */
const TRANSIENT_SSRF = new Set(["dns_failed", "no_addresses"]);

export interface Counters {
  /** Real attempts since the last replay, before this one. */
  attemptCount: number;
  clientErrorCount: number;
}

/**
 * Decides what happens to a delivery after one attempt (brief 3.5, ADR 006):
 *
 * - 2xx: succeeded.
 * - timeout, network error, DNS failure, 5xx, 408, 425, 429: retry on the backoff schedule
 *   (Retry-After honoured, capped at 6 h); dead when the schedule is exhausted.
 * - 400, 401, 403, 404: retried at most twice since the last replay, then dead.
 * - 410: dead, and the endpoint is disabled so its other deliveries park.
 * - any other status (3xx, other 4xx, 1xx) and blocked targets: dead.
 * - aborted by shutdown: no change (the lease is released, not counted).
 */
export function decideOutcome(
  result: SendResult,
  counters: Counters,
  options: { random?: () => number } = {},
): AttemptOutcome {
  if (!result.ok && result.kind === "aborted") return { kind: "none" };

  const attemptCount = counters.attemptCount + 1;
  let clientErrorCount = counters.clientErrorCount;
  const status = result.ok ? result.status : null;
  const lastError = result.ok
    ? status! >= 300
      ? `HTTP ${status}`
      : null
    : `${result.kind}: ${result.error}`;
  const dead = (disableEndpoint = false): AttemptOutcome => ({
    kind: "dead",
    attemptCount,
    clientErrorCount,
    lastStatusCode: status,
    lastError,
    disableEndpoint,
  });
  const retry = (retryAfter?: string | null): AttemptOutcome => {
    const delayMs = nextRetryDelay(attemptCount, { retryAfter, random: options.random });
    if (delayMs === null) return dead();
    return {
      kind: "retry",
      attemptCount,
      clientErrorCount,
      delayMs,
      lastStatusCode: status,
      lastError,
    };
  };

  if (!result.ok) {
    if (result.kind === "ssrf_blocked" && !TRANSIENT_SSRF.has(result.ssrfReason ?? ""))
      return dead();
    return retry();
  }
  if (result.status >= 200 && result.status < 300) {
    return { kind: "succeeded", attemptCount, clientErrorCount, lastStatusCode: result.status };
  }
  if (result.status === 410) return dead(true);
  if (CLIENT_ERRORS.has(result.status)) {
    clientErrorCount += 1;
    return clientErrorCount <= CLIENT_ERROR_MAX_RETRIES ? retry() : dead();
  }
  if (isRetryable(result.status)) return retry(result.retryAfter);
  return dead();
}
