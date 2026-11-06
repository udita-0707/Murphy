import { z } from "zod";

/**
 * Run report, schema version 1. The dashboard and share page read this, so changing a field's meaning
 * or removing one needs a new version. Adding an optional field does not. See docs/run-report-schema.md.
 */
export const REPORT_SCHEMA_VERSION = 1;

const effectsSchema = z.object({
  credit: z.number(),
  booking: z.number(),
  refund: z.number(),
  hold: z.number(),
});

const entityResultSchema = z.object({
  state: z.string(),
  balance_minor: z.number(),
  effects: effectsSchema,
});

const attemptSchema = z.object({
  attempt_no: z.number().int(),
  started_at: z.string(),
  /** Milliseconds since the run started. */
  at_ms: z.number().int(),
  duration_ms: z.number().int().nullable(),
  status: z.number().int().nullable(),
  error: z.string().nullable(),
});

export const runReportSchema = z.object({
  schema_version: z.literal(REPORT_SCHEMA_VERSION),
  run: z.object({
    id: z.string(),
    /** passed: every assertion held. failed: one did not. errored: the run proves nothing, see reason. */
    status: z.enum(["passed", "failed", "errored"]),
    reason: z.string().nullable(),
    seed: z.number().int(),
    started_at: z.string(),
    finished_at: z.string(),
    duration_ms: z.number().int(),
  }),
  scenario: z.object({
    slug: z.string(),
    name: z.string(),
    difficulty: z.string(),
    provider: z.string(),
    /** What payloads resemble, such as "Razorpay-style". They are not exact copies. */
    provider_label: z.string(),
  }),
  target: z.object({
    /** A readable name for what was tested, such as "naive". */
    handler: z.string().nullable(),
    endpoint_id: z.string(),
  }),
  summary: z.object({
    assertions_passed: z.number().int(),
    assertions_failed: z.number().int(),
    faults_planned: z.number().int(),
    faults_realised: z.number().int(),
    deliveries: z.number().int(),
    attempts: z.number().int(),
  }),
  assertions: z.array(
    z.object({
      kind: z.string(),
      entity: z.string(),
      status: z.enum(["pass", "fail", "not_evaluated"]),
      reason: z.string(),
    }),
  ),
  faults: z.array(
    z.object({
      step: z.string(),
      kind: z.string(),
      /** engine: Murphy did this alone. target: it happened only because the target cooperated. */
      realised_by: z.enum(["engine", "target"]),
      detail: z.string(),
      realised: z.boolean(),
      evidence: z.string(),
    }),
  ),
  /** In the provider's logical order. */
  steps: z.array(
    z.object({
      id: z.string(),
      index: z.number().int(),
      event_type: z.string(),
      entity: z.string(),
      provider_entity_id: z.string(),
      event_id: z.string().nullable(),
      webhook_id: z.string().nullable(),
      planned_offsets_ms: z.array(z.number().int()),
      fault_kinds: z.array(z.string()),
      deliveries: z.array(
        z.object({
          delivery_id: z.string(),
          status: z.string(),
          attempts: z.array(attemptSchema),
        }),
      ),
    }),
  ),
  /** Every attempt in the order it really started. */
  timeline: z.array(
    z.object({
      at_ms: z.number().int(),
      step: z.string(),
      event_type: z.string(),
      delivery_id: z.string(),
      attempt_no: z.number().int(),
      status: z.number().int().nullable(),
      error: z.string().nullable(),
    }),
  ),
  entities: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      provider_id: z.string(),
      expected: entityResultSchema,
      /** What the target reported, or null if it reported nothing. */
      actual: entityResultSchema.nullable(),
    }),
  ),
  limits: z.array(z.string()),
});

export type RunReport = z.infer<typeof runReportSchema>;

/** The state endpoint's answer. Unknown fields are ignored, and missing effects count as zero. */
export const targetStateSchema = z.object({
  entities: z.record(
    z.string(),
    z.object({
      state: z.string(),
      balance_minor: z.number().default(0),
      effects: z
        .object({
          credit: z.number().default(0),
          booking: z.number().default(0),
          refund: z.number().default(0),
          hold: z.number().default(0),
        })
        .default({ credit: 0, booking: 0, refund: 0, hold: 0 }),
    }),
  ),
});

