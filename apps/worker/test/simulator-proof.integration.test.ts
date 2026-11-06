import { encryptSecret, generateSigningSecret, type MurphyMode } from "@murphy/core";
import {
  createDeliveryQueue,
  createRepository,
  createRunQueue,
  type DeliveryQueue,
  type JsonObject,
  type Repository,
  type RunQueue,
} from "@murphy/db";
import { createDemoTarget, IdempotentHandler, type DemoTarget } from "@murphy/demo-target";
import {
  compile,
  loadBuiltinScenarios,
  parseScenario,
  planToRunInput,
  renderReport,
  runReportSchema,
  type RunReport,
} from "@murphy/simulator";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeliveryHandler } from "../src/deliver.js";
import { finishRunsOnce } from "../src/run-finisher.js";
import { Worker } from "../src/worker.js";
import { startTestDb, type TestDb } from "./helpers.js";

/**
 * The proof: every scenario, against both handlers, through the real worker, real signing, real retries
 * and real HTTP. Only time is compressed. Nothing here calls a handler directly.
 */

/** Steps 300 ms apart, well above the 10 ms poll, so a reorder happens as planned. */
const TIME_SCALE = 0.2;
const RETRY_SCHEDULE = [300, 300];
const WAIT_MS = 30_000;

const key = randomBytes(32);
const secret = generateSigningSecret();

let db: TestDb;
let repo: Repository;
let queue: DeliveryQueue;
let runs: RunQueue;
let worker: Worker;
let projectId: string;

/** The assertion kinds the naive handler must fail, proving it fails for the intended reason. */
const NAIVE_MUST_FAIL: Record<string, string[]> = {
  "booking-duplicate-confirmation": ["no_double_booking", "exactly_once_effect"],
  "booking-cancel-before-confirm": ["final_state", "ordering_tolerated"],
  "booking-cancel-after-payment": ["final_state", "exactly_once_effect"],
  "booking-partial-refund": ["final_state", "exactly_once_effect"],
  "payment-duplicate-captured": ["no_double_credit", "exactly_once_effect"],
  "payment-captured-before-authorized": ["final_state", "ordering_tolerated"],
  "upi-success-after-expiry": ["final_state", "ordering_tolerated"],
  "payment-delayed-failure-retry": ["exactly_once_effect"],
};

