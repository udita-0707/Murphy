import { randomUUID } from "node:crypto";
import { decryptSecret } from "@murphy/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, startTestEnv, type TestEnv, type TestProject } from "./helpers.js";

let env: TestEnv;

beforeAll(async () => {
  env = await startTestEnv();
});

afterAll(async () => {
  await env?.stop();
});

async function createEndpoint(
  project: TestProject,
  body: Record<string, unknown> = {},
): Promise<{ id: string; secret: string }> {
  const res = await request(env.app)
    .post("/v1/endpoints")
    .set(project.auth)
    .send({ url: "https://example.com/hooks", ...body });
  expect(res.status).toBe(201);
  return res.body as { id: string; secret: string };
}

function postEvent(project: TestProject, key: string | undefined, body: unknown) {
  const req = request(env.app).post("/v1/events").set(project.auth);
  return (key === undefined ? req : req.set("Idempotency-Key", key)).send(body as object);
}

const paymentCaptured = {
  type: "payment.captured",
  payload: {
    id: "pay_1",
    amount: 49900,
    currency: "INR",
    notes: { order: "o_1", tags: ["a", "b"] },
  },
};

describe("authentication", () => {
  it("returns 401 for a missing, malformed, unknown or wrong key", async () => {
    const project = await createProject(env.repo);
    const [, prefix] = project.apiKey.split("_");
    const wrongSecret = `mk_${prefix}_${"A".repeat(43)}`;
    for (const authorization of [
      undefined,
      "Bearer not-a-key",
      `Bearer mk_zzzzzzzz_${"A".repeat(43)}`,
      `Bearer ${wrongSecret}`,
      project.apiKey,
    ]) {
      const req = request(env.app).get("/v1/endpoints");
      const res = await (authorization ? req.set("authorization", authorization) : req);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: "unauthorized" });
      expect(res.body.error.request_id).toEqual(expect.any(String));
    }
  });

  it("returns 401 for a revoked key", async () => {
    const project = await createProject(env.repo);
    await env.prisma.apiKey.updateMany({
      where: { projectId: project.id },
      data: { revokedAt: new Date() },
    });
    const res = await request(env.app).get("/v1/endpoints").set(project.auth);
    expect(res.status).toBe(401);
  });

  it("accepts a valid key", async () => {
    const project = await createProject(env.repo);
    const res = await request(env.app).get("/v1/endpoints").set(project.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });
});

