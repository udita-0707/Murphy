import { planHash } from "./plan.js";
import type { ChaosPlan, ControlRecord, InvariantResult, RunResult } from "./types.js";

export interface RunMeta {
  seed: number;
  plan: ChaosPlan;
  startedAt: string;
  durationSeconds: number;
  drainSeconds: number;
  settings: Record<string, string>;
  control: ControlRecord[];
  loadStartedAt: number;
  sabotage: string | null;
  sabotageDetail: string | null;
  unexpectedExits: string[];
  drainTimedOut: boolean;
}

export interface FullReport {
  meta: Omit<RunMeta, "plan" | "control"> & {
    planHash: string;
    events: number;
    workers: number;
    retryScheduleMs: number[];
    requestTimeoutMs: number;
    leaseMs: number;
  };
  timeline: { atSeconds: number; action: string; target: string | null; detail: string | null }[];
  result: RunResult;
}

export function buildReport(meta: RunMeta, result: RunResult): FullReport {
  const { plan, control, ...rest } = meta;
  return {
    meta: {
      ...rest,
      planHash: planHash(plan),
      events: plan.events.length,
      workers: plan.workers,
      retryScheduleMs: plan.retryScheduleMs,
      requestTimeoutMs: plan.requestTimeoutMs,
      leaseMs: plan.leaseMs,
    },
    timeline: control
      .filter((c) => c.phase === "start")
      .map((c) => ({
        atSeconds: round((c.t - meta.loadStartedAt) / 1000),
        action: c.action,
        target: c.target ?? null,
        detail: c.detail ?? null,
      })),
    result,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

const FAULT_NAMES: Record<string, string> = {
  kill_worker: "SIGKILL worker",
  respawn_worker: "Start replacement worker",
  kill_api: "SIGKILL API",
  respawn_api: "Restart API",
  restart_postgres: "Kill and restart Postgres",
  disable_endpoint: "Disable endpoint",
  enable_endpoint: "Re-enable endpoint",
  delete_endpoint: "Delete endpoint",
  sabotage: "SABOTAGE (deliberate damage)",
};

const STATUS = { pass: "PASS", fail: "**FAIL**", info: "INFO" } as const;

function escape(text: string): string {
  return text.replaceAll("|", "\\|");
}

function verdict(report: FullReport): string {
  const { result, meta } = report;
  if (result.passed) return "PASS";
  if (result.invariants.some((i) => i.status === "fail")) return "FAIL";
  if (result.vacuous)
    return "VACUOUS (a fault had no visible effect, so this run proves too little)";
  if (meta.drainTimedOut) return "FAIL (work did not finish before the drain timeout)";
  if (meta.unexpectedExits.length > 0) return "FAIL (a process exited unexpectedly)";
  return "FAIL";
}

export const READING_GUIDE = `Murphy promises that an event it has accepted is never lost. To test that, this harness runs the
real API, real workers and a separate flaky receiver against a real Postgres, sends thousands of
events, and breaks things on purpose while they are being delivered: it kills workers and the API
with SIGKILL, kills and restarts Postgres, and has the receiver fail in several ways. When things
go quiet, it compares what each independent party recorded.

**Where the evidence comes from.** A check that compares the database with itself proves little,
so each invariant names its sources:

- **Client log:** what the load generator sent and every 202 it actually received.
- **Control log:** what the harness did on purpose (kills, deletes, disables).
- **Receiver log:** what a separate receiver process saw, written the moment each request arrived.
- **Database:** the final state of Murphy's tables.
- **Audit history:** every change to every delivery row during the run, recorded by database
  triggers that are installed only for chaos runs.`;

export const LIMITS = `- **Disabled and paused endpoints get no new deliveries.** An event accepted while an endpoint is
  disabled, paused or deleted creates no delivery for it, and is not sent when the endpoint is
  re-enabled. This is intended behaviour, shown in the 202's \`deliveries\` count. So the precise
  claim is: every delivery *created* for an accepted event reaches a terminal state or is parked.
  The "no delivery, by design" count above says how often this happened.
- **One machine.** All processes and Postgres ran on one laptop, with no network between them.
- **Process crashes, not power loss.** Postgres was killed and recovered from its write-ahead log,
  but the operating system and disk kept running, so this does not test what \`fsync\` protects
  against when the power goes.
- **No network partitions, and the receiver was never killed.**
- **Compressed time.** Retries used a schedule of about 20 seconds instead of over 10 hours, with
  the same number of attempts. Timing bugs that only appear over hours would not show here.
- **Replay is not exercised here.** It is covered by the model-based property tests
  (\`apps/worker/test/state-machine.property.test.ts\`) instead.
- **Redis is not tested** because nothing uses it (the brief's "drop Redis" fault does not apply).
- **Latency is measured under chaos**, on a laptop, with faults injected. It is not a benchmark.
- **A seed fixes the inputs, not the outcome.** The workload, fault plan and every receiver decision
  are the same for a seed, but process timing is not, so counts vary between runs of one seed.`;

function invariantTable(invariants: InvariantResult[]): string {
  const rows = invariants.map(
    (i) =>
      `| ${i.id} | ${escape(i.title)} | ${escape(i.sources)} | ${i.checked.toLocaleString("en-US")} | ${i.violations} | ${STATUS[i.status]} |`,
  );
  return [
    "| # | Invariant | Sources compared | Checked | Violations | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map((c) => escape(c)).join(" | ")} |`),
  ].join("\n");
}

const ms = (n: number | null) => (n === null ? "n/a" : `${n.toLocaleString("en-US")} ms`);
const num = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

/** The body of one run's report, shared by the run's own file and the docs sample. */
export function runSections(report: FullReport): string {
  const { result, meta, timeline } = report;
  const c = result.counts;
  const notes = result.invariants.filter((i) => i.note);
  const failures = result.invariants.filter((i) => i.status === "fail");
  const statuses = ["succeeded", "dead", "cancelled", "pending", "in_flight", "failed"];
  const profiles = Object.keys(result.deliveriesByProfile).sort();

  const sections = [
    `## Invariants

${invariantTable(result.invariants)}

${notes.map((i) => `- **${i.id}:** ${i.note}`).join("\n")}`,
  ];

  if (failures.length > 0) {
    sections.push(`## What failed

${failures
  .map((i) => `**${i.id}: ${i.title}**\n\n${i.examples.map((e) => `- \`${e}\``).join("\n")}`)
  .join("\n\n")}`);
  }

  sections.push(
    `## Run

${table(
  ["Setting", "Value"],
  [
    ["Seed", String(meta.seed)],
    ["Plan hash (same seed and options give the same hash)", meta.planHash],
    ["Started", meta.startedAt],
    ["Duration", `${meta.durationSeconds} s, of which draining ${meta.drainSeconds} s`],
    ["Workers", String(meta.workers)],
    ["Retry schedule (compressed)", `${meta.retryScheduleMs.join(", ")} ms`],
    ["Request timeout / lease", `${meta.requestTimeoutMs} ms / ${meta.leaseMs} ms`],
    ...Object.entries(meta.settings).map(([k, v]) => [`Postgres ${k}`, v]),
  ],
)}`,
    `## Faults injected

Times are seconds from the start of the load.

${table(
  ["At", "Action", "Target", "Detail"],
  timeline.map((t) => [
    `${t.atSeconds} s`,
    FAULT_NAMES[t.action] ?? t.action,
    t.target ?? "",
    t.detail ?? "",
  ]),
)}`,
    `## Did the faults have an effect?

A fault that hits nothing proves nothing. If any line here is "no", the run is reported as vacuous
and fails.

${table(
  ["Effect", "Seen", "Evidence"],
  result.effects.map((e) => [e.name, e.ok ? "yes" : "**no**", e.evidence]),
)}

Expired leases by worker, including workers that survived but lost Postgres mid-delivery: ${
      Object.entries(result.killedWorkerLeases)
        .sort()
        .map(([w, n]) => `${w}: ${n}`)
        .join(", ") || "none"
    }.`,
    `## Counts

${table(
  ["What", "Count"],
  [
    ["Events planned", num(c.eventsPlanned)],
    ["Events that got a 202", num(c.eventsAcked)],
    ["Events the client gave up on", num(c.clientGaveUp)],
    ["Events in the database", num(c.eventsInDatabase)],
    ["Failed client requests, then retried", num(c.clientRequestErrors)],
    ["Deliberate resends with the same key", num(c.deliberateResends)],
    ["202s answered from an existing event", num(c.replayedAcks)],
    ["Deliveries", num(c.deliveries)],
    ["No delivery, by design (endpoint out of service)", num(c.noDeliveryByDesign)],
    ["Attempt rows logged", num(c.attemptRows)],
    ["Requests that reached the receiver", num(c.receiverArrivals)],
    ["Expired leases reaped", num(c.leasesReaped)],
    ["Delivery row changes in the audit history", num(c.auditRowsChecked)],
  ],
)}

Final state of deliveries, by what the endpoint was doing. \`pending\` here means parked.

${table(
  ["Endpoint behaviour", ...statuses],
  profiles.map((p) => [p, ...statuses.map((s) => num(result.deliveriesByProfile[p]?.[s]))]),
)}`,
    `## Duplicates

A receiver with no deduplication processed **${num(result.duplicates.total)}** duplicates. A receiver
that deduplicates on \`webhook-id\` processed each message once (I10).

${table(
  ["Why the message was sent again", "Duplicates"],
  Object.entries(result.duplicates.byCause)
    .sort((a, b) => b[1] - a[1])
    .map(([cause, n]) => [cause, num(n)]),
)}`,
    `## Delivery latency

From the client's first send to the receiver's log, so Murphy's own timestamps are not involved.
Measured during the faults with compressed retries, so this is not a benchmark.

${table(
  ["Measure", "Count", "p50", "p95"],
  Object.entries(result.latency).map(([name, p]) => [name, num(p.count), ms(p.p50), ms(p.p95)]),
)}`,
  );
  return sections.join("\n\n");
}

export function renderRunReport(report: FullReport): string {
  const { meta, result } = report;
  const sabotage = meta.sabotage
    ? `\n\n> **This run was deliberately damaged** (sabotage mode \`${meta.sabotage}\`): ${meta.sabotageDetail}. Failures below are the point of the run.`
    : "";
  return `# Murphy chaos report

**Result: ${verdict(report)}.** Seed ${meta.seed}: ${num(result.counts.eventsAcked)} events accepted, ${num(result.counts.deliveries)} deliveries, ${num(result.duplicates.total)} duplicates seen by a naive receiver.${sabotage}

Run it again with \`pnpm chaos --seed ${meta.seed} --events ${meta.events}\`.

## How to read this

${READING_GUIDE}

${runSections(report)}

## What this does not prove

${LIMITS}
`;
}

export { verdict };
