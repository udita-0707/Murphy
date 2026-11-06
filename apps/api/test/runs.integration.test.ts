import { createRunQueue, type JsonObject } from "@murphy/db";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createProject, startTestEnv, type TestEnv, type TestProject } from "./helpers.js";

const YAML = `
version: 1
slug: api-duplicate
name: API duplicate
difficulty: beginner
provider: booking
seed: 42
entities:
  - { id: stay, kind: reservation, amount_minor: 450000, currency: INR }
timeline:
  - { id: created, emit: reservation.created, entity: stay }
  - { id: confirmed, emit: reservation.confirmed, entity: stay, faults: { duplicate: { after_ms: 500 } } }
assertions:
  - no_double_booking: { entity: stay }
`;

let env: TestEnv;
let hosted: Express;
let local: Express;
let a: TestProject;
let b: TestProject;

beforeAll(async () => {
  env = await startTestEnv();
  hosted = env.app;
  local = createApp({
    repo: env.repo,
    encryptionKey: env.encryptionKey,
    mode: "local",
    logError: (err) => console.error(err),
  });
  a = await createProject(env.repo, "a");
  b = await createProject(env.repo, "b");
});
afterAll(async () => {
  await env?.stop();
});

const saveScenario = async (project: TestProject, yaml = YAML) => {
  const res = await request(local)
    .post("/v1/scenarios")
    .set(project.auth)
    .send({ definition_yaml: yaml });
  expect(res.status).toBe(201);
  return res.body as { id: string; slug: string };
};

async function newEndpoint(project: TestProject, url = "http://127.0.0.1:4343/naive") {
  const res = await request(local)
    .post("/v1/endpoints")
    .set(project.auth)
    .send({ url, event_filter: ["__murphy_simulation__"] });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

const STATE_URL = "http://127.0.0.1:4343/naive/state";

async function startRun(project: TestProject, extra: object = {}) {
  const scenario = await saveScenario(project);
  const endpoint = await newEndpoint(project);
  const res = await request(local)
    .post("/v1/runs")
    .set(project.auth)
    .send({
      scenario_id: scenario.id,
      endpoint_id: endpoint,
      state_url: STATE_URL,
      target_label: "naive",
      ...extra,
    });
  expect(res.status).toBe(202);
  return { runId: (res.body as { id: string }).id, endpoint, scenario, body: res.body };
}

describe("POST /v1/scenarios", () => {
  it("stores a valid scenario, and replaces it by slug", async () => {
    const first = await saveScenario(a);
    expect(first).toMatchObject({ slug: "api-duplicate", builtin: false });
    const second = await saveScenario(a, YAML.replace("API duplicate", "Renamed"));
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ name: "Renamed" });
  });

  it("answers 422 and lists each problem by path", async () => {
    const broken = YAML.replace("reservation.confirmed", "reservation.teleported").replace(
      "provider: booking",
      "provider: booking\nsurprise: true",
    );
    const res = await request(local)
      .post("/v1/scenarios")
      .set(a.auth)
      .send({ definition_yaml: broken });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_scenario");
    expect(res.body.error.message).toMatch(/surprise/);
  });

  it("names an illegal sequence", async () => {
    const res = await request(local)
      .post("/v1/scenarios")
      .set(a.auth)
      .send({ definition_yaml: YAML.replace("reservation.confirmed", "reservation.teleported") });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/timeline\[1\]\.emit: booking has no event/);
  });

  it("requires an API key", async () => {
    expect((await request(local).post("/v1/scenarios").send({})).status).toBe(401);
  });

  it("rejects a body without YAML", async () => {
    const res = await request(local).post("/v1/scenarios").set(a.auth).send({ yaml: "x" });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/scenarios", () => {
  it("lists the project's own and the built-ins, not another project's", async () => {
    await saveScenario(a);
    await env.repo.scenarios.syncBuiltins([
      {
        slug: "library-one",
        name: "Library",
        difficulty: "beginner",
        definitionYaml: YAML.replace("api-duplicate", "library-one"),
      },
    ]);
    const fresh = await createProject(env.repo, "fresh");
    const res = await request(local).get("/v1/scenarios").set(fresh.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { slug: string }) => s.slug)).toEqual(["library-one"]);
    expect(res.body.data[0]).toMatchObject({ builtin: true });
  });
});

