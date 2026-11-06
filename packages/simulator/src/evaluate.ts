import type { PlannedEntity, PlannedFault, PlannedStep, RunPlan } from "./compile.js";
import type { Effects } from "./model.js";
import {
  REPORT_LIMITS,
  REPORT_SCHEMA_VERSION,
  runReportSchema,
  type ReportedTargetState,
  type RunReport,
} from "./report.js";
import { assertionKind } from "./scenario.js";

/** Attempts use the worker's clock and the run's start uses the database's, which can differ a little. */
const CLOCK_TOLERANCE_MS = 1_000;

export interface EvidenceAttempt {
  attemptNo: number;
  startedAt: Date;
  durationMs: number | null;
  responseStatus: number | null;
  error: string | null;
}

export interface EvidenceDelivery {
  deliveryId: string;
  eventId: string;
  step: string;
  status: string;
  attempts: EvidenceAttempt[];
}

export type StateResult = { ok: true; state: ReportedTargetState } | { ok: false; error: string };

export interface EvaluateInput {
  plan: RunPlan;
  endpointId: string;
  targetLabel: string | null;
  startedAt: Date;
  finishedAt: Date;
  deadlinePassed: boolean;
  deliveries: readonly EvidenceDelivery[];
  state: StateResult;
}

const is2xx = (status: number | null) => status !== null && status >= 200 && status < 300;

function firstAttemptMs(rows: readonly EvidenceDelivery[]): number | null {
  const times = rows.flatMap((r) => r.attempts.map((a) => a.startedAt.getTime()));
  return times.length > 0 ? Math.min(...times) : null;
}

/** Did this fault really happen? Answered from the attempt log, not from the plan. */
function checkFault(
  fault: PlannedFault,
  step: PlannedStep,
  byStep: Map<string, EvidenceDelivery[]>,
  startedAt: Date,
): { realised: boolean; evidence: string } {
  const rows = byStep.get(step.id) ?? [];
  const statuses = rows.flatMap((r) => r.attempts.map((a) => a.responseStatus));
  const seen = statuses.map((s) => s ?? "no response").join(", ") || "no attempts";

  switch (fault.kind) {
    case "delay": {
      const first = firstAttemptMs(rows);
      const due = step.due_offsets_ms[0]!;
      if (first === null) return { realised: false, evidence: "It was never sent" };
      const at = first - startedAt.getTime();
      return {
        realised: at >= due - CLOCK_TOLERANCE_MS,
        evidence: `First attempt at ${at} ms, planned for ${due} ms or later`,
      };
    }
    case "reorder": {
      const mine = firstAttemptMs(rows);
      const theirs = firstAttemptMs(byStep.get(fault.before_step!) ?? []);
      if (mine === null || theirs === null) {
        return { realised: false, evidence: "One of the two steps was never sent" };
      }
      return mine < theirs
        ? {
            realised: true,
            evidence: `Arrived ${theirs - mine} ms before "${fault.before_step}"`,
          }
        : {
            realised: false,
            evidence: `Arrived ${mine - theirs} ms after "${fault.before_step}", so timing cancelled the reorder`,
          };
    }
    case "duplicate": {
      const accepted = rows.filter((r) => r.attempts.some((a) => is2xx(a.responseStatus))).length;
      return {
        realised: accepted >= 2,
        evidence: `${accepted} deliveries with the same webhook-id got a 2xx`,
      };
    }
    case "drop_then_redeliver": {
      const attempts = rows[0]?.attempts ?? [];
      const realised =
        attempts.length >= 2 &&
        attempts[0]!.responseStatus === 503 &&
        is2xx(attempts[attempts.length - 1]!.responseStatus);
      return realised
        ? { realised, evidence: `Attempts answered: ${seen}` }
        : {
            realised,
            evidence: `Attempts answered: ${seen}. Expected 503 and then a 2xx, so the target did not obey the _murphy block`,
          };
    }
    case "respond_with": {
      const attempts = rows[0]?.attempts ?? [];
      const wanted = fault.statuses ?? [];
      const realised =
        wanted.every((status, i) => attempts[i]?.responseStatus === status) &&
        is2xx(attempts[wanted.length]?.responseStatus ?? null);
      return realised
        ? { realised, evidence: `Attempts answered: ${seen}` }
        : {
            realised,
            evidence: `Attempts answered: ${seen}. Expected ${wanted.join(", ")} and then a 2xx, so the target did not obey the _murphy block`,
          };
    }
  }
}

