import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LEASE_SAFETY_MARGIN_MS, loadWorkerConfig, makeWorkerId } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://x@localhost/db",
  MURPHY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

describe("worker config", () => {
  it("has sensible defaults: 60s lease, 10s request timeout", () => {
    const config = loadWorkerConfig(base);
    expect(config).toMatchObject({ leaseMs: 60_000, requestTimeoutMs: 10_000, batchSize: 50 });
    expect(config.workerId).toMatch(/^.+:\d+:[0-9a-f]{8}$/);
  });

  it("reads overrides from the environment", () => {
    const config = loadWorkerConfig({
      ...base,
      WORKER_BATCH_SIZE: "5",
      WORKER_PROJECT_CAP: "2",
      WORKER_CONCURRENCY: "3",
      WORKER_POLL_MS: "100",
    });
    expect(config).toMatchObject({ batchSize: 5, projectCap: 2, concurrency: 3, pollMs: 100 });
  });

  it("fails fast when the lease does not outlast the request timeout plus a margin", () => {
    expect(() =>
      loadWorkerConfig({ ...base, WORKER_LEASE_MS: "20000", WORKER_REQUEST_TIMEOUT_MS: "10000" }),
    ).toThrow(/WORKER_LEASE_MS \(20000\) must be greater than .* = 25000 ms/);
    expect(() =>
      loadWorkerConfig({
        ...base,
        WORKER_LEASE_MS: String(10_000 + LEASE_SAFETY_MARGIN_MS),
        WORKER_REQUEST_TIMEOUT_MS: "10000",
      }),
    ).toThrow();
    expect(
      loadWorkerConfig({ ...base, WORKER_LEASE_MS: "25001", WORKER_REQUEST_TIMEOUT_MS: "10000" })
        .leaseMs,
    ).toBe(25_001);
  });

  it("rejects invalid numbers and missing settings", () => {
    expect(() => loadWorkerConfig({ ...base, WORKER_BATCH_SIZE: "0" })).toThrow(
      /WORKER_BATCH_SIZE/,
    );
    expect(() => loadWorkerConfig({ ...base, WORKER_POLL_MS: "abc" })).toThrow(/WORKER_POLL_MS/);
    expect(() => loadWorkerConfig({ MURPHY_ENCRYPTION_KEY: base.MURPHY_ENCRYPTION_KEY })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("defaults MURPHY_MODE to hosted and accepts only hosted or local", () => {
    expect(loadWorkerConfig(base).mode).toBe("hosted");
    expect(loadWorkerConfig({ ...base, MURPHY_MODE: "" }).mode).toBe("hosted");
    expect(loadWorkerConfig({ ...base, MURPHY_MODE: "local" }).mode).toBe("local");
    expect(() => loadWorkerConfig({ ...base, MURPHY_MODE: "dev" })).toThrow(/MURPHY_MODE/);
    expect(() => loadWorkerConfig({ ...base, MURPHY_MODE: "LOCAL" })).toThrow(/MURPHY_MODE/);
  });

  it("generates distinct worker ids", () => {
    expect(makeWorkerId()).not.toBe(makeWorkerId());
  });
});
