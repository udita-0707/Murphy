import { isRetryable } from "@murphy/core";
import { parseDocument } from "yaml";
import { z } from "zod";
import { getProvider, IllegalSequenceError, PROVIDERS, simulate } from "./simulate.js";

export const MAX_SCENARIO_BYTES = 64 * 1024;
export const MAX_STEPS = 50;
export const MAX_ENTITIES = 10;
/** Each listed failure waits for a real retry (5 s, then 30 s), so two is the most a run can bear. */
export const MAX_FORCED_RESPONSES = 2;
/** At most this many client errors are retried before a delivery goes dead (ADR 006). */
const RETRIED_CLIENT_ERRORS = new Set([400, 401, 403, 404]);

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, "use lowercase letters, digits, - and _");
const entityRef = z.object({ entity: z.string() }).strict();

const faultsSchema = z
  .object({
    delay_ms: z.number().int().min(1).max(120_000).optional(),
    duplicate: z
      .object({ after_ms: z.number().int().min(1).max(120_000).default(1_500) })
      .strict()
      .optional(),
    reorder_before: z.string().optional(),
    drop_then_redeliver: z
      .object({ lost: z.enum(["request", "response"]) })
      .strict()
      .optional(),
    respond_with: z.array(z.number().int()).min(1).max(MAX_FORCED_RESPONSES).optional(),
  })
  .strict();

const stepSchema = z
  .object({
    id: name,
    emit: z.string(),
    entity: z.string(),
    amount_minor: z.number().int().positive().optional(),
    faults: faultsSchema.optional(),
  })
  .strict();

const assertionSchema = z.union([
  z.object({ no_double_credit: entityRef }).strict(),
  z.object({ no_double_booking: entityRef }).strict(),
  z.object({ ordering_tolerated: entityRef }).strict(),
  z.object({ exactly_once_effect: entityRef }).strict(),
  z
    .object({
      final_state: z
        .object({
          entity: z.string(),
          state: z.string(),
          balance_minor: z.number().int().optional(),
        })
        .strict(),
    })
    .strict(),
]);

const scenarioSchema = z
  .object({
    version: z.literal(1),
    slug: name,
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).optional(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]),
    provider: z.string(),
    seed: z.number().int().min(0).max(2_147_483_647),
    /** Time between steps. Must stay above the worker's poll interval, or a reorder can miss. */
    step_gap_ms: z.number().int().min(100).max(60_000).default(1_500),
    entities: z
      .array(
        z
          .object({
            id: name,
            kind: z.string(),
            amount_minor: z.number().int().positive().max(100_000_000_000),
            currency: z.string().regex(/^[A-Z]{3}$/, "use a three-letter currency code"),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ENTITIES),
    timeline: z.array(stepSchema).min(1).max(MAX_STEPS),
    assertions: z.array(assertionSchema).min(1).max(50),
  })
  .strict();

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioStep = Scenario["timeline"][number];
export type ScenarioFaults = NonNullable<ScenarioStep["faults"]>;
export type ScenarioAssertion = Scenario["assertions"][number];
export type AssertionKind =
  | "no_double_credit"
  | "no_double_booking"
  | "ordering_tolerated"
  | "exactly_once_effect"
  | "final_state";

export interface ScenarioIssue {
  /** Where in the file, such as `timeline[3].faults.reorder_before`. Empty for the whole file. */
  path: string;
  message: string;
}