const EFFECT_NAMES: Record<keyof Effects, string> = {
  credit: "credit",
  booking: "booking",
  refund: "refund",
  hold: "hold",
};

/** Lists each way the target's result differs from the expected one. Empty means it matches. */
function differences(entity: PlannedEntity, state: ReportedTargetState): string[] {
  const actual = state.entities[entity.provider_id];
  if (!actual) return [`the target reported nothing for ${entity.provider_id}`];
  const out: string[] = [];
  if (actual.state !== entity.expected.state) {
    out.push(`state is "${actual.state}", expected "${entity.expected.state}"`);
  }
  if (actual.balance_minor !== entity.expected.balance_minor) {
    out.push(`balance is ${actual.balance_minor}, expected ${entity.expected.balance_minor}`);
  }
  for (const key of Object.keys(EFFECT_NAMES) as (keyof Effects)[]) {
    if (actual.effects[key] !== entity.expected.effects[key]) {
      out.push(`${key} effect is ${actual.effects[key]}, expected ${entity.expected.effects[key]}`);
    }
  }
  return out;
}

function evaluateAssertions(plan: RunPlan, state: StateResult): RunReport["assertions"] {
  return plan.assertions.map((assertion) => {
    const kind = assertionKind(assertion);
    const args = Object.values(assertion)[0] as {
      entity: string;
      state?: string;
      balance_minor?: number;
    };
    const base = { kind, entity: args.entity };
    if (!state.ok) {
      return {
        ...base,
        status: "not_evaluated" as const,
        reason: "The target's state is not available",
      };
    }
    const entity = plan.entities.find((e) => e.id === args.entity)!;
    const actual = state.state.entities[entity.provider_id];
    const fail = (reason: string) => ({ ...base, status: "fail" as const, reason });
    const pass = (reason: string) => ({ ...base, status: "pass" as const, reason });
    if (!actual) return fail(`The target reported nothing for ${entity.provider_id}`);

    switch (kind) {
      case "no_double_credit": {
        const { credit } = actual.effects;
        const expected = entity.expected.effects.credit;
        return credit > expected
          ? fail(
              `Credited ${credit} times, expected ${expected}: the customer's money was counted twice`,
            )
          : pass(`Credited ${credit} time(s)`);
      }
      case "no_double_booking": {
        const { booking } = actual.effects;
        const expected = entity.expected.effects.booking;
        return booking > expected
          ? fail(
              `Holds ${booking} bookings, expected ${expected}: one reservation took more than it should`,
            )
          : pass(`Holds ${booking} booking(s)`);
      }
      case "final_state": {
        if (actual.state !== args.state) {
          return fail(`Ended in "${actual.state}", expected "${args.state}"`);
        }
        if (args.balance_minor !== undefined && actual.balance_minor !== args.balance_minor) {
          return fail(`Balance is ${actual.balance_minor}, expected ${args.balance_minor}`);
        }
        return pass(`Ended in "${actual.state}"`);
      }
      case "ordering_tolerated":
      case "exactly_once_effect": {
        const wrong = differences(entity, state.state);
        if (wrong.length > 0) return fail(capitalise(wrong.join("; ")));
        return pass(
          kind === "ordering_tolerated"
            ? "The result is correct even though events arrived out of order"
            : "Every effect was applied exactly as often as it should be",
        );
      }
    }
  });
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Builds the run's report from the plan and the evidence. Pure.
 *
 * A run only counts when it was a fair test. It is `errored`, proving nothing, if deliveries did not
 * finish, the target's state could not be read, or a planned fault did not really happen. Otherwise it
 * is `passed` or `failed` on its assertions.
 */
export function evaluateRun(input: EvaluateInput): RunReport {
  const { plan, deliveries, startedAt, finishedAt, state } = input;
  const byStep = new Map<string, EvidenceDelivery[]>();
  for (const row of deliveries) byStep.set(row.step, [...(byStep.get(row.step) ?? []), row]);
  const start = startedAt.getTime();

  const faults = plan.steps.flatMap((step) =>
    step.faults.map((fault) => ({
      step: step.id,
      kind: fault.kind,
      realised_by: fault.realised_by,
      detail: fault.detail,
      ...checkFault(fault, step, byStep, startedAt),
    })),
  );
  const assertions = evaluateAssertions(plan, state);

  const steps = plan.steps.map((step) => {
    const rows = byStep.get(step.id) ?? [];
    return {
      id: step.id,
      index: step.index,
      event_type: step.emit,
      entity: step.entity,
      provider_entity_id: step.provider_id,
      event_id: rows[0]?.eventId ?? null,
      webhook_id: rows[0] ? `msg_${rows[0].eventId}` : null,
      planned_offsets_ms: step.due_offsets_ms,
      fault_kinds: step.faults.map((f) => f.kind),
      deliveries: rows.map((row) => ({
        delivery_id: row.deliveryId,
        status: row.status,
        attempts: row.attempts.map((a) => ({
          attempt_no: a.attemptNo,
          started_at: a.startedAt.toISOString(),
          at_ms: a.startedAt.getTime() - start,
          duration_ms: a.durationMs,
          status: a.responseStatus,
          error: a.error,
        })),
      })),
    };
  });

  const timeline = steps
    .flatMap((step) =>
      step.deliveries.flatMap((row) =>
        row.attempts.map((a) => ({
          at_ms: a.at_ms,
          step: step.id,
          event_type: step.event_type,
          delivery_id: row.delivery_id,
          attempt_no: a.attempt_no,
          status: a.status,
          error: a.error,
        })),
      ),
    )
    .sort((a, b) => a.at_ms - b.at_ms);

  const unfinished = deliveries.filter((r) => r.status === "pending" || r.status === "in_flight");
  const notDelivered = deliveries.filter((r) => r.status === "dead" || r.status === "cancelled");
  const missedFaults = faults.filter((f) => !f.realised);
  const failed = assertions.filter((a) => a.status === "fail");

  let status: RunReport["run"]["status"];
  let reason: string | null = null;
  if (input.deadlinePassed && unfinished.length > 0) {
    status = "errored";
    reason = `The run was stuck: ${unfinished.length} deliveries had not finished by the deadline.`;
  } else if (notDelivered.length > 0) {
    const last = notDelivered[0]!.attempts.at(-1);
    const detail = last ? `, last answer: ${last.responseStatus ?? last.error ?? "none"}` : "";
    status = "errored";
    reason = `${notDelivered.length} deliveries never got through (${notDelivered[0]!.status}${detail}). Check that the target is running and has this endpoint's secret.`;
  } else if (!state.ok) {
    status = "errored";
    reason = `Could not read the target's state: ${state.error}`;
  } else if (missedFaults.length > 0) {
    status = "errored";
    reason = `This run proves nothing, because ${missedFaults.length} planned fault(s) did not happen: ${missedFaults
      .map((f) => `${f.kind} on "${f.step}"`)
      .join(", ")}.`;
  } else if (failed.length > 0) {
    status = "failed";
    reason = `${failed.length} of ${assertions.length} assertions failed. ${failed[0]!.reason}.`;
  } else {
    status = "passed";
  }

  const stateEntities = state.ok ? state.state.entities : {};
  return runReportSchema.parse({
    schema_version: REPORT_SCHEMA_VERSION,
    run: {
      id: plan.run_id,
      status,
      reason,
      seed: plan.seed,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - start,
    },
    scenario: {
      slug: plan.scenario.slug,
      name: plan.scenario.name,
      difficulty: plan.scenario.difficulty,
      provider: plan.scenario.provider,
      provider_label: plan.scenario.label,
    },
    target: { handler: input.targetLabel, endpoint_id: input.endpointId },
    summary: {
      assertions_passed: assertions.filter((a) => a.status === "pass").length,
      assertions_failed: failed.length,
      faults_planned: faults.length,
      faults_realised: faults.length - missedFaults.length,
      deliveries: deliveries.length,
      attempts: timeline.length,
    },
    assertions,
    faults,
    steps,
    timeline,
    entities: plan.entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      provider_id: e.provider_id,
      expected: e.expected,
      actual: stateEntities[e.provider_id] ?? null,
    })),
    limits: REPORT_LIMITS,
  });
}