describe("POST /v1/runs", () => {
  it("starts a run that only writes rows for the worker", async () => {
    const { runId, endpoint, body } = await startRun(a);
    expect(body).toEqual({ id: runId, status: "running", seed: 42, steps: 2 });
    const rows = await env.prisma.delivery.findMany({
      where: { projectId: a.id, event: { scenarioRunId: runId } },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "pending" && r.endpointId === endpoint)).toBe(true);
  });

  it("uses the requested seed, and the same seed gives the same payloads", async () => {
    const payloads = async (seed: number) => {
      const { runId } = await startRun(a, { seed });
      const events = await env.prisma.event.findMany({
        where: { scenarioRunId: runId },
        orderBy: { type: "asc" },
      });
      return events.map((e) => {
        const { _murphy, ...provider } = e.payload as Record<string, unknown>;
        expect(_murphy).toBeTruthy();
        return provider;
      });
    };
    const first = await payloads(9);
    expect(await payloads(9)).toEqual(first);
    expect(await payloads(10)).not.toEqual(first);
  });

  it("marks its events as simulated, in the API and the signed body", async () => {
    const { runId } = await startRun(a);
    const event = await env.prisma.event.findFirstOrThrow({ where: { scenarioRunId: runId } });
    const res = await request(local).get(`/v1/events/${event.id}`).set(a.auth);
    expect(res.body).toMatchObject({
      simulated: true,
      scenario_run_id: runId,
      payload: { _murphy: { simulated: true, run_id: runId } },
    });
  });

  it("does not mark ordinary events, and ordinary events skip run endpoints", async () => {
    const { endpoint } = await startRun(a);
    const posted = await request(local)
      .post("/v1/events")
      .set(a.auth)
      .set("Idempotency-Key", "ordinary-1")
      .send({ type: "order.paid", payload: { id: 1 } });
    expect(posted.status).toBe(202);
    const res = await request(local).get(`/v1/events/${posted.body.id}`).set(a.auth);
    expect(res.body).toMatchObject({ simulated: false, scenario_run_id: null });
    expect(res.body.payload._murphy).toBeUndefined();
    expect(
      await env.prisma.delivery.count({ where: { eventId: posted.body.id, endpointId: endpoint } }),
    ).toBe(0);
  });

  it("refuses an endpoint that is deleted or disabled, with 409", async () => {
    const scenario = await saveScenario(a);
    const endpoint = await newEndpoint(a);
    await request(local)
      .patch(`/v1/endpoints/${endpoint}`)
      .set(a.auth)
      .send({ status: "disabled" });
    const res = await request(local)
      .post("/v1/runs")
      .set(a.auth)
      .send({ scenario_id: scenario.id, endpoint_id: endpoint, state_url: STATE_URL });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("endpoint_not_available");
  });

  it("answers 404 for an unknown scenario and 400 for a malformed body", async () => {
    const endpoint = await newEndpoint(a);
    const unknown = await request(local).post("/v1/runs").set(a.auth).send({
      scenario_id: "00000000-0000-4000-8000-000000000000",
      endpoint_id: endpoint,
      state_url: STATE_URL,
    });
    expect(unknown.status).toBe(404);
    const malformed = await request(local).post("/v1/runs").set(a.auth).send({ scenario_id: "x" });
    expect(malformed.status).toBe(400);
  });
});

