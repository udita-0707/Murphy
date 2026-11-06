import {
  canonicalHash,
  RETRY_SCHEDULE_MS,
  type MurphyBlock,
  type MurphyForcedResponse,
} from "@murphy/core";
import type { Effects, JsonObject } from "./model.js";
import { type Scenario, type ScenarioAssertion, type ScenarioStep } from "./scenario.js";
import { getProvider, simulate } from "./simulate.js";

/** Time before the first step is due, so the whole run is committed before anything is sent. */
const LEAD_MS = 1_000;
/** Slack on top of the longest possible run before a run is declared stuck. */
const DEADLINE_GRACE_MS = 60_000;
/** Largest upward jitter on a retry delay, from `RETRY_JITTER` in @murphy/core. */
const RETRY_JITTER_MARGIN = 1.25;

export type FaultKind = "delay" | "reorder" | "duplicate" | "drop_then_redeliver" | "respond_with";

/**
 * Who makes a fault happen. `engine` faults come from the real worker alone. `target` faults only
 * happen if the target obeys the signed `_murphy` block (ADR 011).
 */
export type FaultRealisedBy = "engine" | "target";

export interface PlannedFault {
  kind: FaultKind;
  realised_by: FaultRealisedBy;
  /** Readable, for reports. */
  detail: string;
  delay_ms?: number;
  before_step?: string;
  lost?: "request" | "response";
  statuses?: number[];
}

export interface PlannedStep {
  id: string;
  /** Position in the provider's logical order. */
  index: number;
  emit: string;
  entity: string;
  provider_id: string;
  /** The full body sent to the target, with the `_murphy` block. */
  payload: JsonObject;
  /** One delivery row per entry: the first is the step, any others are duplicates. */
  due_offsets_ms: number[];
  faults: PlannedFault[];
}

export interface PlannedEntity {
  id: string;
  kind: string;
  provider_id: string;
  amount_minor: number;
  currency: string;
  expected: { state: string; balance_minor: number; effects: Effects };
}

/** A compiled run. Stored with the run, so later edits to a scenario cannot change it. */
export interface RunPlan {
  plan_version: 1;
  run_id: string;
  seed: number;
  scenario: { slug: string; name: string; difficulty: string; provider: string; label: string };
  steps: PlannedStep[];
  entities: PlannedEntity[];
  assertions: ScenarioAssertion[];
  /** How long after the start the run counts as stuck. */
  deadline_offset_ms: number;
}

export interface CompileOptions {
  runId: string;
  /** Defaults to the scenario's own seed. */
  seed?: number;
  /** Multiplies every planned wait. Tests use it to run faster than the default gap. */
  timeScale?: number;
  /** The worker's retry schedule, if it is not the default. */
  retrySchedule?: readonly number[];
}

function forcedResponses(step: ScenarioStep): MurphyForcedResponse[] {
  const { drop_then_redeliver: drop, respond_with: statuses } = step.faults ?? {};
  if (drop) return [{ status: 503, run_handler: drop.lost === "response" }];
  return (statuses ?? []).map((status) => ({ status, run_handler: false }));
}

function plannedFaults(step: ScenarioStep, scale: (ms: number) => number): PlannedFault[] {
  const out: PlannedFault[] = [];
  const f = step.faults ?? {};
  if (f.delay_ms !== undefined) {
    const delay = scale(f.delay_ms);
    out.push({
      kind: "delay",
      realised_by: "engine",
      delay_ms: delay,
      detail: `Sent ${delay} ms later than planned`,
    });
  }
  if (f.reorder_before !== undefined) {
    out.push({
      kind: "reorder",
      realised_by: "engine",
      before_step: f.reorder_before,
      detail: `Sent before step "${f.reorder_before}", which logically comes first`,
    });
  }
  if (f.duplicate) {
    const delay = scale(f.duplicate.after_ms);
    out.push({
      kind: "duplicate",
      realised_by: "engine",
      delay_ms: delay,
      detail: `Sent again ${delay} ms later, with the same webhook-id`,
    });
  }
  if (f.drop_then_redeliver) {
    const lost = f.drop_then_redeliver.lost;
    out.push({
      kind: "drop_then_redeliver",
      realised_by: "target",
      lost,
      detail:
        lost === "response"
          ? "First attempt reaches the handler, but its reply is lost, so Murphy retries"
          : "First attempt never reaches the handler, so Murphy retries",
    });
  }
  if (f.respond_with) {
    out.push({
      kind: "respond_with",
      realised_by: "target",
      statuses: f.respond_with,
      detail: `Target answers ${f.respond_with.join(", ")} first, without running the handler`,
    });
  }
  return out;
}

export interface ScenarioSummary {
  provider: string;
  /** What payloads resemble, such as "Razorpay-style". Payloads are not exact copies. */
  provider_label: string;
  description: string | null;
  steps: number;
  faults: { step: string; kind: PlannedFault["kind"]; realised_by: FaultRealisedBy }[];
  /** True when a fault only happens if the target obeys the signed `_murphy` block. */
  needs_target_cooperation: boolean;
}

/** What a scenario does, for a list, without compiling a run. */
export function summariseScenario(scenario: Scenario): ScenarioSummary {
  const provider = getProvider(scenario.provider);
  if (!provider) throw new Error(`unknown provider "${scenario.provider}"`);
  const faults = scenario.timeline.flatMap((step) =>
    plannedFaults(step, (ms) => ms).map((fault) => ({
      step: step.id,
      kind: fault.kind,
      realised_by: fault.realised_by,
    })),
  );
  return {
    provider: provider.name,
    provider_label: provider.label,
    description: scenario.description ?? null,
    steps: scenario.timeline.length,
    faults,
    needs_target_cooperation: faults.some((f) => f.realised_by === "target"),
  };
}

