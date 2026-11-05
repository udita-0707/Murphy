export type Profile =
  | "control"
  | "flaky"
  | "slow"
  | "lost_ack"
  | "always_500"
  | "gone"
  | "toggled"
  | "parked"
  | "deleted";

export interface PlanEndpoint {
  key: string;
  projectKey: string;
  profile: Profile;
  /** Event types this endpoint receives; empty means all. */
  filter: string[];
}

export interface PlanEvent {
  seq: number;
  idempotencyKey: string;
  logicalId: string;
  projectKey: string;
  type: string;
  amount: number;
  /** When to send it, from the start of the load. */
  atMs: number;
  /** Send it again after the first 202, on purpose. */
  resend: boolean;
}

export type PlanFault =
  | { atMs: number; action: "kill_worker"; worker: number; respawnMs: number }
  | { atMs: number; action: "kill_api"; respawnMs: number }
  | { atMs: number; action: "restart_postgres" }
  | { atMs: number; action: "disable_endpoint"; endpoint: string }
  | { atMs: number; action: "enable_endpoint"; endpoint: string }
  | { atMs: number; action: "delete_endpoint"; endpoint: string };

export interface ChaosPlan {
  seed: number;
  workers: number;
  loadMs: number;
  retryScheduleMs: number[];
  requestTimeoutMs: number;
  leaseMs: number;
  /** The gone endpoint answers 410 after this many distinct messages. */
  goneAfter: number;
  projects: string[];
  endpoints: PlanEndpoint[];
  events: PlanEvent[];
  faults: PlanFault[];
}

export type ReceiverAction =
  | "ok"
  | "slow"
  | "hang"
  | "fail_500"
  | "process_then_500"
  | "process_then_reset"
  | "gone_410"
  | "bad_signature";

/** Written by the receiver process on receipt, before it acts. */
export interface ReceiverRecord {
  t: number;
  endpoint: string;
  webhookId: string;
  arrival: number;
  signatureValid: boolean;
  payloadHash: string;
  logicalId: string | null;
  projectKey: string | null;
  eventType: string | null;
  action: ReceiverAction;
  /** The handler's side effect ran. A naive receiver applies it every time this is true. */
  processed: boolean;
  /** An idempotent receiver, deduplicating on webhook-id, applied it this time. */
  idempotentApplied: boolean;
}

/** Written by the load generator. */
export type ClientRecord =
  | {
      kind: "send";
      t: number;
      key: string;
      logicalId: string;
      projectKey: string;
      type: string;
      payloadHash: string;
      try: number;
      deliberateResend: boolean;
    }
  | {
      kind: "ack";
      t: number;
      key: string;
      eventId: string;
      deliveries: number;
      replayed: boolean;
    }
  | { kind: "error"; t: number; key: string; detail: string }
  | { kind: "gave_up"; t: number; key: string };

/** Written by the harness for everything it does on purpose. */
export interface ControlRecord {
  t: number;
  action: string;
  phase: "start" | "done";
  target?: string;
  detail?: string;
}

export interface DbEvent {
  id: string;
  projectId: string;
  idempotencyKey: string;
  type: string;
  payloadHash: string;
}

export interface DbDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  projectId: string;
  status: string;
  attemptCount: number;
  reapCount: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  claimToken: string | null;
}

export interface DbEndpoint {
  id: string;
  status: string;
  deleted: boolean;
}

export interface DbSnapshot {
  events: DbEvent[];
  deliveries: DbDelivery[];
  endpoints: DbEndpoint[];
  attemptRows: number;
  leaseExpiredByWorker: Record<string, number>;
}

export interface AuditSummary {
  total: number;
  rowsChecked: number;
  examples: { rule: string; deliveryId: string; detail: string }[];
}

export interface RunData {
  plan: ChaosPlan;
  projectIds: Record<string, string>;
  endpointIds: Record<string, string>;
  client: ClientRecord[];
  control: ControlRecord[];
  receiver: ReceiverRecord[];
  db: DbSnapshot;
  audit: AuditSummary;
  unexpectedExits: string[];
  drainTimedOut: boolean;
  /** Postmaster start times seen during the run, one per restart plus the first. */
  postmasterStarts: string[];
}

export type InvariantStatus = "pass" | "fail" | "info";

export interface InvariantResult {
  id: string;
  title: string;
  sources: string;
  status: InvariantStatus;
  checked: number;
  violations: number;
  examples: string[];
  note?: string;
}

export interface FaultEffect {
  name: string;
  ok: boolean;
  evidence: string;
}

export interface Percentiles {
  count: number;
  p50: number | null;
  p95: number | null;
}

export interface RunResult {
  invariants: InvariantResult[];
  effects: FaultEffect[];
  counts: Record<string, number>;
  deliveriesByStatus: Record<string, number>;
  deliveriesByProfile: Record<string, Record<string, number>>;
  duplicates: { total: number; byCause: Record<string, number> };
  latency: Record<string, Percentiles>;
  killedWorkerLeases: Record<string, number>;
  vacuous: boolean;
  passed: boolean;
}
