export type EndpointStatus = "active" | "disabled" | "paused";
export type DeliveryStatus =
  "pending" | "in_flight" | "succeeded" | "failed" | "dead" | "cancelled";
export type ProjectPlan = "free" | "edu";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ProjectRecord {
  id: string;
  name: string;
  ownerUserId: string | null;
  plan: ProjectPlan;
  createdAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  projectId: string;
  keyPrefix: string;
  keyHash: Buffer;
  createdAt: Date;
  revokedAt: Date | null;
}

/** An endpoint as exposed outside the db package. The encrypted secret is never included. */
export interface EndpointRecord {
  id: string;
  projectId: string;
  url: string;
  description: string | null;
  eventFilter: string[];
  status: EndpointStatus;
  consecutiveFailures: number;
  disabledAt: Date | null;
  createdAt: Date;
}

export interface CreateEndpointInput {
  url: string;
  description?: string | null;
  eventFilter?: string[];
  secretEnc: Buffer;
  status?: EndpointStatus;
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  eventFilter?: string[];
  status?: EndpointStatus;
}

export interface DeliveryRecord {
  id: string;
  eventId: string;
  endpointId: string;
  projectId: string;
  status: DeliveryStatus;
  attemptCount: number;
  clientErrorCount: number;
  nextAttemptAt: Date;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface DeliveryAttemptRecord {
  id: string;
  attemptNo: number;
  startedAt: Date;
  durationMs: number | null;
  requestHeaders: JsonValue;
  responseStatus: number | null;
  responseBodySnippet: string | null;
  error: string | null;
}

export interface DeliveryWithAttempts extends DeliveryRecord {
  attempts: DeliveryAttemptRecord[];
}

/** Statuses a delivery can be replayed from. */
export type ReplayableStatus = "succeeded" | "failed" | "dead";
export const REPLAYABLE_STATUSES: readonly ReplayableStatus[] = ["succeeded", "failed", "dead"];

/** Maximum deliveries replayed by one bulk call. */
export const BULK_REPLAY_CAP = 1000;

export interface DeliveryListFilter {
  status?: DeliveryStatus;
  endpointId?: string;
  eventId?: string;
  /** Page size, 1..100. */
  limit: number;
  /** Keyset cursor from a previous page. */
  cursor?: DeliveryCursor;
}

/** Position after the last row of a page, ordered by (created_at, id) descending. */
export interface DeliveryCursor {
  createdAt: Date;
  id: string;
}

export interface DeliveryPage {
  data: DeliveryRecord[];
  nextCursor: DeliveryCursor | null;
}

export type ReplayResult =
  | { outcome: "replayed"; delivery: DeliveryRecord }
  | { outcome: "not_found" }
  | { outcome: "in_progress"; status: DeliveryStatus }
  | { outcome: "endpoint_deleted" };

export interface BulkReplayFilter {
  statuses: readonly ReplayableStatus[];
  endpointId?: string;
  /** created_at >= from */
  from?: Date;
  /** created_at < to */
  to?: Date;
}

export interface EventRecord {
  id: string;
  projectId: string;
  type: string;
  payload: JsonValue;
  idempotencyKey: string;
  createdAt: Date;
}

export interface EventWithDeliveries extends EventRecord {
  deliveries: DeliveryRecord[];
}

export interface AcceptEventInput {
  type: string;
  payload: JsonObject;
  idempotencyKey: string;
  /** SHA-256 hex of canonical JSON of { type, payload }. */
  requestHash: string;
}

export type AcceptEventResult =
  | { outcome: "created"; eventId: string; deliveries: number }
  | { outcome: "replayed"; eventId: string; deliveries: number }
  | { outcome: "conflict"; eventId: string };
