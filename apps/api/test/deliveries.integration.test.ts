import { randomUUID } from "node:crypto";
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

async function createEndpoint(project: TestProject): Promise<string> {
  const res = await request(env.app)
    .post("/v1/endpoints")
    .set(project.auth)
    .send({ url: "https://example.com/hooks" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Sends one event and returns the ids of the deliveries it created. */
async function sendEvent(
  project: TestProject,
  type = "payment.captured",
): Promise<{ eventId: string; deliveryIds: string[] }> {
  const res = await request(env.app)
    .post("/v1/events")
    .set(project.auth)
    .set("Idempotency-Key", randomUUID())
    .send({ type, payload: { id: randomUUID() } });
  expect(res.status).toBe(202);
  const rows = await env.prisma.delivery.findMany({
    where: { eventId: res.body.id },
    orderBy: { createdAt: "asc" },
  });
  return { eventId: res.body.id, deliveryIds: rows.map((r) => r.id) };
}

const setStatus = (
  id: string,
  status: "pending" | "in_flight" | "succeeded" | "failed" | "dead" | "cancelled",
  extra = {},
) => env.prisma.delivery.update({ where: { id }, data: { status, ...extra } });

const get = (project: TestProject, path: string) => request(env.app).get(path).set(project.auth);
const post = (project: TestProject, path: string, body?: object) => {
  const req = request(env.app).post(path).set(project.auth);
  return body ? req.send(body) : req;
};

describe("GET /v1/deliveries", () => {
  it("lists newest first with filters and keyset pagination", async () => {
    const project = await createProject(env.repo);
    const e1 = await createEndpoint(project);
    const e2 = await createEndpoint(project);
    const events = [];
    for (let i = 0; i < 3; i++) events.push(await sendEvent(project)); // 6 deliveries
    await setStatus(events[0]!.deliveryIds[0]!, "dead");

    const all = await get(project, "/v1/deliveries?limit=100");
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(6);
    const created = all.body.data.map((d: { created_at: string }) => d.created_at);
    expect([...created].sort().reverse()).toEqual(created);
    expect(all.body.next_cursor).toBeNull();
    expect(all.body.data[0]).toMatchObject({
      id: expect.any(String),
      event_id: expect.any(String),
      endpoint_id: expect.any(String),
      status: "pending",
      attempt_count: 0,
    });

    // Pages of 4 then 2, no overlap, same order as the unpaginated list.
    const page1 = await get(project, "/v1/deliveries?limit=4");
    expect(page1.body.data).toHaveLength(4);
    expect(page1.body.next_cursor).toEqual(expect.any(String));
    const page2 = await get(project, `/v1/deliveries?limit=4&cursor=${page1.body.next_cursor}`);
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.next_cursor).toBeNull();
    const ids = (r: request.Response) => r.body.data.map((d: { id: string }) => d.id);
    expect([...ids(page1), ...ids(page2)]).toEqual(ids(all));

    expect(ids(await get(project, "/v1/deliveries?status=dead"))).toEqual([
      events[0]!.deliveryIds[0],
    ]);
    const byEndpoint = await get(project, `/v1/deliveries?endpoint_id=${e2}`);
    expect(byEndpoint.body.data).toHaveLength(3);
    expect(byEndpoint.body.data.every((d: { endpoint_id: string }) => d.endpoint_id === e2)).toBe(
      true,
    );
    const byEvent = await get(project, `/v1/deliveries?event_id=${events[1]!.eventId}`);
    expect(byEvent.body.data.map((d: { endpoint_id: string }) => d.endpoint_id).sort()).toEqual(
      [e1, e2].sort(),
    );
  });

  it.each([
    ["bad status", "status=lost"],
    ["bad endpoint id", "endpoint_id=nope"],
    ["limit too big", "limit=101"],
    ["limit zero", "limit=0"],
    ["garbage cursor", "cursor=abc"],
    ["unknown param", "colour=red"],
  ])("returns 400 for %s", async (_name, query) => {
    const project = await createProject(env.repo);
    const res = await get(project, `/v1/deliveries?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("GET /v1/deliveries/:id", () => {
  it("returns the delivery with its attempts in order", async () => {
    const project = await createProject(env.repo);
    await createEndpoint(project);
    const { deliveryIds } = await sendEvent(project);
    const id = deliveryIds[0]!;
    for (const [n, status, error] of [
      [2, 200, null],
      [1, null, "timeout: timed out after 10000 ms"],
    ] as const) {
      await env.prisma.deliveryAttempt.create({
        data: {
          deliveryId: id,
          projectId: project.id,
          attemptNo: n,
          startedAt: new Date(),
          durationMs: 12,
          requestHeaders: { "webhook-id": "msg_x" },
          responseStatus: status,
          responseBodySnippet: status ? "ok" : null,
          error,
        },
      });
    }
    const res = await get(project, `/v1/deliveries/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.attempts.map((a: { attempt_no: number }) => a.attempt_no)).toEqual([1, 2]);
    expect(res.body.attempts[1]).toMatchObject({
      response_status: 200,
      response_body_snippet: "ok",
      duration_ms: 12,
      request_headers: { "webhook-id": "msg_x" },
      error: null,
    });
  });

  it("returns 404 for unknown and malformed ids", async () => {
    const project = await createProject(env.repo);
    expect((await get(project, `/v1/deliveries/${randomUUID()}`)).status).toBe(404);
    expect((await get(project, "/v1/deliveries/nope")).status).toBe(404);
  });
});

describe("POST /v1/deliveries/:id/replay", () => {
  it.each(["dead", "succeeded", "failed"] as const)(
    "replays a %s delivery and resets its counters",
    async (status) => {
      const project = await createProject(env.repo);
      await createEndpoint(project);
      const { deliveryIds } = await sendEvent(project);
      const id = deliveryIds[0]!;
      await setStatus(id, status, {
        attemptCount: 9,
        clientErrorCount: 2,
        reapCount: 4,
        completedAt: new Date(),
        nextAttemptAt: new Date(Date.now() + 3_600_000),
      });

      const res = await post(project, `/v1/deliveries/${id}/replay`);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        id,
        status: "pending",
        attempt_count: 0,
        completed_at: null,
      });
      const row = await env.prisma.delivery.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        status: "pending",
        attemptCount: 0,
        clientErrorCount: 0,
        reapCount: 0,
        completedAt: null,
      });
      expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    },
  );

  it.each(["pending", "in_flight"] as const)(
    "returns 409 delivery_in_progress for a %s delivery",
    async (status) => {
      const project = await createProject(env.repo);
      await createEndpoint(project);
      const { deliveryIds } = await sendEvent(project);
      await setStatus(deliveryIds[0]!, status);
      const res = await post(project, `/v1/deliveries/${deliveryIds[0]}/replay`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("delivery_in_progress");
    },
  );

  it("returns 409 endpoint_deleted for cancelled deliveries and finished ones of deleted endpoints", async () => {
    const project = await createProject(env.repo);
    const endpointId = await createEndpoint(project);
    const first = await sendEvent(project); // will be cancelled by the delete
    const second = await sendEvent(project);
    await setStatus(second.deliveryIds[0]!, "dead");
    await request(env.app).delete(`/v1/endpoints/${endpointId}`).set(project.auth).expect(204);

    for (const id of [first.deliveryIds[0]!, second.deliveryIds[0]!]) {
      const res = await post(project, `/v1/deliveries/${id}/replay`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("endpoint_deleted");
    }
    expect(
      (await env.prisma.delivery.findUniqueOrThrow({ where: { id: second.deliveryIds[0]! } }))
        .status,
    ).toBe("dead");
  });

  it("returns 404 for unknown deliveries", async () => {
    const project = await createProject(env.repo);
    expect((await post(project, `/v1/deliveries/${randomUUID()}/replay`)).status).toBe(404);
  });
});

