import { SIMULATION_FILTER } from "@murphy/client";

export interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  event_filter: string[];
  status: string;
  created_at: string;
}

export interface EventRow {
  id: string;
  type: string;
  idempotency_key: string;
  created_at: string;
  simulated: boolean;
  scenario_run_id: string | null;
  deliveries: number;
}

export interface DeliveryRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
  event_type?: string;
  simulated?: boolean;
}

export interface DeliveryDetail extends DeliveryRow {
  attempts: {
    id: string;
    attempt_no: number;
    started_at: string;
    duration_ms: number | null;
    response_status: number | null;
    response_body_snippet: string | null;
    error: string | null;
  }[];
}

export interface EventDetail {
  id: string;
  type: string;
  payload: unknown;
  idempotency_key: string;
  created_at: string;
  simulated: boolean;
  scenario_run_id: string | null;
  deliveries: DeliveryRow[];
}

/** A run's throwaway endpoints only ever receive simulator traffic (ADR 011). */
export const isSimulatedEndpoint = (endpoint: EndpointRow) =>
  endpoint.event_filter.includes(SIMULATION_FILTER);

/** Only these can be replayed. The API checks again. */
export const canReplay = (status: string) => ["succeeded", "failed", "dead"].includes(status);

export const withSimulatedFilter = (path: string, hide: boolean) =>
  hide ? `${path}${path.includes("?") ? "&" : "?"}simulated=false` : path;

export function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace("T", " ").slice(0, 19);
}

export function lastResult(row: Pick<DeliveryRow, "last_status_code" | "last_error">): string {
  if (row.last_status_code !== null) return String(row.last_status_code);
  return row.last_error ?? "";
}
