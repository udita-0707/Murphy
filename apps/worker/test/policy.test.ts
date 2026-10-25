import { describe, expect, it } from "vitest";
import type { SendResult } from "../src/net/send.js";
import { CLIENT_ERROR_MAX_RETRIES, decideOutcome } from "../src/policy.js";

const mid = { random: () => 0.5 };
const fresh = { attemptCount: 0, clientErrorCount: 0 };
const http = (status: number, retryAfter: string | null = null): SendResult => ({
  ok: true,
  status,
  retryAfter,
  bodySnippet: "",
  durationMs: 5,
});
const failure = (
  kind: "timeout" | "network" | "ssrf_blocked" | "aborted",
  ssrfReason?: string,
): SendResult => ({ ok: false, kind, error: "x", durationMs: 5, ssrfReason }) as SendResult;

describe("decideOutcome", () => {
  it.each([200, 201, 204, 299])("marks %s succeeded", (status) => {
    expect(decideOutcome(http(status), fresh, mid)).toEqual({
      kind: "succeeded",
      attemptCount: 1,
      clientErrorCount: 0,
      lastStatusCode: status,
    });
  });

  it.each([500, 502, 503, 504, 408, 425, 429])("retries %s on the backoff schedule", (status) => {
    expect(decideOutcome(http(status), fresh, mid)).toMatchObject({
      kind: "retry",
      attemptCount: 1,
      delayMs: 5_000,
      lastStatusCode: status,
      lastError: `HTTP ${status}`,
    });
    expect(
      decideOutcome(http(status), { attemptCount: 3, clientErrorCount: 0 }, mid),
    ).toMatchObject({
      kind: "retry",
      attemptCount: 4,
      delayMs: 600_000,
    });
  });

  it("retries timeouts, network errors and DNS failures", () => {
    for (const result of [
      failure("timeout"),
      failure("network"),
      failure("ssrf_blocked", "dns_failed"),
    ]) {
      expect(decideOutcome(result, fresh, mid)).toMatchObject({
        kind: "retry",
        lastStatusCode: null,
      });
    }
  });

  it("honours Retry-After (capped at 6 hours)", () => {
    expect(decideOutcome(http(429, "120"), fresh, mid)).toMatchObject({
      kind: "retry",
      delayMs: 120_000,
    });
    expect(decideOutcome(http(503, String(7 * 24 * 3600)), fresh, mid)).toMatchObject({
      delayMs: 6 * 3600_000,
    });
  });

  it("goes dead after 1 initial attempt + 8 retries", () => {
    // The 8th attempt fails: one retry left, 6 h away.
    expect(decideOutcome(http(500), { attemptCount: 7, clientErrorCount: 0 }, mid)).toMatchObject({
      kind: "retry",
      attemptCount: 8,
      delayMs: 6 * 3600_000,
    });
    // The 9th attempt (8th retry) fails: dead.
    expect(decideOutcome(http(500), { attemptCount: 8, clientErrorCount: 0 }, mid)).toEqual({
      kind: "dead",
      attemptCount: 9,
      clientErrorCount: 0,
      lastStatusCode: 500,
      lastError: "HTTP 500",
      disableEndpoint: false,
    });
    expect(
      decideOutcome(failure("timeout"), { attemptCount: 8, clientErrorCount: 0 }, mid),
    ).toMatchObject({
      kind: "dead",
    });
  });

  it.each([400, 401, 403, 404])("retries %s at most twice since the last replay", (status) => {
    expect(CLIENT_ERROR_MAX_RETRIES).toBe(2);
    const first = decideOutcome(http(status), fresh, mid);
    expect(first).toMatchObject({ kind: "retry", attemptCount: 1, clientErrorCount: 1 });
    const second = decideOutcome(http(status), { attemptCount: 1, clientErrorCount: 1 }, mid);
    expect(second).toMatchObject({ kind: "retry", attemptCount: 2, clientErrorCount: 2 });
    const third = decideOutcome(http(status), { attemptCount: 2, clientErrorCount: 2 }, mid);
    expect(third).toMatchObject({
      kind: "dead",
      attemptCount: 3,
      clientErrorCount: 3,
      lastStatusCode: status,
    });
  });

  it("counts client errors separately from other failures", () => {
    // Two 500s then a 404: the 404 is only the first client error.
    expect(decideOutcome(http(404), { attemptCount: 2, clientErrorCount: 0 }, mid)).toMatchObject({
      kind: "retry",
      clientErrorCount: 1,
    });
  });

  it("410 kills the delivery and disables the endpoint", () => {
    expect(decideOutcome(http(410), fresh, mid)).toMatchObject({
      kind: "dead",
      lastStatusCode: 410,
      disableEndpoint: true,
    });
  });

  it.each([301, 302, 307, 308, 304, 405, 409, 413, 415, 422, 100])(
    "kills %s without retrying",
    (status) => {
      expect(decideOutcome(http(status), fresh, mid)).toMatchObject({
        kind: "dead",
        attemptCount: 1,
        disableEndpoint: false,
      });
    },
  );

  it("kills permanently blocked targets", () => {
    for (const reason of [
      "address_blocked",
      "scheme_not_allowed",
      "credentials_in_url",
      "invalid_url",
    ]) {
      expect(decideOutcome(failure("ssrf_blocked", reason), fresh, mid)).toMatchObject({
        kind: "dead",
      });
    }
  });

  it("does nothing when the attempt was aborted by shutdown", () => {
    expect(
      decideOutcome(failure("aborted"), { attemptCount: 3, clientErrorCount: 1 }, mid),
    ).toEqual({ kind: "none" });
  });
});
