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
  /** True for simulator traffic only, false to leave it out, unset for everything. */
  simulated?: boolean;
  /** Page size, 1..100. */
  limit: number;
  /** Keyset cursor from a previous page. */
  cursor?: DeliveryCursor;
}

export interface DeliveryListRow extends DeliveryRecord {
  eventType: string;
  simulated: boolean;
}

export interface EventListFilter {
  simulated?: boolean;
  /** Page size, 1..100. */
  limit: number;
  cursor?: DeliveryCursor;
}

export interface EventListRow {
  id: string;
  type: string;
  idempotencyKey: string;
  createdAt: Date;
  scenarioRunId: string | null;
  deliveryCount: number;
}

export interface EventPage {
  data: EventListRow[];
  nextCursor: DeliveryCursor | null;
}

/** Position after the last row of a page, ordered by (created_at, id) descending. */
export interface DeliveryCursor {
  createdAt: Date;
  id: string;
}

export interface DeliveryPage {
  data: DeliveryListRow[];
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
  /** Set only on simulated events (ADR 011). */
  scenarioRunId: string | null;
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

export type ScenarioDifficulty = "beginner" | "intermediate" | "advanced";
export type ScenarioRunStatus = "pending" | "running" | "passed" | "failed" | "errored";

export interface ScenarioRecord {
  id: string;
  /** Null for a public built-in. */
  projectId: string | null;
  slug: string;
  name: string;
  difficulty: ScenarioDifficulty;
  definitionYaml: string;
  isPublic: boolean;
  createdAt: Date;
}

export interface SaveScenarioInput {
  slug: string;
  name: string;
  difficulty: ScenarioDifficulty;
  definitionYaml: string;
}

export interface RunStepInput {
  eventType: string;
  payload: JsonObject;
  idempotencyKey: string;
  requestHash: string;
  /** One delivery row per offset, due this long after the run starts. */
  dueOffsetsMs: number[];
}

export interface StartRunInput {
  id: string;
  scenarioId: string;
  endpointId: string;
  seed: number;
  targetLabel: string | null;
  stateUrl: string | null;
  plan: JsonObject;
  deadlineOffsetMs: number;
  entities: { kind: string; externalId: string; state: string }[];
  steps: RunStepInput[];
}

export type StartRunResult =
  | { outcome: "started"; runId: string }
  | { outcome: "scenario_not_found" }
  | { outcome: "endpoint_not_available" };

export interface RunRecord {
  id: string;
  projectId: string;
  scenarioId: string;
  endpointId: string;
  status: ScenarioRunStatus;
  seed: number | null;
  targetLabel: string | null;
  stateUrl: string | null;
  plan: JsonValue | null;
  report: JsonValue | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  deadlineAt: Date | null;
  createdAt: Date;
}

export interface RunAttempt {
  attemptNo: number;
  startedAt: Date;
  durationMs: number | null;
  responseStatus: number | null;
  error: string | null;
}

/** One delivery row of a run with its attempts, for live timelines and evaluation. */
export interface RunDelivery {
  deliveryId: string;
  eventId: string;
  /** The step, from the signed block. */
  step: string;
  status: DeliveryStatus;
  createdAt: Date;
  attempts: RunAttempt[];
}

/** A run ready to be evaluated: all its rows are finished, or its deadline passed. */
export interface FinishableRun {
  id: string;
  projectId: string;
  deadlinePassed: boolean;
}