describe("hosted mode", () => {
  it("refuses a localhost state URL", async () => {
    const scenario = await saveScenario(a);
    const endpoint = await newEndpoint(a);
    const res = await request(hosted)
      .post("/v1/runs")
      .set(a.auth)
      .send({ scenario_id: scenario.id, endpoint_id: endpoint, state_url: STATE_URL });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("endpoint_url_not_allowed");
  });

  it("refuses a localhost run endpoint", async () => {
    const res = await request(hosted)
      .post("/v1/endpoints")
      .set(a.auth)
      .send({ url: "http://127.0.0.1:4343/naive" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("endpoint_url_not_allowed");
  });

  it("refuses the metadata address as a state URL", async () => {
    const scenario = await saveScenario(a);
    const endpoint = await newEndpoint(a);
    // In local mode the API does not check this; the worker's guard blocks it when reading state.
    const res = await request(hosted).post("/v1/runs").set(a.auth).send({
      scenario_id: scenario.id,
      endpoint_id: endpoint,
      state_url: "http://169.254.169.254/latest",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/runs/:id", () => {
  it("shows the plan's steps and live deliveries", async () => {
    const { runId } = await startRun(a);
    const res = await request(local).get(`/v1/runs/${runId}`).set(a.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: runId,
      status: "running",
      seed: 42,
      target_label: "naive",
      report_ready: false,
      scenario: { slug: "api-duplicate" },
    });
    expect(res.body.steps.map((s: { id: string }) => s.id)).toEqual(["created", "confirmed"]);
    expect(res.body.steps[1].fault_kinds).toEqual(["duplicate"]);
    expect(res.body.deliveries).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toMatch(/signature|secret/i);
  });

  it("answers 404 for a malformed id", async () => {
    expect((await request(local).get("/v1/runs/nope").set(a.auth)).status).toBe(404);
  });
});

describe("GET /v1/runs/:id/report", () => {
  it("answers 409 until the run is finished", async () => {
    const { runId } = await startRun(a);
    const res = await request(local).get(`/v1/runs/${runId}/report`).set(a.auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("report_not_ready");
  });

  it("serves JSON, and markdown on request", async () => {
    const { runId, endpoint } = await startRun(a);
    const report = {
      schema_version: 1,
      run: {
        id: runId,
        status: "failed",
        reason: "1 of 1 assertions failed.",
        seed: 42,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 1000,
      },
      scenario: {
        slug: "api-duplicate",
        name: "API duplicate",
        difficulty: "beginner",
        provider: "booking",
        provider_label: "Booking platform style",
      },
      target: { handler: "naive", endpoint_id: endpoint },
      summary: {
        assertions_passed: 0,
        assertions_failed: 1,
        faults_planned: 0,
        faults_realised: 0,
        deliveries: 0,
        attempts: 0,
      },
      assertions: [
        { kind: "no_double_booking", entity: "stay", status: "fail", reason: "Holds 2 bookings" },
      ],
      faults: [],
      steps: [],
      timeline: [],
      entities: [],
      limits: ["A limit."],
    };
    await createRunQueue(env.prisma).finish(a.id, runId, "failed", report as JsonObject);

    const json = await request(local).get(`/v1/runs/${runId}/report`).set(a.auth);
    expect(json.status).toBe(200);
    expect(json.body).toMatchObject({ schema_version: 1, run: { status: "failed" } });

    const md = await request(local).get(`/v1/runs/${runId}/report?format=md`).set(a.auth);
    expect(md.status).toBe(200);
    expect(md.headers["content-type"]).toMatch(/text\/markdown/);
    expect(md.text).toMatch(/^# FAILED: API duplicate/);
    expect(md.text).toMatch(/Holds 2 bookings/);

    const live = await request(local).get(`/v1/runs/${runId}`).set(a.auth);
    expect(live.body).toMatchObject({ status: "failed", report_ready: true });
  });
});

describe("tenant isolation", () => {
  it("another project gets 404 for a run and its report", async () => {
    const { runId } = await startRun(a);
    expect((await request(local).get(`/v1/runs/${runId}`).set(b.auth)).status).toBe(404);
    expect((await request(local).get(`/v1/runs/${runId}/report`).set(b.auth)).status).toBe(404);
  });

  it("cannot run another project's scenario", async () => {
    const theirs = await saveScenario(a);
    const mine = await newEndpoint(b);
    const res = await request(local)
      .post("/v1/runs")
      .set(b.auth)
      .send({ scenario_id: theirs.id, endpoint_id: mine, state_url: STATE_URL });
    expect(res.status).toBe(404);
  });

  it("cannot point a run at another project's endpoint", async () => {
    const mine = await saveScenario(b);
    const theirs = await newEndpoint(a);
    const res = await request(local)
      .post("/v1/runs")
      .set(b.auth)
      .send({ scenario_id: mine.id, endpoint_id: theirs, state_url: STATE_URL });
    expect(res.status).toBe(409);
    expect(await env.prisma.delivery.count({ where: { projectId: b.id } })).toBe(0);
  });

  it("does not list another project's scenarios", async () => {
    const res = await request(local).get("/v1/scenarios").set(b.auth);
    const owners = res.body.data.filter((s: { builtin: boolean }) => !s.builtin);
    for (const scenario of owners) {
      expect(await env.prisma.scenario.count({ where: { id: scenario.id, projectId: b.id } })).toBe(
        1,
      );
    }
  });
});

describe("scenario summaries", () => {
  it("lists a scenario's provider and faults, and whether they need the target", async () => {
    const saved = await saveScenario(
      a,
      YAML.replace("api-duplicate", "api-summary").replace(
        "{ id: created, emit: reservation.created, entity: stay }",
        "{ id: created, emit: reservation.created, entity: stay, faults: { drop_then_redeliver: { lost: response } } }",
      ),
    );
    const res = await request(local).get("/v1/scenarios").set(a.auth);
    const row = (res.body as { data: { id: string; summary: unknown }[] }).data.find(
      (s) => s.id === saved.id,
    );
    expect(row?.summary).toEqual({
      provider: "booking",
      provider_label: expect.any(String),
      description: null,
      steps: 2,
      faults: [
        { step: "created", kind: "drop_then_redeliver", realised_by: "target" },
        { step: "confirmed", kind: "duplicate", realised_by: "engine" },
      ],
      needs_target_cooperation: true,
    });
  });

  it("says engine-only scenarios need no cooperation", async () => {
    const saved = await saveScenario(b);
    const res = await request(local).get("/v1/scenarios").set(b.auth);
    const row = (
      res.body as { data: { id: string; summary: { needs_target_cooperation: boolean } }[] }
    ).data.find((s) => s.id === saved.id);
    expect(row?.summary.needs_target_cooperation).toBe(false);
  });
});