describe("validation", () => {
  it("returns 400 when Idempotency-Key is missing", async () => {
    const project = await createProject(env.repo);
    const res = await postEvent(project, undefined, paymentCaptured);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("idempotency_key_required");
    expect(await env.prisma.event.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("returns 400 for an invalid Idempotency-Key", async () => {
    const project = await createProject(env.repo);
    const res = await postEvent(project, "x".repeat(256), paymentCaptured);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it.each([
    ["missing type", { payload: {} }],
    ["missing payload", { type: "payment.captured" }],
    ["array payload", { type: "payment.captured", payload: [1, 2] }],
    ["string payload", { type: "payment.captured", payload: "hello" }],
    ["bad type", { type: "payment captured!", payload: {} }],
    ["unknown field", { ...paymentCaptured, extra: true }],
  ])("returns 400 for an invalid event body (%s)", async (_name, body) => {
    const project = await createProject(env.repo);
    const res = await postEvent(project, randomUUID(), body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for malformed JSON", async () => {
    const project = await createProject(env.repo);
    const res = await request(env.app)
      .post("/v1/events")
      .set(project.auth)
      .set("Idempotency-Key", randomUUID())
      .set("content-type", "application/json")
      .send('{"type": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });

  it("returns 400 for non-http(s) endpoint URLs", async () => {
    const project = await createProject(env.repo);
    for (const url of [
      "ftp://example.com/x",
      "javascript:alert(1)",
      "not a url",
      "file:///etc/passwd",
    ]) {
      const res = await request(env.app).post("/v1/endpoints").set(project.auth).send({ url });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    }
  });
});

describe("endpoints", () => {
  it("returns the signing secret only on create and stores it encrypted", async () => {
    const project = await createProject(env.repo);
    const created = await createEndpoint(project, { description: "orders", event_filter: ["a.b"] });
    expect(created.secret).toMatch(/^whsec_/);
    expect(created).toMatchObject({
      url: "https://example.com/hooks",
      description: "orders",
      event_filter: ["a.b"],
      status: "active",
    });

    const row = await env.prisma.endpoint.findUniqueOrThrow({ where: { id: created.id } });
    expect(Buffer.from(row.secretEnc).toString("utf8")).not.toContain(created.secret);
    expect(decryptSecret(Buffer.from(row.secretEnc), env.encryptionKey)).toBe(created.secret);

    const fetched = await request(env.app).get(`/v1/endpoints/${created.id}`).set(project.auth);
    expect(fetched.status).toBe(200);
    expect(fetched.body).not.toHaveProperty("secret");
    const listed = await request(env.app).get("/v1/endpoints").set(project.auth);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).not.toHaveProperty("secret");
  });

  it("updates and deletes endpoints", async () => {
    const project = await createProject(env.repo);
    const { id } = await createEndpoint(project);

    const patched = await request(env.app)
      .patch(`/v1/endpoints/${id}`)
      .set(project.auth)
      .send({ url: "http://localhost:3000/webhooks", status: "paused", event_filter: ["x.y"] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      url: "http://localhost:3000/webhooks",
      status: "paused",
      event_filter: ["x.y"],
    });

    const empty = await request(env.app).patch(`/v1/endpoints/${id}`).set(project.auth).send({});
    expect(empty.status).toBe(400);

    const deleted = await request(env.app).delete(`/v1/endpoints/${id}`).set(project.auth);
    expect(deleted.status).toBe(204);
    const gone = await request(env.app).get(`/v1/endpoints/${id}`).set(project.auth);
    expect(gone.status).toBe(404);
    const again = await request(env.app).delete(`/v1/endpoints/${id}`).set(project.auth);
    expect(again.status).toBe(404);
  });

  it("returns 404 for malformed ids", async () => {
    const project = await createProject(env.repo);
    const res = await request(env.app).get("/v1/endpoints/not-a-uuid").set(project.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("endpoint soft delete", () => {
  it("hides the endpoint, cancels unfinished deliveries and keeps history", async () => {
    const project = await createProject(env.repo);
    const doomed = await createEndpoint(project);
    const kept = await createEndpoint(project);
    const { body: event } = await postEvent(project, randomUUID(), paymentCaptured);
    expect(event.deliveries).toBe(2);

    // One of the doomed endpoint's deliveries is mid-flight, another already succeeded.
    const [pending] = await env.prisma.delivery.findMany({
      where: { eventId: event.id, endpointId: doomed.id },
    });
    const { body: second } = await postEvent(project, randomUUID(), paymentCaptured);
    await env.prisma.delivery.updateMany({
      where: { eventId: second.id, endpointId: doomed.id },
      data: { status: "in_flight", lockedBy: "w1", lockedUntil: new Date(Date.now() + 60_000) },
    });
    const { body: third } = await postEvent(project, randomUUID(), paymentCaptured);
    await env.prisma.delivery.updateMany({
      where: { eventId: third.id, endpointId: doomed.id },
      data: { status: "succeeded", completedAt: new Date() },
    });

    const res = await request(env.app).delete(`/v1/endpoints/${doomed.id}`).set(project.auth);
    expect(res.status).toBe(204);

    // Gone from the API.
    expect(
      (await request(env.app).get(`/v1/endpoints/${doomed.id}`).set(project.auth)).status,
    ).toBe(404);
    const patch = await request(env.app)
      .patch(`/v1/endpoints/${doomed.id}`)
      .set(project.auth)
      .send({ status: "active" });
    expect(patch.status).toBe(404);
    expect(
      (await request(env.app).delete(`/v1/endpoints/${doomed.id}`).set(project.auth)).status,
    ).toBe(404);
    const list = await request(env.app).get("/v1/endpoints").set(project.auth);
    expect(list.body.data.map((e: { id: string }) => e.id)).toEqual([kept.id]);

    // Row kept with deleted_at; unfinished deliveries cancelled, finished ones untouched.
    const row = await env.prisma.endpoint.findUniqueOrThrow({ where: { id: doomed.id } });
    expect(row.deletedAt).not.toBeNull();
    const doomedDeliveries = await env.prisma.delivery.findMany({
      where: { endpointId: doomed.id },
    });
    const byEvent = Object.fromEntries(doomedDeliveries.map((d) => [d.eventId, d]));
    expect(byEvent[event.id]).toMatchObject({
      id: pending!.id,
      status: "cancelled",
      lockedBy: null,
    });
    expect(byEvent[event.id]!.completedAt).not.toBeNull();
    expect(byEvent[second.id]).toMatchObject({
      status: "cancelled",
      lockedBy: null,
      lockedUntil: null,
    });
    expect(byEvent[third.id]).toMatchObject({ status: "succeeded" });
    expect(
      await env.prisma.delivery.count({ where: { endpointId: kept.id, status: "pending" } }),
    ).toBe(3);

    // History stays visible on the event.
    const fetched = await request(env.app).get(`/v1/events/${event.id}`).set(project.auth);
    expect(fetched.body.deliveries).toHaveLength(2);
    expect(
      fetched.body.deliveries.find((d: { endpoint_id: string }) => d.endpoint_id === doomed.id),
    ).toMatchObject({ status: "cancelled" });

    // New events no longer fan out to the deleted endpoint.
    const after = await postEvent(project, randomUUID(), paymentCaptured);
    expect(after.body.deliveries).toBe(1);
    expect(
      await env.prisma.delivery.count({ where: { eventId: after.body.id, endpointId: doomed.id } }),
    ).toBe(0);
  });

  it("does not let another project delete or cancel anything", async () => {
    const a = await createProject(env.repo, "A");
    const b = await createProject(env.repo, "B");
    const endpoint = await createEndpoint(a);
    await postEvent(a, randomUUID(), paymentCaptured);
    expect((await request(env.app).delete(`/v1/endpoints/${endpoint.id}`).set(b.auth)).status).toBe(
      404,
    );
    expect(
      await env.prisma.delivery.count({ where: { endpointId: endpoint.id, status: "pending" } }),
    ).toBe(1);
    expect(
      (await env.prisma.endpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).deletedAt,
    ).toBeNull();
  });
});

describe("POST /v1/events idempotency", () => {
  it("replays the original 202 for a sequential retry with the same payload", async () => {
    const project = await createProject(env.repo);
    await createEndpoint(project);
    const key = randomUUID();

    const first = await postEvent(project, key, paymentCaptured);
    expect(first.status).toBe(202);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(first.body).toEqual({ id: expect.any(String), deliveries: 1 });

    // Same content with keys in a different order is the same canonical payload.
    const reordered = {
      payload: {
        notes: { tags: ["a", "b"], order: "o_1" },
        currency: "INR",
        amount: 49900,
        id: "pay_1",
      },
      type: "payment.captured",
    };
    const second = await postEvent(project, key, reordered);
    expect(second.status).toBe(202);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);

    expect(await env.prisma.event.count({ where: { projectId: project.id } })).toBe(1);
    expect(await env.prisma.delivery.count({ where: { projectId: project.id } })).toBe(1);
  });

  it("creates exactly one event for 10 concurrent requests with the same key", async () => {
    const project = await createProject(env.repo);
    await createEndpoint(project);
    await createEndpoint(project);
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => postEvent(project, key, paymentCaptured)),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(202));
    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(responses.every((r) => r.body.deliveries === 2)).toBe(true);
    expect(responses.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(9);
    expect(await env.prisma.event.count({ where: { projectId: project.id } })).toBe(1);
    expect(await env.prisma.delivery.count({ where: { projectId: project.id } })).toBe(2);
  });

  it("returns 409 when the key is reused with a different payload or type", async () => {
    const project = await createProject(env.repo);
    const key = randomUUID();
    expect((await postEvent(project, key, paymentCaptured)).status).toBe(202);

    const otherPayload = await postEvent(project, key, {
      ...paymentCaptured,
      payload: { ...paymentCaptured.payload, amount: 1 },
    });
    expect(otherPayload.status).toBe(409);
    expect(otherPayload.body.error.code).toBe("idempotency_key_reused");

    const otherType = await postEvent(project, key, { ...paymentCaptured, type: "payment.failed" });
    expect(otherType.status).toBe(409);
    expect(otherType.body.error.code).toBe("idempotency_key_reused");

    expect(await env.prisma.event.count({ where: { projectId: project.id } })).toBe(1);
  });

  it("scopes keys per project", async () => {
    const a = await createProject(env.repo);
    const b = await createProject(env.repo);
    const key = randomUUID();
    const ra = await postEvent(a, key, paymentCaptured);
    const rb = await postEvent(b, key, { ...paymentCaptured, payload: { other: true } });
    expect(ra.status).toBe(202);
    expect(rb.status).toBe(202);
    expect(rb.headers["idempotent-replayed"]).toBeUndefined();
    expect(ra.body.id).not.toBe(rb.body.id);
  });
});

describe("POST /v1/events fan-out", () => {
  it("creates one pending delivery per active endpoint", async () => {
    const project = await createProject(env.repo);
    const endpoints = [
      await createEndpoint(project),
      await createEndpoint(project),
      await createEndpoint(project),
    ];

    const before = new Date();
    const res = await postEvent(project, randomUUID(), paymentCaptured);
    expect(res.status).toBe(202);
    expect(res.body.deliveries).toBe(3);

    const rows = await env.prisma.delivery.findMany({ where: { eventId: res.body.id } });
    expect(rows.map((r) => r.endpointId).sort()).toEqual(endpoints.map((e) => e.id).sort());
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.projectId).toBe(project.id);
      expect(row.attemptCount).toBe(0);
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    }
  });

  it("honours event_filter (empty means all types)", async () => {
    const project = await createProject(env.repo);
    const all = await createEndpoint(project);
    const captured = await createEndpoint(project, { event_filter: ["payment.captured"] });
    const refunds = await createEndpoint(project, {
      event_filter: ["refund.processed", "refund.failed"],
    });

    const res = await postEvent(project, randomUUID(), paymentCaptured);
    expect(res.body.deliveries).toBe(2);
    const targets = (await env.prisma.delivery.findMany({ where: { eventId: res.body.id } })).map(
      (d) => d.endpointId,
    );
    expect(targets.sort()).toEqual([all.id, captured.id].sort());

    const refund = await postEvent(project, randomUUID(), {
      type: "refund.processed",
      payload: {},
    });
    const refundTargets = (
      await env.prisma.delivery.findMany({ where: { eventId: refund.body.id } })
    ).map((d) => d.endpointId);
    expect(refundTargets.sort()).toEqual([all.id, refunds.id].sort());
  });

  it("skips disabled and paused endpoints", async () => {
    const project = await createProject(env.repo);
    const active = await createEndpoint(project);
    for (const status of ["disabled", "paused"]) {
      const { id } = await createEndpoint(project);
      await request(env.app)
        .patch(`/v1/endpoints/${id}`)
        .set(project.auth)
        .send({ status })
        .expect(200);
    }

    const res = await postEvent(project, randomUUID(), paymentCaptured);
    expect(res.body.deliveries).toBe(1);
    const rows = await env.prisma.delivery.findMany({ where: { eventId: res.body.id } });
    expect(rows.map((r) => r.endpointId)).toEqual([active.id]);
  });

  it("accepts an event with no matching endpoints", async () => {
    const project = await createProject(env.repo);
    const res = await postEvent(project, randomUUID(), paymentCaptured);
    expect(res.status).toBe(202);
    expect(res.body.deliveries).toBe(0);
  });
});

describe("GET /v1/events/:id", () => {
  it("returns the event with its deliveries", async () => {
    const project = await createProject(env.repo);
    const endpoint = await createEndpoint(project);
    const key = randomUUID();
    const { body } = await postEvent(project, key, paymentCaptured);

    const res = await request(env.app).get(`/v1/events/${body.id}`).set(project.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: body.id,
      type: paymentCaptured.type,
      payload: paymentCaptured.payload,
      idempotency_key: key,
    });
    expect(res.body.deliveries).toHaveLength(1);
    expect(res.body.deliveries[0]).toMatchObject({
      endpoint_id: endpoint.id,
      status: "pending",
      attempt_count: 0,
    });
  });

  it("returns 404 for unknown and malformed ids", async () => {
    const project = await createProject(env.repo);
    expect(
      (await request(env.app).get(`/v1/events/${randomUUID()}`).set(project.auth)).status,
    ).toBe(404);
    expect((await request(env.app).get("/v1/events/123").set(project.auth)).status).toBe(404);
  });
});

describe("cross-tenant isolation", () => {
  it("hides project A's events and endpoints from project B", async () => {
    const a = await createProject(env.repo, "A");
    const b = await createProject(env.repo, "B");
    const endpoint = await createEndpoint(a);
    const { body: event } = await postEvent(a, randomUUID(), paymentCaptured);

    const asB = (method: "get" | "patch" | "delete", path: string) =>
      request(env.app)[method](path).set(b.auth);

    expect((await asB("get", `/v1/events/${event.id}`)).status).toBe(404);
    expect((await asB("get", `/v1/endpoints/${endpoint.id}`)).status).toBe(404);
    expect(
      (await asB("patch", `/v1/endpoints/${endpoint.id}`).send({ status: "disabled" })).status,
    ).toBe(404);
    expect((await asB("delete", `/v1/endpoints/${endpoint.id}`)).status).toBe(404);
    expect((await asB("get", "/v1/endpoints")).body).toEqual({ data: [] });

    // A's endpoint is untouched by B's attempts.
    const stillThere = await request(env.app).get(`/v1/endpoints/${endpoint.id}`).set(a.auth);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.status).toBe("active");
  });

  it("never creates deliveries for another project's endpoints", async () => {
    const a = await createProject(env.repo, "A");
    const b = await createProject(env.repo, "B");
    const aEndpoint = await createEndpoint(a);
    const bEndpoint = await createEndpoint(b);

    const res = await postEvent(b, randomUUID(), paymentCaptured);
    expect(res.body.deliveries).toBe(1);
    expect(await env.prisma.delivery.count({ where: { endpointId: aEndpoint.id } })).toBe(0);
    const bRows = await env.prisma.delivery.findMany({ where: { eventId: res.body.id } });
    expect(bRows.map((r) => [r.endpointId, r.projectId])).toEqual([[bEndpoint.id, b.id]]);
  });
});