/** A scenario that cannot run. The message lists every problem, one per line. */
export class ScenarioError extends Error {
  constructor(readonly issues: ScenarioIssue[]) {
    super(
      "invalid scenario:\n" +
        issues.map((i) => `  ${i.path ? `${i.path}: ` : ""}${i.message}`).join("\n"),
    );
    this.name = "ScenarioError";
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/** The assertion's single kind and its arguments. */
export function assertionKind(assertion: ScenarioAssertion): AssertionKind {
  return Object.keys(assertion)[0] as AssertionKind;
}

/** Checks that need more than one field: references, fault combinations and the state machine. */
function crossCheck(scenario: Scenario): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  const entities = new Set(scenario.entities.map((e) => e.id));
  const provider = getProvider(scenario.provider);
  if (!provider) {
    return [
      {
        path: "provider",
        message: `unknown provider "${scenario.provider}" (use: ${Object.keys(PROVIDERS).join(", ")})`,
      },
    ];
  }
  if (entities.size !== scenario.entities.length) {
    issues.push({ path: "entities", message: "entity ids must be unique" });
  }

  const positions = new Map<string, number>();
  scenario.timeline.forEach((step, index) => {
    const path = `timeline[${index}]`;
    if (positions.has(step.id)) {
      issues.push({ path: `${path}.id`, message: `the step id "${step.id}" is used twice` });
    }
    positions.set(step.id, index);
    if (!entities.has(step.entity)) {
      issues.push({ path: `${path}.entity`, message: `no entity called "${step.entity}"` });
    }
  });

  scenario.timeline.forEach((step, index) => {
    const faults = step.faults;
    if (!faults) return;
    const path = `timeline[${index}].faults`;
    const responseFaults = [faults.drop_then_redeliver, faults.respond_with].filter(Boolean).length;

    if (responseFaults > 1) {
      issues.push({ path, message: "use drop_then_redeliver or respond_with, not both" });
    }
    if (faults.duplicate && responseFaults > 0) {
      issues.push({
        path,
        message:
          "a duplicate cannot be combined with a response fault: both copies share one webhook-id, so the target could not tell which arrival a forced response belongs to",
      });
    }
    if (faults.delay_ms && faults.reorder_before) {
      issues.push({
        path,
        message: "use delay_ms or reorder_before, not both: a delay can undo the reorder",
      });
    }
    if (faults.reorder_before !== undefined) {
      const before = positions.get(faults.reorder_before);
      const target = `${path}.reorder_before`;
      if (before === undefined) {
        issues.push({ path: target, message: `no step called "${faults.reorder_before}"` });
      } else if (before >= index) {
        issues.push({
          path: target,
          message: `"${faults.reorder_before}" does not come before "${step.id}" in the timeline, so this would not reorder anything`,
        });
      } else if (scenario.timeline[before]?.faults?.reorder_before) {
        issues.push({
          path: target,
          message: `"${faults.reorder_before}" is itself reordered, which makes the order ambiguous`,
        });
      }
    }
    faults.respond_with?.forEach((status, i) => {
      const at = `${path}.respond_with[${i}]`;
      if (status === 410) {
        issues.push({
          path: at,
          message: "410 is not allowed: it would really disable the endpoint and park the run",
        });
      } else if (!isRetryable(status) && !RETRIED_CLIENT_ERRORS.has(status)) {
        issues.push({
          path: at,
          message: `${status} is not retried, so the delivery would go dead and never reach the handler (use a 5xx, 408, 425, 429, 400, 401, 403 or 404)`,
        });
      }
    });
  });
  if (issues.length > 0) return issues;

  let simulation;
  try {
    simulation = simulate(provider, scenario.entities, scenario.timeline, scenario.seed);
  } catch (err) {
    if (err instanceof IllegalSequenceError) {
      return [{ path: `timeline[${err.stepIndex}].emit`, message: err.message }];
    }
    if (err instanceof Error) return [{ path: "entities", message: err.message }];
    throw err;
  }

  const finals = new Map(simulation.entities.map((e) => [e.id, e]));
  scenario.assertions.forEach((assertion, index) => {
    const kind = assertionKind(assertion);
    const args = Object.values(assertion)[0] as { entity: string };
    const path = `assertions[${index}].${kind}`;
    const final = finals.get(args.entity);
    if (!final) {
      issues.push({ path: `${path}.entity`, message: `no entity called "${args.entity}"` });
      return;
    }
    const steps = scenario.timeline.filter((s) => s.entity === args.entity);
    if (kind === "final_state") {
      const expected = (assertion as { final_state: { state: string; balance_minor?: number } })
        .final_state;
      if (expected.state !== final.ledger.state) {
        issues.push({
          path: `${path}.state`,
          message: `the timeline ends "${args.entity}" in state "${final.ledger.state}", not "${expected.state}"`,
        });
      }
      if (
        expected.balance_minor !== undefined &&
        expected.balance_minor !== final.ledger.balanceMinor
      ) {
        issues.push({
          path: `${path}.balance_minor`,
          message: `the timeline ends "${args.entity}" with a balance of ${final.ledger.balanceMinor}, not ${expected.balance_minor}`,
        });
      }
    }
    // An assertion that could never fail would be a false comfort, so it is an error.
    if (kind === "no_double_credit" && final.ledger.effects.credit === 0) {
      issues.push({
        path,
        message: `"${args.entity}" is never credited in this timeline, so this could never fail`,
      });
    }
    if (kind === "no_double_booking" && !steps.some((s) => s.emit === "reservation.confirmed")) {
      issues.push({
        path,
        message: `"${args.entity}" is never booked in this timeline, so this could never fail`,
      });
    }
    if (
      kind === "ordering_tolerated" &&
      !steps.some((s) => s.faults?.reorder_before || s.faults?.delay_ms)
    ) {
      issues.push({
        path,
        message: `no step of "${args.entity}" is reordered or delayed, so this could never fail`,
      });
    }
  });
  return issues;
}

/** Parses and fully validates a YAML scenario. Throws ScenarioError listing every problem. */
export function parseScenario(text: string): Scenario {
  if (Buffer.byteLength(text, "utf8") > MAX_SCENARIO_BYTES) {
    throw new ScenarioError([
      { path: "", message: `the file is larger than ${MAX_SCENARIO_BYTES} bytes` },
    ]);
  }
  const document = parseDocument(text, { merge: false });
  if (document.errors.length > 0) {
    throw new ScenarioError(
      document.errors.map((e) => ({ path: "", message: `not valid YAML: ${e.message}` })),
    );
  }
  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 10 });
  } catch (err) {
    throw new ScenarioError([{ path: "", message: `not valid YAML: ${String(err)}` }]);
  }
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioError(
      parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    );
  }
  const issues = crossCheck(parsed.data);
  if (issues.length > 0) throw new ScenarioError(issues);
  return parsed.data;
}
