const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Delay before each retry, indexed by the number of the attempt that just failed (1-based). */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  5 * SECOND,
  30 * SECOND,
  2 * MINUTE,
  10 * MINUTE,
  30 * MINUTE,
  1 * HOUR,
  3 * HOUR,
  6 * HOUR,
];

/** Each scheduled delay is scaled by a random factor in [1 - JITTER, 1 + JITTER]. */
export const RETRY_JITTER = 0.2;

/** Retry-After values from receivers are honoured but never beyond this. */
export const MAX_RETRY_AFTER_MS = 6 * HOUR;

export interface NextRetryOptions {
  /**
   * The receiver's Retry-After header: delay in seconds, or an HTTP date. Invalid values are
   * ignored and the schedule is used.
   */
  retryAfter?: number | string | null;
  /** Random source in [0, 1); injectable for determinism. Defaults to Math.random. */
  random?: () => number;
  /** Current time in ms, used to resolve an HTTP-date Retry-After. Defaults to Date.now(). */
  now?: number;
  schedule?: readonly number[];
}

/**
 * Milliseconds to wait before the next attempt, after attempt number `attempt` (1-based) has
 * failed, or null when attempts are exhausted. With the default schedule that is one initial
 * attempt plus eight retries.
 */
export function nextRetryDelay(attempt: number, options: NextRetryOptions = {}): number | null {
  const schedule = options.schedule ?? RETRY_SCHEDULE_MS;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  const base = schedule[attempt - 1];
  if (base === undefined) return null;

  const retryAfterMs = parseRetryAfter(options.retryAfter, options.now ?? Date.now());
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }

  const random = options.random ?? Math.random;
  const factor = 1 + (random() * 2 - 1) * RETRY_JITTER;
  return Math.round(base * factor);
}

/** Parses a Retry-After value into milliseconds (never negative), or null if invalid. */
export function parseRetryAfter(
  value: number | string | null | undefined,
  now: number,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * SECOND) : null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * SECOND;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Whether a failed delivery should be retried (brief 3.5). `null` means no HTTP response:
 * a timeout or network error.
 */
export function isRetryable(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return true;
  if (status >= 500 && status <= 599) return true;
  return status === 408 || status === 425 || status === 429;
}
