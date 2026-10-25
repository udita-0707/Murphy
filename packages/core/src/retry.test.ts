import { describe, expect, it } from "vitest";
import {
  isRetryable,
  MAX_RETRY_AFTER_MS,
  nextRetryDelay,
  parseRetryAfter,
  RETRY_SCHEDULE_MS,
} from "./retry.js";

const HOUR = 3_600_000;
const mid = () => 0.5; // factor exactly 1.0

describe("nextRetryDelay", () => {
  it("follows the 5s, 30s, 2m, 10m, 30m, 1h, 3h, 6h schedule", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => nextRetryDelay(n, { random: mid }));
    expect(delays).toEqual([5_000, 30_000, 120_000, 600_000, 1_800_000, HOUR, 3 * HOUR, 6 * HOUR]);
    expect(RETRY_SCHEDULE_MS).toHaveLength(8);
  });

  it("returns null once attempts are exhausted", () => {
    expect(nextRetryDelay(9, { random: mid })).toBeNull();
    expect(nextRetryDelay(100)).toBeNull();
  });

  it("applies +/-20% jitter at the extremes of the random source", () => {
    expect(nextRetryDelay(1, { random: () => 0 })).toBe(4_000);
    expect(nextRetryDelay(1, { random: () => 0.999999 })).toBe(6_000);
  });

  it("is deterministic with an injected RNG", () => {
    const rng = () => 0.25;
    expect(nextRetryDelay(3, { random: rng })).toBe(nextRetryDelay(3, { random: rng }));
    expect(nextRetryDelay(3, { random: rng })).toBe(108_000);
  });

  it("honours Retry-After in seconds without jitter", () => {
    expect(nextRetryDelay(1, { retryAfter: 120, random: () => 0 })).toBe(120_000);
    expect(nextRetryDelay(1, { retryAfter: "7" })).toBe(7_000);
  });

  it("honours an HTTP-date Retry-After", () => {
    const now = Date.parse("2026-11-12T10:00:00Z");
    expect(nextRetryDelay(1, { retryAfter: "Thu, 12 Nov 2026 10:01:00 GMT", now })).toBe(60_000);
    expect(nextRetryDelay(1, { retryAfter: "Thu, 12 Nov 2026 09:00:00 GMT", now })).toBe(0);
  });

  it("caps Retry-After at 6 hours", () => {
    expect(nextRetryDelay(1, { retryAfter: 7 * 24 * 3600 })).toBe(MAX_RETRY_AFTER_MS);
    expect(MAX_RETRY_AFTER_MS).toBe(6 * HOUR);
  });

  it("ignores invalid Retry-After values and falls back to the schedule", () => {
    expect(nextRetryDelay(2, { retryAfter: "soon", random: mid })).toBe(30_000);
    expect(nextRetryDelay(2, { retryAfter: -5, random: mid })).toBe(30_000);
    expect(nextRetryDelay(2, { retryAfter: Number.NaN, random: mid })).toBe(30_000);
  });

  it("still returns null when exhausted even with Retry-After", () => {
    expect(nextRetryDelay(9, { retryAfter: 10 })).toBeNull();
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => nextRetryDelay(0)).toThrow(RangeError);
    expect(() => nextRetryDelay(1.5)).toThrow(RangeError);
  });

  it("supports a custom schedule", () => {
    expect(nextRetryDelay(1, { schedule: [1000], random: mid })).toBe(1000);
    expect(nextRetryDelay(2, { schedule: [1000] })).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("returns null for absent values", () => {
    expect(parseRetryAfter(undefined, 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe("isRetryable", () => {
  it.each([null, undefined, 500, 502, 503, 504, 599, 408, 425, 429])("retries %s", (status) => {
    expect(isRetryable(status)).toBe(true);
  });

  it.each([200, 204, 301, 400, 401, 403, 404, 409, 410, 422])("does not retry %s", (status) => {
    expect(isRetryable(status)).toBe(false);
  });
});
