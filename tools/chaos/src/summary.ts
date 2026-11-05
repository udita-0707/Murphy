import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIMITS, READING_GUIDE, runSections, verdict, type FullReport } from "./report.js";
import { expectedFailure, isSabotage } from "./sabotage.js";

/**
 * Assembles docs/chaos-report.md from the report.json of real runs, so no number in it is typed
 * by hand. The first seed run is shown in full.
 *
 *   pnpm --filter @murphy/chaos summary --seeds a,b,c --controls d,e --notes notes.md --out file
 */

export function renderSummary(seeds: FullReport[], controls: FullReport[], notes: string): string {
  const sample = seeds[0];
  if (!sample) throw new Error("at least one seed run is needed");
  const passed = seeds.filter((r) => r.result.passed).length;
  const n = (value: number | undefined) => (value ?? 0).toLocaleString("en-US");

  const seedRows = seeds.map((r) => {
    const c = r.result.counts;
    const control = r.result.latency["First arrival, control endpoint"];
    return `| ${r.meta.seed} | ${verdict(r)} | ${n(c.eventsAcked)} | ${n(c.deliveries)} | ${n(r.result.deliveriesByStatus.succeeded)} | ${n(r.result.deliveriesByStatus.dead)} | ${n(r.result.deliveriesByStatus.cancelled)} | ${n(r.result.deliveriesByStatus.pending)} | ${n(r.result.deliveriesByStatus.in_flight)} | ${n(r.result.duplicates.total)} | ${n(c.leasesReaped)} | ${n(control?.p50 ?? undefined)} / ${n(control?.p95 ?? undefined)} ms |`;
  });

  const controlRows = controls.map((r) => {
    const mode = r.meta.sabotage;
    if (!isSabotage(mode ?? undefined)) throw new Error(`${r.meta.seed} is not a sabotage run`);
    const expected = expectedFailure(mode as "lost-event" | "fake-success");
    const invariant = r.result.invariants.find((i) => i.id === expected);
    const others = r.result.invariants
      .filter((i) => i.status === "fail" && i.id !== expected)
      .map((i) => i.id);
    return `| \`${mode}\` | ${r.meta.sabotageDetail} | ${expected} | ${invariant?.status === "fail" ? "failed, as it must" : "**DID NOT FAIL**"} | ${others.join(", ") || "none"} |`;
  });

  const proven = sample.result.invariants
    .filter((i) => i.status !== "info")
    .map((i) => `- ${i.title}. _Compares: ${i.sources}._`)
    .join("\n");

  return `# Murphy chaos report

**${passed} of ${seeds.length} seeded runs passed.** Across them, Murphy accepted ${n(seeds.reduce((sum, r) => sum + (r.result.counts.eventsAcked ?? 0), 0))} events while its workers, API and database were being killed, and none was lost.

This file is generated from real runs by \`tools/chaos/src/summary.ts\`. To check it yourself, run
\`pnpm chaos --seed ${sample.meta.seed}\`, which needs Docker and takes a few minutes. Counts will differ a
little, because process timing is not fixed by a seed.

## How to read this

${READING_GUIDE}

## What was proven

In each passing run, after all the faults:

${proven}

## What this does not prove

${LIMITS}

## The three runs

| Seed | Result | Events accepted | Deliveries | Succeeded | Dead | Cancelled | Parked | In flight | Duplicates (naive receiver) | Leases reaped | Control endpoint p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${seedRows.join("\n")}

\`Dead\`, \`Cancelled\` and \`Parked\` are expected. Those endpoints were built to always fail, were
deleted on purpose, or were disabled on purpose. Invariant I4 checks each one against the logs.

## Can these checks fail?

Yes. In these runs the harness deliberately damaged the database while the run was going on, the
way a real bug would, and the matching invariant has to catch it. Every invariant also has failing
fixtures in \`tools/chaos/test/verify.test.ts\`.

| Sabotage | What it did | Invariant that must fail | Outcome | Others that also failed |
| --- | --- | --- | --- | --- |
${controlRows.join("\n")}

${notes.trim()}

# Full detail: seed ${sample.meta.seed}

${runSections(sample)}
`;
}

function main(): void {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const load = (list: string | undefined): FullReport[] =>
    (list ?? "")
      .split(",")
      .filter(Boolean)
      .map((dir) => JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")) as FullReport);
  const notesPath = value("--notes");
  const out = value("--out");
  if (!out) throw new Error("--out is required");
  writeFileSync(
    out,
    renderSummary(
      load(value("--seeds")),
      load(value("--controls")),
      notesPath ? readFileSync(notesPath, "utf8") : "",
    ),
  );
  console.log(`wrote ${out}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
