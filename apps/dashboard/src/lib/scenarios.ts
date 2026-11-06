export interface ScenarioRow {
  id: string;
  slug: string;
  name: string;
  difficulty: string;
  builtin: boolean;
  summary: {
    provider: string;
    provider_label: string;
    description: string | null;
    steps: number;
    faults: { step: string; kind: string; realised_by: "engine" | "target" }[];
    needs_target_cooperation: boolean;
  } | null;
  detail?: {
    seed: number;
    steps: { id: string; event_type: string; entity: string; faults: string[] }[];
    assertions: { kind: string; entity: string }[];
  } | null;
}

export interface RunRow {
  id: string;
  scenario_id: string;
  status: string;
  target_label: string | null;
}

export type HandlerChoice = "both" | "naive" | "idempotent";

/** Repeated at real speed against both handlers (docs/handover/phase-4.md). The rest need a run first. */
export const DEMO_PICKS = ["booking-duplicate-confirmation", "booking-cancel-before-confirm"];

/** The demo picks first, then built-ins, then the rest, each by name. */
export function orderScenarios(rows: readonly ScenarioRow[]): ScenarioRow[] {
  const rank = (row: ScenarioRow) => {
    const pick = DEMO_PICKS.indexOf(row.slug);
    if (pick >= 0) return pick;
    return row.builtin ? DEMO_PICKS.length : DEMO_PICKS.length + 1;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Each fault kind once, because a scenario can use one on several steps. */
export function distinctFaults(row: ScenarioRow): string[] {
  return [...new Set(row.summary?.faults.map((f) => f.kind) ?? [])];
}

export function cooperationNote(row: ScenarioRow): string {
  if (!row.summary) return "Could not read this scenario.";
  if (row.summary.faults.length === 0) return "No faults.";
  const kinds = [
    ...new Set(row.summary.faults.filter((f) => f.realised_by === "target").map((f) => f.kind)),
  ];
  if (kinds.length === 0) return "No target cooperation needed.";
  return `Needs your target to obey the signed block.`;
}

/** The plain consequence: every library description ends on what goes wrong. */
export function whatBreaks(row: ScenarioRow): string {
  const description = row.summary?.description?.trim();
  if (!description) return "";
  // A full stop only ends a sentence before a space: "payment.captured" is one word.
  return description.split(/(?<=\.)\s+/).at(-1) ?? "";
}

export interface ScenarioFilters {
  search: string;
  provider: string;
  fault: string;
  difficulty: string;
  noTargetNeeded: boolean;
}

export const NO_FILTERS: ScenarioFilters = {
  search: "",
  provider: "all",
  fault: "all",
  difficulty: "all",
  noTargetNeeded: false,
};

export function filtersActive(f: ScenarioFilters): boolean {
  return (
    f.search.trim() !== "" ||
    f.provider !== "all" ||
    f.fault !== "all" ||
    f.difficulty !== "all" ||
    f.noTargetNeeded
  );
}

export function matchesFilters(row: ScenarioRow, f: ScenarioFilters): boolean {
  const search = f.search.trim().toLowerCase();
  if (search) {
    const text = `${row.name} ${row.slug} ${row.summary?.description ?? ""}`.toLowerCase();
    if (!text.includes(search)) return false;
  }
  if (f.provider !== "all" && row.summary?.provider !== f.provider) return false;
  if (f.fault !== "all" && !distinctFaults(row).includes(f.fault)) return false;
  if (f.difficulty !== "all" && row.difficulty !== f.difficulty) return false;
  if (f.noTargetNeeded && row.summary?.needs_target_cooperation) return false;
  return true;
}

export type SurvivalState = "survived" | "failed" | "errored" | "running" | "not_run";

/**
 * The latest result per scenario for one handler. "Both" reads the idempotent side, the one that is meant to survive.
 * Errored proves nothing, so only a pass counts as survived.
 */
export function survival(
  scenarios: readonly ScenarioRow[],
  runs: readonly RunRow[],
  handler: HandlerChoice,
): { row: ScenarioRow; state: SurvivalState }[] {
  const label = handler === "naive" ? "naive" : "idempotent";
  return scenarios.map((row) => {
    // Runs arrive newest first.
    const run = runs.find((r) => r.scenario_id === row.id && r.target_label === label);
    const state: SurvivalState = !run
      ? "not_run"
      : run.status === "passed"
        ? "survived"
        : run.status === "failed"
          ? "failed"
          : run.status === "errored"
            ? "errored"
            : "running";
    return { row, state };
  });
}

/** A CI step using the real CLI, whose exit code is 0 passed, 1 failed, 2 errored. */
export function ciSnippet(row: ScenarioRow): string {
  const file = row.builtin
    ? `packages/simulator/scenarios/${row.slug}.yaml`
    : `scenarios/${row.slug}.yaml`;
  return `- name: "Murphy: ${row.slug}"
  env:
    MURPHY_API_KEY: \${{ secrets.MURPHY_API_KEY }}
    MURPHY_API_URL: \${{ vars.MURPHY_API_URL }}
  # Fails the job on FAIL (exit 1) and on ERRORED (exit 2).
  run: >
    pnpm -s murphy run ${file}
    --endpoint \${{ vars.MURPHY_ENDPOINT_ID }}
    --state-url \${{ vars.MURPHY_STATE_URL }}`;
}

export interface PairResponse {
  naive: PairSideResponse;
  idempotent: PairSideResponse;
}
export type PairSideResponse =
  | { outcome: "started"; runId: string; seed: number }
  | { outcome: "did_not_start"; reason: string };

/** A comparison is a URL (ADR 013). A side that did not start carries its reason there. */
export function compareUrl(pair: PairResponse): string {
  const params = new URLSearchParams();
  for (const name of ["naive", "idempotent"] as const) {
    const side = pair[name];
    if (side.outcome === "started") params.set(name, side.runId);
    else params.set(`${name}_error`, side.reason);
  }
  return `/compare?${params.toString()}`;
}
