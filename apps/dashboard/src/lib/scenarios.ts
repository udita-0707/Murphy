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
}

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
