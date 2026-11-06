import type { MurphyMode } from "@murphy/core";
import type { JsonObject, Repository, RunDelivery, RunRecord } from "@murphy/db";
import {
  compile,
  planToRunInput,
  renderReport,
  runReportSchema,
  type RunPlan,
} from "@murphy/simulator";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, notFound } from "../errors.js";
import { projectIdOf } from "../middleware/auth.js";
import { parse, uuidParam } from "../validation.js";
import { assertUrlAllowed } from "./endpoints.js";
import { parseScenarioOrThrow } from "./scenarios.js";

const createRunBody = z.strictObject({
  scenario_id: z.uuid(),
  endpoint_id: z.uuid(),
  /** Where the worker reads the target's final state. */
  state_url: z.url().max(2048),
  /** A readable name for what is being tested, such as "naive". */
  target_label: z.string().min(1).max(100).optional(),
  /** Defaults to the scenario's own seed. */
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

const listRunsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function serializeDelivery(row: RunDelivery, startedAt: Date | null) {
  return {
    delivery_id: row.deliveryId,
    event_id: row.eventId,
    step: row.step,
    status: row.status,
    attempts: row.attempts.map((a) => ({
      attempt_no: a.attemptNo,
      started_at: a.startedAt.toISOString(),
      at_ms: startedAt ? a.startedAt.getTime() - startedAt.getTime() : null,
      duration_ms: a.durationMs,
      status: a.responseStatus,
      error: a.error,
    })),
  };
}

function serializeRun(run: RunRecord, deliveries: RunDelivery[]) {
  const plan = run.plan as unknown as RunPlan;
  return {
    id: run.id,
    scenario_id: run.scenarioId,
    endpoint_id: run.endpointId,
    status: run.status,
    seed: run.seed,
    target_label: run.targetLabel,
    state_url: run.stateUrl,
    scenario: { slug: plan.scenario.slug, name: plan.scenario.name },
    started_at: run.startedAt?.toISOString() ?? null,
    finished_at: run.finishedAt?.toISOString() ?? null,
    deadline_at: run.deadlineAt?.toISOString() ?? null,
    report_ready: run.report !== null,
    steps: plan.steps.map((step) => ({
      id: step.id,
      index: step.index,
      event_type: step.emit,
      entity: step.entity,
      planned_offsets_ms: step.due_offsets_ms,
      fault_kinds: step.faults.map((f) => f.kind),
    })),
    deliveries: deliveries.map((d) => serializeDelivery(d, run.startedAt)),
  };
}

export function runsRouter(repo: Repository, mode: MurphyMode): Router {
  const router = Router();

  /**
   * Starts a run. It only writes rows: the real worker sends them, and finishes the run when they are
   * done (ADR 011, ADR 012). The state URL obeys the same rules as an endpoint URL in this mode.
   */
  router.post("/", async (req, res) => {
    const projectId = projectIdOf(res);
    const body = parse(createRunBody, req.body);
    assertUrlAllowed(body.state_url, mode);

    const scenario = await repo.scenarios.get(projectId, body.scenario_id);
    if (!scenario) throw notFound("scenario");

    const runId = randomUUID();
    const plan = compile(parseScenarioOrThrow(scenario.definitionYaml), {
      runId,
      seed: body.seed,
    });
    const result = await repo.runs.start(
      projectId,
      planToRunInput(plan, {
        scenarioId: scenario.id,
        endpointId: body.endpoint_id,
        targetLabel: body.target_label ?? null,
        stateUrl: body.state_url,
      }),
    );
    switch (result.outcome) {
      case "scenario_not_found":
        throw notFound("scenario");
      case "endpoint_not_available":
        throw new ApiError(
          409,
          "endpoint_not_available",
          "the endpoint does not exist, or it is deleted, disabled or paused",
        );
      case "started":
        res.status(202).json({
          id: runId,
          status: "running",
          seed: plan.seed,
          steps: plan.steps.length,
        });
    }
  });

  /** Recent runs, newest first, with no plans or reports. */
  router.get("/", async (req, res) => {
    const { limit } = parse(listRunsQuery, req.query);
    const runs = await repo.runs.list(projectIdOf(res), limit);
    res.json({
      data: runs.map((run) => ({
        id: run.id,
        scenario_id: run.scenarioId,
        status: run.status,
        target_label: run.targetLabel,
        finished_at: run.finishedAt?.toISOString() ?? null,
        created_at: run.createdAt.toISOString(),
      })),
    });
  });

  router.get("/:id", async (req, res) => {
    const projectId = projectIdOf(res);
    const params = uuidParam.safeParse(req.params);
    if (!params.success) throw notFound("run");
    const run = await repo.runs.get(projectId, params.data.id);
    if (!run) throw notFound("run");
    res.json(serializeRun(run, await repo.runs.deliveries(projectId, run.id)));
  });

  /** The report as JSON (schema version 1), or as markdown with `?format=md`. */
  router.get("/:id/report", async (req, res) => {
    const params = uuidParam.safeParse(req.params);
    if (!params.success) throw notFound("run");
    const run = await repo.runs.get(projectIdOf(res), params.data.id);
    if (!run) throw notFound("run");
    if (run.report === null) {
      throw new ApiError(409, "report_not_ready", "the run has not finished yet");
    }
    if (req.query.format === "md") {
      const report = runReportSchema.parse(run.report);
      res.type("text/markdown").send(renderReport(report));
      return;
    }
    res.json(run.report as JsonObject);
  });

  return router;
}
