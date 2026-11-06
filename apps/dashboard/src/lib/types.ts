import type { RunReport } from "@murphy/simulator";
import type { LiveDelivery } from "@murphy/client";

export type { RunReport };
export type Verdict = RunReport["run"]["status"];

/** `GET /v1/runs/:id`. */
export interface LiveRun {
  id: string;
  status: string;
  seed: number;
  target_label: string | null;
  scenario: { slug: string; name: string };
  started_at: string | null;
  finished_at: string | null;
  deadline_at: string | null;
  report_ready: boolean;
  steps: {
    id: string;
    index: number;
    event_type: string;
    entity: string;
    planned_offsets_ms: number[];
    fault_kinds: string[];
  }[];
  deliveries: (LiveDelivery & { event_id: string; status: string })[];
}

/** A report this dashboard can read. Unknown fields are ignored; an unknown version is refused (ADR 012). */
export function isReadableReport(value: unknown): value is RunReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schema_version?: unknown }).schema_version === 1
  );
}
