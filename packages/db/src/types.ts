export type EndpointStatus = "active" | "disabled" | "paused";
export type DeliveryStatus = "pending" | "in_flight" | "succeeded" | "failed" | "dead";
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
  nextAttemptAt: Date;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
  completedAt: Date | null;
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