export type ReportedTargetState = z.infer<typeof targetStateSchema>;

export const REPORT_LIMITS: readonly string[] = [
  "Payloads resemble the named provider's shape. They are not exact copies, so a handler can pass here and still meet a field it does not expect in production.",
  "The target's final state is what the target itself reported. Murphy cannot see inside it, so a wrong state endpoint gives a wrong result.",
  "A pass means this handler survived these faults, in this run. It does not prove the handler is correct for others, or under concurrent delivery on several servers.",
];

/** Markdown for people. Everything in it comes from the report. */
export function renderReport(report: RunReport): string {
  const { run, scenario, target, summary } = report;
  const verdict = run.status.toUpperCase();
  const lines: string[] = [
    `# ${verdict}: ${scenario.name}`,
    "",
    run.reason ? `**${run.reason}**` : `**All ${summary.assertions_passed} assertions held.**`,
    "",
    "| | |",
    "| --- | --- |",
    `| Handler | ${target.handler ?? "not named"} |`,
    `| Scenario | \`${scenario.slug}\` (${scenario.difficulty}) |`,
    `| Provider | ${scenario.provider_label} |`,
    `| Seed | ${run.seed} |`,
    `| Run | \`${run.id}\` |`,
    `| Duration | ${(run.duration_ms / 1000).toFixed(1)} s |`,
    `| Traffic | ${summary.deliveries} deliveries, ${summary.attempts} attempts, all sent by the real delivery worker |`,
    "",
    "## Assertions",
    "",
    "| Result | Assertion | Entity | Why |",
    "| --- | --- | --- | --- |",
    ...report.assertions.map(
      (a) =>
        `| ${a.status === "not_evaluated" ? "NOT EVALUATED" : a.status.toUpperCase()} | ${a.kind} | ${a.entity} | ${cell(a.reason)} |`,
    ),
    "",
    "## Faults injected",
    "",
  ];

  if (report.faults.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "**Engine** faults came from Murphy's real delivery worker alone. **Target** faults only happen because the target cooperated by obeying the signed `_murphy` block.",
      "",
      "| Step | Fault | Realised by | What it does | Happened? | Evidence |",
      "| --- | --- | --- | --- | --- | --- |",
      ...report.faults.map(
        (f) =>
          `| ${f.step} | ${f.kind} | ${f.realised_by === "engine" ? "Engine" : "Target"} | ${cell(f.detail)} | ${f.realised ? "Yes" : "**No**"} | ${cell(f.evidence)} |`,
      ),
      "",
    );
  }

  lines.push(
    "## Timeline",
    "",
    "Every attempt, in the order it really started.",
    "",
    "| At | Step | Event | Attempt | Result |",
    "| --- | --- | --- | --- | --- |",
    ...report.timeline.map(
      (t) =>
        `| ${(t.at_ms / 1000).toFixed(2)} s | ${t.step} | ${t.event_type} | ${t.attempt_no} | ${t.status ?? cell(t.error ?? "no response")} |`,
    ),
    "",
    "## Final state",
    "",
    "| Entity | Provider id | | State | Balance | Credit | Booking | Refund | Hold |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const e of report.entities) {
    const row = (label: string, r: RunReport["entities"][number]["expected"] | null) =>
      r
        ? `| ${e.id} | \`${e.provider_id}\` | ${label} | ${r.state} | ${r.balance_minor} | ${r.effects.credit} | ${r.effects.booking} | ${r.effects.refund} | ${r.effects.hold} |`
        : `| ${e.id} | \`${e.provider_id}\` | ${label} | not reported | | | | | |`;
    lines.push(row("expected", e.expected), row("reported by target", e.actual));
  }
  lines.push("", "## What this does not prove", "", ...report.limits.map((l) => `- ${l}`), "");
  return lines.join("\n");
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}
