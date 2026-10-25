import { randomBytes } from "node:crypto";
import type { Repository } from "@murphy/db";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// A repository that knows no API keys; enough for routing, auth and error-shape tests.
const repo = {
  apiKeys: { findActiveByPrefix: async () => null },
} as unknown as Repository;
const app = createApp({ repo, encryptionKey: randomBytes(32), logError: () => {} });

describe("app (no database)", () => {
  it("generates a request id when none is sent", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("echoes a well-formed x-request-id and replaces an unsafe one", async () => {
    const ok = await request(app).get("/healthz").set("x-request-id", "req_abc-123");
    expect(ok.headers["x-request-id"]).toBe("req_abc-123");
    const bad = await request(app).get("/healthz").set("x-request-id", "a b<script>");
    expect(bad.headers["x-request-id"]).not.toBe("a b<script>");
  });

  it("returns the standard error body for unknown routes", async () => {
    const res = await request(app).get("/nope").set("x-request-id", "rid-1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "not_found", message: "route not found", request_id: "rid-1" },
    });
  });

  it("rejects /v1 requests without a valid key", async () => {
    for (const auth of [
      undefined,
      "Bearer nope",
      "Basic abc",
      `Bearer mk_abcd1234_${"a".repeat(43)}`,
    ]) {
      const req = request(app).get("/v1/endpoints");
      const res = await (auth ? req.set("authorization", auth) : req);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    }
  });

  it("hides internal errors behind a 500 with the request id", async () => {
    const failing = createApp({
      repo: {
        apiKeys: {
          findActiveByPrefix: async () => {
            throw new Error("db down");
          },
        },
      } as unknown as Repository,
      encryptionKey: randomBytes(32),
      logError: () => {},
    });
    const res = await request(failing)
      .get("/v1/endpoints")
      .set("authorization", `Bearer mk_abcd1234_${"a".repeat(43)}`)
      .set("x-request-id", "rid-500");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "internal_error", message: "internal server error", request_id: "rid-500" },
    });
  });
});