export interface ScenarioDetail {
  seed: number;
  /** In the order they are really sent, so a reorder shows. */
  steps: { id: string; event_type: string; entity: string; faults: PlannedFault["kind"][] }[];
  assertions: { kind: string; entity: string }[];
}

/** The steps and assertions of a scenario, for showing it without compiling a run. */
export function describeScenario(scenario: Scenario): ScenarioDetail {
  return {
    seed: scenario.seed,
    steps: sendOrder(scenario.timeline).map((step) => ({
      id: step.id,
      event_type: step.emit,
      entity: step.entity,
      faults: plannedFaults(step, (ms) => ms).map((fault) => fault.kind),
    })),
    assertions: scenario.assertions.map((assertion) => {
      const [kind, value] = Object.entries(assertion)[0] as [string, { entity: string }];
      return { kind, entity: value.entity };
    }),
  };
}

/** The order steps are sent in: logical order, with each reordered step moved before its target. */
function sendOrder(timeline: readonly ScenarioStep[]): ScenarioStep[] {
  const order = [...timeline];
  for (const step of timeline) {
    const before = step.faults?.reorder_before;
    if (before === undefined) continue;
    order.splice(order.indexOf(step), 1);
    order.splice(
      order.findIndex((s) => s.id === before),
      0,
      step,
    );
  }
  return order;
}

/**
 * Compiles a validated scenario into a run plan. Pure: the same scenario, seed and run id give the
 * same plan. Faults only change when a row is due or what the signed block asks of the target, so the
 * real worker sends, signs, retries and logs all of it.
 */
export function compile(scenario: Scenario, options: CompileOptions): RunPlan {
  const provider = getProvider(scenario.provider);
  if (!provider) throw new Error(`unknown provider "${scenario.provider}"`);
  const seed = options.seed ?? scenario.seed;
  const factor = options.timeScale ?? 1;
  const scale = (ms: number) => Math.max(1, Math.round(ms * factor));
  const simulation = simulate(provider, scenario.entities, scenario.timeline, seed);
  const positions = new Map(sendOrder(scenario.timeline).map((step, i) => [step.id, i]));
  const gap = scale(scenario.step_gap_ms);
  const lead = scale(LEAD_MS);
  const schedule = options.retrySchedule ?? RETRY_SCHEDULE_MS;

  let latest = 0;
  const steps = scenario.timeline.map((step, index): PlannedStep => {
    const event = simulation.events[index]!;
    const forced = forcedResponses(step);
    const first =
      lead +
      positions.get(step.id)! * gap +
      (step.faults?.delay_ms ? scale(step.faults.delay_ms) : 0);
    const offsets = [first];
    if (step.faults?.duplicate) offsets.push(first + scale(step.faults.duplicate.after_ms));

    const retries = forced.reduce((sum, _f, i) => sum + (schedule[i] ?? 0), 0);
    latest = Math.max(latest, offsets[offsets.length - 1]! + retries * RETRY_JITTER_MARGIN);

    const block: MurphyBlock = {
      simulated: true,
      version: 1,
      run_id: options.runId,
      scenario: scenario.slug,
      step: step.id,
      event: step.emit,
      entity_id: event.providerId,
      ...(forced.length > 0 ? { forced_responses: forced } : {}),
    };
    return {
      id: step.id,
      index,
      emit: step.emit,
      entity: step.entity,
      provider_id: event.providerId,
      payload: { ...event.payload, _murphy: block as unknown as JsonObject },
      due_offsets_ms: offsets,
      faults: plannedFaults(step, scale),
    };
  });

  return {
    plan_version: 1,
    run_id: options.runId,
    seed,
    scenario: {
      slug: scenario.slug,
      name: scenario.name,
      difficulty: scenario.difficulty,
      provider: provider.name,
      label: provider.label,
    },
    steps,
    entities: simulation.entities.map((e) => ({
      id: e.id,
      kind: e.kind,
      provider_id: e.providerId,
      amount_minor: e.amount_minor,
      currency: e.currency,
      expected: {
        state: e.ledger.state,
        balance_minor: e.ledger.balanceMinor,
        effects: e.ledger.effects,
      },
    })),
    assertions: scenario.assertions,
    deadline_offset_ms: Math.round(latest) + DEADLINE_GRACE_MS,
  };
}

/** What the database needs to start this plan. Faults are already in the rows' due times and bodies. */
export function planToRunInput(
  plan: RunPlan,
  target: {
    scenarioId: string;
    endpointId: string;
    targetLabel: string | null;
    stateUrl: string | null;
  },
) {
  return {
    id: plan.run_id,
    ...target,
    seed: plan.seed,
    plan: plan as unknown as JsonObject,
    deadlineOffsetMs: plan.deadline_offset_ms,
    entities: plan.entities.map((e) => ({
      kind: e.kind,
      externalId: e.provider_id,
      state: e.expected.state,
    })),
    steps: plan.steps.map((step) => ({
      eventType: step.emit,
      payload: step.payload,
      idempotencyKey: `sim:${plan.run_id}:${step.id}`,
      requestHash: canonicalHash({ type: step.emit, payload: step.payload }),
      dueOffsetsMs: step.due_offsets_ms,
    })),
  };
}