async function listen(target: DemoTarget): Promise<{ url: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => {
    const s = target.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function runScenario(yaml: string, baseUrl: string, handler: string): Promise<RunReport> {
  const scenario = parseScenario(yaml);
  const saved = await repo.scenarios.save(projectId, {
    slug: scenario.slug,
    name: scenario.name,
    difficulty: scenario.difficulty,
    definitionYaml: yaml,
  });
  const endpoint = await repo.endpoints.create(projectId, {
    url: `${baseUrl}/${handler}`,
    eventFilter: ["__murphy_simulation__"],
    secretEnc: encryptSecret(secret, key),
  });
  const plan = compile(scenario, {
    runId: randomUUID(),
    timeScale: TIME_SCALE,
    retrySchedule: RETRY_SCHEDULE,
  });
  const started = await repo.runs.start(
    projectId,
    planToRunInput(plan, {
      scenarioId: saved.id,
      endpointId: endpoint.id,
      targetLabel: handler,
      stateUrl: `${baseUrl}/${handler}/state`,
    }),
  );
  expect(started.outcome).toBe("started");

  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    await finishRunsOnce({ repo, runs, mode: "local" });
    const run = await repo.runs.get(projectId, plan.run_id);
    if (run?.report) return runReportSchema.parse(run.report);
    if (Date.now() > deadline) throw new Error(`run ${plan.run_id} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const failedKinds = (report: RunReport) =>
  report.assertions.filter((a) => a.status === "fail").map((a) => a.kind);

function explain(report: RunReport): string {
  return `${report.run.status}: ${report.run.reason ?? ""}\n${renderReport(report)}`;
}

function startWorker(mode: MurphyMode = "local"): Worker {
  const w = new Worker({
    queue,
    workerId: `proof-${randomUUID()}`,
    batchSize: 20,
    projectCap: 20,
    concurrency: 20,
    pollMs: 10,
    leaseMs: 60_000,
    handler: createDeliveryHandler({
      queue,
      workerId: "proof",
      encryptionKey: key,
      mode,
      requestTimeoutMs: 2_000,
      retrySchedule: RETRY_SCHEDULE,
    }),
  });
  w.start();
  return w;
}

beforeAll(async () => {
  db = await startTestDb();
  repo = createRepository(db.prisma);
  queue = createDeliveryQueue(db.prisma);
  runs = createRunQueue(db.prisma);
  projectId = (await repo.projects.create({ name: "proof" })).id;
  worker = startWorker();
});
afterAll(async () => {
  await worker?.stop(1_000);
  await db?.stop();
});

const library = loadBuiltinScenarios();

describe("every library scenario, against both handlers", () => {
  let target: DemoTarget;
  let base: string;
  let server: Server;

  beforeAll(async () => {
    target = createDemoTarget({ secrets: [secret] });
    ({ url: base, server } = await listen(target));
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("covers every scenario in the library", () => {
    expect(Object.keys(NAIVE_MUST_FAIL).sort()).toEqual(library.map((s) => s.slug).sort());
  });

  describe.each(library.map((s) => [s.slug, s] as const))("%s", (slug, scenario) => {
    it("FAILS on the naive handler, for the intended reason", async () => {
      const report = await runScenario(scenario.definitionYaml, base, "naive");
      expect(report.run.status, explain(report)).toBe("failed");
      expect(failedKinds(report), explain(report)).toEqual(
        expect.arrayContaining(NAIVE_MUST_FAIL[slug]!),
      );
      expect(report.target.handler).toBe("naive");
      expect(report.faults.every((f) => f.realised)).toBe(true);
    }, 45_000);

    it("PASSES on the idempotent handler", async () => {
      const report = await runScenario(scenario.definitionYaml, base, "idempotent");
      expect(report.run.status, explain(report)).toBe("passed");
      expect(report.assertions.every((a) => a.status === "pass")).toBe(true);
      expect(report.faults.every((f) => f.realised)).toBe(true);
    }, 45_000);
  });

  it("the attempt log matches what the target says arrived", async () => {
    const report = await runScenario(
      library.find((s) => s.slug === "booking-partial-refund")!.definitionYaml,
      base,
      "naive",
    );
    const arrivals = target.arrivals.filter((a) => a.runId === report.run.id);
    expect(arrivals.map((a) => a.step)).toEqual(report.timeline.map((t) => t.step));
    expect(arrivals.map((a) => a.forcedStatus ?? 200)).toEqual(
      report.timeline.map((t) => t.status),
    );
    const webhookIds = new Set(report.steps.map((s) => s.webhook_id));
    expect(arrivals.every((a) => webhookIds.has(a.webhookId))).toBe(true);
  }, 45_000);

  it("a duplicate really carries the same webhook-id, signed separately", async () => {
    const report = await runScenario(
      library.find((s) => s.slug === "payment-duplicate-captured")!.definitionYaml,
      base,
      "idempotent",
    );
    const arrivals = target.arrivals.filter(
      (a) => a.runId === report.run.id && a.step === "captured",
    );
    expect(arrivals).toHaveLength(2);
    expect(arrivals[0]!.webhookId).toBe(arrivals[1]!.webhookId);
    expect(arrivals.map((a) => a.arrival)).toEqual([1, 2]);
    const rows = report.steps.find((s) => s.id === "captured")!.deliveries;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.delivery_id).not.toBe(rows[1]!.delivery_id);
  }, 45_000);

  it("a reorder really arrives out of order", async () => {
    const report = await runScenario(
      library.find((s) => s.slug === "booking-cancel-before-confirm")!.definitionYaml,
      base,
      "idempotent",
    );
    const order = target.arrivals.filter((a) => a.runId === report.run.id).map((a) => a.step);
    expect(order).toEqual(["created", "cancelled", "confirmed"]);
  }, 45_000);
});

const CUSTOM = (faults: string, handlerNote = "") => `
version: 1
slug: custom${handlerNote}
name: Custom
difficulty: beginner
provider: payments
seed: 1
entities:
  - { id: order, kind: payment, amount_minor: 1000, currency: INR }
timeline:
  - { id: authorized, emit: payment.authorized, entity: order }
  - id: captured
    emit: payment.captured
    entity: order
    faults: ${faults}
assertions:
  - no_double_credit: { entity: order }
  - exactly_once_effect: { entity: order }
`;

describe("faults through the real engine", () => {
  let target: DemoTarget;
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const wrongKey = new IdempotentHandler();
    const seen = new Set<string>();
    target = createDemoTarget({
      secrets: [secret],
      handlers: {
        ignoring: new IdempotentHandler(),
        lying: { apply: () => undefined, state: () => ({ entities: {} }) },
        // A planted bug: looks idempotent, but dedupes on entity and type instead of webhook-id.
        wrongkey: {
          apply: (event) => {
            const key = `${event.murphy!.entity_id}:${event.type}`;
            if (seen.has(key)) return;
            seen.add(key);
            wrongKey.apply(event);
          },
          state: (runId) => wrongKey.state(runId),
        },
      },
      targetOptions: { ignoring: { obeyFaults: false } },
    });
    ({ url: base, server } = await listen(target));
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("respond_with: the target answers as told, the worker retries, then it goes through", async () => {
    const report = await runScenario(CUSTOM("{ respond_with: [503, 429] }"), base, "idempotent");
    expect(report.run.status, explain(report)).toBe("passed");
    const attempts = report.steps.find((s) => s.id === "captured")!.deliveries[0]!.attempts;
    expect(attempts.map((a) => a.status)).toEqual([503, 429, 200]);
    expect(report.faults[0]).toMatchObject({
      kind: "respond_with",
      realised_by: "target",
      realised: true,
    });
  }, 45_000);

  it("drop with the request lost: the handler sees it once, so even naive passes", async () => {
    const report = await runScenario(
      CUSTOM("{ drop_then_redeliver: { lost: request } }"),
      base,
      "naive",
    );
    expect(report.run.status, explain(report)).toBe("passed");
    const attempts = report.steps.find((s) => s.id === "captured")!.deliveries[0]!.attempts;
    expect(attempts.map((a) => a.status)).toEqual([503, 200]);
  }, 45_000);

  it("delay: the step really goes later", async () => {
    const report = await runScenario(CUSTOM("{ delay_ms: 2000 }"), base, "idempotent");
    expect(report.run.status, explain(report)).toBe("passed");
    const fault = report.faults[0]!;
    expect(fault).toMatchObject({ kind: "delay", realised_by: "engine", realised: true });
    const attempt = report.steps.find((s) => s.id === "captured")!.deliveries[0]!.attempts[0]!;
    // Step 2's slot is at 500 ms after the lead; 2000 * 0.2 = 400 ms more.
    expect(attempt.at_ms).toBeGreaterThanOrEqual(800);
  }, 45_000);

  describe("tests of the tests", () => {
    it("a target that ignores response faults is errored, not passed", async () => {
      const report = await runScenario(
        CUSTOM("{ drop_then_redeliver: { lost: response } }"),
        base,
        "ignoring",
      );
      expect(report.run.status, explain(report)).toBe("errored");
      expect(report.run.reason).toMatch(/proves nothing/);
      expect(report.faults[0]!.evidence).toMatch(/did not obey/);
    }, 45_000);

    it("a handler with a planted bug is caught: deduping on the wrong key loses a refund", async () => {
      const partial = library.find((s) => s.slug === "booking-partial-refund")!;
      const report = await runScenario(partial.definitionYaml, base, "wrongkey");
      expect(report.run.status, explain(report)).toBe("failed");
      expect(failedKinds(report)).toContain("exactly_once_effect");
      expect(report.run.reason).toMatch(/Balance is 350000, expected 300000/);
    }, 45_000);

    it("a target that reports nothing fails, rather than passing by default", async () => {
      const report = await runScenario(CUSTOM("{ delay_ms: 1 }", "-lying"), base, "lying");
      expect(report.run.status, explain(report)).toBe("failed");
      expect(report.assertions[0]!.reason).toMatch(/reported nothing/);
    }, 45_000);

    it("a target with the wrong secret never gets through, and the run is errored", async () => {
      const elsewhere = createDemoTarget({ secrets: [generateSigningSecret()] });
      const other = await listen(elsewhere);
      try {
        const report = await runScenario(CUSTOM("{ delay_ms: 1 }"), other.url, "idempotent");
        expect(report.run.status, explain(report)).toBe("errored");
        expect(report.run.reason).toMatch(/never got through.*401.*secret/);
      } finally {
        await new Promise((resolve) => other.server.close(resolve));
      }
    }, 45_000);
  });
});

describe("hard rules", () => {
  it("hosted mode blocks a localhost target and its state, so the run is errored", async () => {
    await worker.stop(1_000);
    const hosted = startWorker("hosted");
    try {
      const target = createDemoTarget({ secrets: [secret] });
      const { url, server } = await listen(target);
      const yaml = CUSTOM("{ delay_ms: 1 }", "-hosted");
      const scenario = parseScenario(yaml);
      const saved = await repo.scenarios.save(projectId, {
        slug: scenario.slug,
        name: scenario.name,
        difficulty: scenario.difficulty,
        definitionYaml: yaml,
      });
      const endpoint = await repo.endpoints.create(projectId, {
        url: `${url}/naive`,
        eventFilter: ["__murphy_simulation__"],
        secretEnc: encryptSecret(secret, key),
      });
      const plan = compile(scenario, {
        runId: randomUUID(),
        timeScale: TIME_SCALE,
        retrySchedule: RETRY_SCHEDULE,
      });
      await repo.runs.start(
        projectId,
        planToRunInput(plan, {
          scenarioId: saved.id,
          endpointId: endpoint.id,
          targetLabel: "naive",
          stateUrl: `${url}/naive/state`,
        }),
      );
      await expect
        .poll(
          async () => {
            await finishRunsOnce({ repo, runs, mode: "hosted" });
            return (await repo.runs.get(projectId, plan.run_id))?.status;
          },
          { timeout: 20_000, interval: 50 },
        )
        .toBe("errored");
      expect(target.arrivals).toEqual([]);
      const run = await repo.runs.get(projectId, plan.run_id);
      expect(JSON.stringify(run!.report as JsonObject)).toMatch(/ssrf|blocked|never got through/i);
      await new Promise((resolve) => server.close(resolve));
    } finally {
      await hosted.stop(1_000);
      worker = startWorker();
    }
  }, 45_000);

  it("simulated traffic does not touch another project's endpoints", async () => {
    const other = (await repo.projects.create({ name: "other" })).id;
    const theirs = await repo.endpoints.create(other, {
      url: "https://example.com/hooks",
      secretEnc: randomBytes(48),
    });
    const target = createDemoTarget({ secrets: [secret] });
    const { url, server } = await listen(target);
    await runScenario(CUSTOM("{ delay_ms: 1 }", "-isolated"), url, "naive");
    await new Promise((resolve) => server.close(resolve));
    expect(await db.prisma.delivery.count({ where: { endpointId: theirs.id } })).toBe(0);
    expect(await db.prisma.delivery.count({ where: { projectId: other } })).toBe(0);
  }, 45_000);
});