describe("POST /v1/replay (bulk)", () => {
  it("replays dead deliveries by default, filtered by endpoint and time range", async () => {
    const project = await createProject(env.repo);
    const e1 = await createEndpoint(project);
    const e2 = await createEndpoint(project);
    const old = await sendEvent(project);
    const recent = await sendEvent(project);
    const all = [...old.deliveryIds, ...recent.deliveryIds];
    for (const id of all) await setStatus(id, "dead");
    await env.prisma.delivery.updateMany({
      where: { id: { in: old.deliveryIds } },
      data: { createdAt: new Date("2026-10-01T00:00:00Z") },
    });
    await setStatus(recent.deliveryIds[1]!, "succeeded");

    // Endpoint filter + time range: only old deliveries of e1.
    const scoped = await post(project, "/v1/replay", {
      endpoint_id: e1,
      from: "2026-09-30T00:00:00Z",
      to: "2026-10-02T00:00:00Z",
    });
    expect(scoped.status).toBe(202);
    expect(scoped.body).toEqual({ replayed: 1, limit: 1000 });
    const e1Old = await env.prisma.delivery.findFirstOrThrow({
      where: { id: { in: old.deliveryIds }, endpointId: e1 },
    });
    expect(e1Old.status).toBe("pending");

    // Default (status dead, no filters): the remaining 2 dead ones; the succeeded one is untouched.
    const rest = await post(project, "/v1/replay");
    expect(rest.body.replayed).toBe(2);
    expect(
      (await env.prisma.delivery.findUniqueOrThrow({ where: { id: recent.deliveryIds[1]! } }))
        .status,
    ).toBe("succeeded");

    // Explicit statuses.
    const succeeded = await post(project, "/v1/replay", { status: ["succeeded"], endpoint_id: e2 });
    expect(succeeded.body.replayed).toBe(1);
  });

  it("caps one call at 1000 deliveries", async () => {
    const project = await createProject(env.repo);
    await createEndpoint(project);
    const { eventId, deliveryIds } = await sendEvent(project);
    const template = await env.prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryIds[0]! },
    });
    await env.prisma.$executeRaw`
      INSERT INTO deliveries (project_id, event_id, endpoint_id, status, next_attempt_at)
      SELECT ${project.id}::uuid, ${eventId}::uuid, ${template.endpointId}::uuid, 'dead', now()
      FROM generate_series(1, 1004)`;
    await setStatus(template.id, "dead"); // 1005 dead in total

    expect((await post(project, "/v1/replay")).body.replayed).toBe(1000);
    expect((await post(project, "/v1/replay")).body.replayed).toBe(5);
    expect((await post(project, "/v1/replay")).body.replayed).toBe(0);
  });

  it("skips deliveries of deleted endpoints", async () => {
    const project = await createProject(env.repo);
    const endpointId = await createEndpoint(project);
    const { deliveryIds } = await sendEvent(project);
    await setStatus(deliveryIds[0]!, "dead");
    await request(env.app).delete(`/v1/endpoints/${endpointId}`).set(project.auth).expect(204);
    expect((await post(project, "/v1/replay")).body.replayed).toBe(0);
  });

  it.each([
    ["pending is not replayable", { status: "pending" }],
    ["empty status list", { status: [] }],
    ["from after to", { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" }],
    ["bad date", { from: "yesterday" }],
    ["unknown field", { everything: true }],
  ])("returns 400 for %s", async (_name, body) => {
    const project = await createProject(env.repo);
    const res = await post(project, "/v1/replay", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("DLQ", () => {
  it("lists only dead deliveries and retries them, optionally per endpoint", async () => {
    const project = await createProject(env.repo);
    const e1 = await createEndpoint(project);
    const e2 = await createEndpoint(project);
    const a = await sendEvent(project);
    const b = await sendEvent(project);
    for (const id of [...a.deliveryIds, ...b.deliveryIds.slice(0, 1)]) await setStatus(id, "dead");

    const dlq = await get(project, "/v1/dlq");
    expect(dlq.status).toBe(200);
    expect(dlq.body.data).toHaveLength(3);
    expect(dlq.body.data.every((d: { status: string }) => d.status === "dead")).toBe(true);
    const dlqE2 = await get(project, `/v1/dlq?endpoint_id=${e2}`);
    expect(dlqE2.body.data).toHaveLength(1);

    const retryE2 = await post(project, "/v1/dlq/retry", { endpoint_id: e2 });
    expect(retryE2.status).toBe(202);
    expect(retryE2.body).toEqual({ replayed: 1, limit: 1000 });
    const retryAll = await post(project, "/v1/dlq/retry");
    expect(retryAll.body.replayed).toBe(2);
    expect((await get(project, "/v1/dlq")).body.data).toEqual([]);
    expect(
      await env.prisma.delivery.count({
        where: { endpointId: { in: [e1, e2] }, status: "pending" },
      }),
    ).toBe(4);
  });
});

describe("cross-tenant isolation (delivery routes)", () => {
  it("never shows or changes project A's deliveries for project B", async () => {
    const a = await createProject(env.repo, "A");
    const b = await createProject(env.repo, "B");
    const aEndpoint = await createEndpoint(a);
    const { eventId, deliveryIds } = await sendEvent(a);
    const id = deliveryIds[0]!;
    await setStatus(id, "dead");

    expect((await get(b, `/v1/deliveries/${id}`)).status).toBe(404);
    expect((await post(b, `/v1/deliveries/${id}/replay`)).status).toBe(404);
    expect((await get(b, "/v1/deliveries")).body.data).toEqual([]);
    expect((await get(b, `/v1/deliveries?endpoint_id=${aEndpoint}`)).body.data).toEqual([]);
    expect((await get(b, `/v1/deliveries?event_id=${eventId}`)).body.data).toEqual([]);
    expect((await get(b, "/v1/dlq")).body.data).toEqual([]);
    expect((await get(b, `/v1/dlq?endpoint_id=${aEndpoint}`)).body.data).toEqual([]);
    expect((await post(b, "/v1/replay", { endpoint_id: aEndpoint })).body.replayed).toBe(0);
    expect((await post(b, "/v1/replay")).body.replayed).toBe(0);
    expect((await post(b, "/v1/dlq/retry", { endpoint_id: aEndpoint })).body.replayed).toBe(0);
    expect((await post(b, "/v1/dlq/retry")).body.replayed).toBe(0);

    // A's delivery is untouched and still visible to A.
    expect((await env.prisma.delivery.findUniqueOrThrow({ where: { id } })).status).toBe("dead");
    expect((await get(a, `/v1/deliveries/${id}`)).status).toBe(200);
  });

  it("requires a valid API key on every delivery route", async () => {
    for (const [method, path] of [
      ["get", "/v1/deliveries"],
      ["get", `/v1/deliveries/${randomUUID()}`],
      ["post", `/v1/deliveries/${randomUUID()}/replay`],
      ["post", "/v1/replay"],
      ["get", "/v1/dlq"],
      ["post", "/v1/dlq/retry"],
    ] as const) {
      expect((await request(env.app)[method](path)).status).toBe(401);
    }
  });
});
