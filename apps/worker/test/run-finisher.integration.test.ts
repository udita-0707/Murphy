import { createRepository, createRunQueue, type Repository, type RunQueue } from "@murphy/db";
import { compile, parseScenario, type RunPlan } from "@murphy/simulator";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchTargetState, MAX_STATE_BYTES } from "../src/net/fetch-state.js";
import { finishRunsOnce, startRunFinisher } from "../src/run-finisher.js";
import { startTestDb, type TestDb } from "./helpers.js";

const SCENARIO = `
version: 1
slug: finisher
name: Finisher
difficulty: beginner
provider: booking
seed: 7
entities:
  - { id: stay, kind: reservation, amount_minor: 1000, currency: INR }
timeline:
  - { id: created, emit: reservation.created, entity: stay }
assertions:
  - final_state: { entity: stay, state: created }
`;

let db: TestDb;
let repo: Repository;
let runs: RunQueue;
let projectId: string;
let endpointId: string;
let scenarioId: string;
let server: Server | undefined;
let answer: { status: number; body: string; headers?: Record<string, string> };

async function stateServer(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/state`;
}

async function startRun(stateUrl: string | null): Promise<{ runId: string; plan: RunPlan }> {
  const runId = randomUUID();
  const plan = compile(parseScenario(SCENARIO), { runId });
  const result = await repo.runs.start(projectId, {
    id: runId,
    scenarioId,
    endpointId,
    seed: plan.seed,
    targetLabel: "naive",
    stateUrl,
    plan: plan as unknown as Parameters<Repository["runs"]["start"]>[1]["plan"],
    deadlineOffsetMs: plan.deadline_offset_ms,
    entities: [],
    steps: plan.steps.map((step) => ({
      eventType: step.emit,
      payload: step.payload,
      idempotencyKey: `sim:${runId}:${step.id}`,
      requestHash: "h",
      dueOffsetsMs: step.due_offsets_ms,
    })),
  });
  expect(result.outcome).toBe("started");
  return { runId, plan };
}

/** Marks a run's rows as delivered, with one logged 200, without a worker. */
async function deliverAll(runId: string): Promise<void> {
  const rows = await db.prisma.delivery.findMany({ where: { event: { scenarioRunId: runId } } });
  for (const row of rows) {
    await db.prisma.delivery.update({
      where: { id: row.id },
      data: { status: "succeeded", completedAt: new Date(), attemptCount: 1 },
    });
    await db.prisma.deliveryAttempt.create({
      data: {
        deliveryId: row.id,
        projectId,
        attemptNo: 1,
        startedAt: new Date(),
        requestHeaders: {},
        responseStatus: 200,
      },
    });
  }
}

const options = () => ({ repo, runs, mode: "local" as const });
const stateFor = (plan: RunPlan, state: string) =>
  JSON.stringify({
    entities: { [plan.entities[0]!.provider_id]: { state, balance_minor: 0 } },
  });

beforeAll(async () => {
  db = await startTestDb();
  repo = createRepository(db.prisma);
  runs = createRunQueue(db.prisma);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.prisma.$executeRawUnsafe(`TRUNCATE projects CASCADE`);
  projectId = (await repo.projects.create({ name: "a" })).id;
  endpointId = (
    await repo.endpoints.create(projectId, {
      url: "https://example.com/hooks",
      secretEnc: randomBytes(48),
    })
  ).id;
  scenarioId = (
    await repo.scenarios.save(projectId, {
      slug: "finisher",
      name: "Finisher",
      difficulty: "beginner",
      definitionYaml: SCENARIO,
    })
  ).id;
});
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe("the run finisher", () => {
  it("leaves a run alone while it still has work", async () => {
    const { runId } = await startRun(null);
    expect(await finishRunsOnce(options())).toBe(0);
    expect((await repo.runs.get(projectId, runId))!.status).toBe("running");
  });

  it("stores a passed report once everything is delivered", async () => {
    const url = await stateServer();
    const { runId, plan } = await startRun(url);
    answer = { status: 200, body: stateFor(plan, "created") };
    await deliverAll(runId);

    expect(await finishRunsOnce(options())).toBe(1);
    const run = await repo.runs.get(projectId, runId);
    expect(run).toMatchObject({
      status: "passed",
      report: {
        schema_version: 1,
        run: { id: runId, status: "passed" },
        target: { handler: "naive", endpoint_id: endpointId },
      },
    });
    expect(run!.finishedAt).not.toBeNull();
    expect(await finishRunsOnce(options())).toBe(0);
  });

  it("stores a failed report when the target's state is wrong", async () => {
    const url = await stateServer();
    const { runId, plan } = await startRun(url);
    answer = { status: 200, body: stateFor(plan, "cancelled") };
    await deliverAll(runId);
    await finishRunsOnce(options());
    expect((await repo.runs.get(projectId, runId))!.status).toBe("failed");
  });

  it.each([
    ["a broken state endpoint", { status: 500, body: "boom" }, /answered 500/],
    ["a body that is not JSON", { status: 200, body: "<html>" }, /not JSON/],
    ["a body off the contract", { status: 200, body: '{"nope":1}' }, /does not match the contract/],
  ])("errors, and does not pass, on %s", async (_name, reply, reason) => {
    const url = await stateServer();
    const { runId } = await startRun(url);
    answer = reply;
    await deliverAll(runId);
    await finishRunsOnce(options());
    const run = await repo.runs.get(projectId, runId);
    expect(run!.status).toBe("errored");
    expect((run!.report as { run: { reason: string } }).run.reason).toMatch(reason);
  });

  it("errors when the target is unreachable", async () => {
    const { runId } = await startRun("http://127.0.0.1:9/state");
    await deliverAll(runId);
    await finishRunsOnce(options());
    expect((await repo.runs.get(projectId, runId))!.status).toBe("errored");
  });

  it("errors a stuck run at its deadline, even if rows are still pending", async () => {
    const { runId } = await startRun(null);
    await db.prisma.scenarioRun.update({
      where: { id: runId },
      data: { deadlineAt: new Date(Date.now() - 60_000) },
    });
    await finishRunsOnce(options());
    const run = await repo.runs.get(projectId, runId);
    expect(run!.status).toBe("errored");
    expect((run!.report as { run: { reason: string } }).run.reason).toMatch(/stuck/);
  });

  it("two finishers at once store one report", async () => {
    const url = await stateServer();
    const { runId, plan } = await startRun(url);
    answer = { status: 200, body: stateFor(plan, "created") };
    await deliverAll(runId);
    const counts = await Promise.all([finishRunsOnce(options()), finishRunsOnce(options())]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("a bad run does not stop the others", async () => {
    const url = await stateServer();
    const bad = await startRun(url);
    const good = await startRun(url);
    answer = { status: 200, body: stateFor(good.plan, "created") };
    await deliverAll(bad.runId);
    await deliverAll(good.runId);
    await db.prisma.scenarioRun.update({
      where: { id: bad.runId },
      data: { plan: { broken: true } },
    });

    const errors: string[] = [];
    await finishRunsOnce({ ...options(), onError: (_e, context) => void errors.push(context) });
    expect(errors).toEqual([`run ${bad.runId}`]);
    expect((await repo.runs.get(projectId, good.runId))!.status).toBe("passed");
  });

  it("runs on an interval until stopped", async () => {
    const url = await stateServer();
    const { runId, plan } = await startRun(url);
    answer = { status: 200, body: stateFor(plan, "created") };
    await deliverAll(runId);
    const finished: string[] = [];
    const stop = startRunFinisher({
      ...options(),
      intervalMs: 20,
      onFinish: ({ runId: id }) => void finished.push(id),
    });
    await expect.poll(() => finished, { timeout: 5_000 }).toEqual([runId]);
    await stop();
  });
});

describe("reading target state goes through the SSRF guard", () => {
  const read = (stateUrl: string, mode: "local" | "hosted" = "local") =>
    fetchTargetState({ stateUrl, runId: "r 1", mode, timeoutMs: 1_000 });

  it("refuses localhost in hosted mode, without connecting", async () => {
    let hits = 0;
    server = createServer((_req, res) => {
      hits += 1;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const result = await read(`http://127.0.0.1:${port}/state`, "hosted");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/blocked/);
    expect(hits).toBe(0);
  });

  it("refuses the cloud metadata address even in local mode", async () => {
    const result = await read("http://169.254.169.254/latest/meta-data");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/blocked/);
  });

  it("does not follow redirects", async () => {
    answer = { status: 302, body: "", headers: { location: "http://169.254.169.254/" } };
    const url = await stateServer();
    expect(await read(url)).toEqual({ ok: false, error: "the state endpoint answered 302" });
  });

  it("encodes the run id, and adds it to any existing query", async () => {
    let seen = "";
    server = createServer((req, res) => {
      seen = req.url ?? "";
      res.end("{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    await read(`http://127.0.0.1:${port}/state?a=1`);
    expect(seen).toBe("/state?a=1&run_id=r+1");
  });

  it("gives up on a huge response", async () => {
    answer = { status: 200, body: "x".repeat(MAX_STATE_BYTES + 1) };
    const url = await stateServer();
    expect(await read(url)).toMatchObject({ ok: false, error: expect.stringMatching(/larger/) });
  });

  it("gives up on a slow response", async () => {
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const result = await fetchTargetState({
      stateUrl: `http://127.0.0.1:${port}/`,
      runId: "r",
      mode: "local",
      timeoutMs: 100,
    });
    server.closeAllConnections();
    expect(result.ok).toBe(false);
  });

  it("refuses a URL that is not one", async () => {
    expect(await read("not a url")).toEqual({ ok: false, error: "the state URL is not valid" });
  });
});
