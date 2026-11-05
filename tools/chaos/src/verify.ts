import { isClean2xx } from "./decide.js";
import type {
  ClientRecord,
  FaultEffect,
  InvariantResult,
  InvariantStatus,
  Percentiles,
  PlanEndpoint,
  Profile,
  ReceiverAction,
  ReceiverRecord,
  RunData,
  RunResult,
} from "./types.js";

/** The expected deliveries of these endpoints can be worked out from the plan alone. */
const STABLE: ReadonlySet<Profile> = new Set([
  "control",
  "flaky",
  "slow",
  "lost_ack",
  "always_500",
]);

const MAX_EXAMPLES = 5;

/** Collects the outcome of one invariant. */
class Check {
  private checked = 0;
  private violations = 0;
  private readonly examples: string[] = [];

  constructor(
    private readonly id: string,
    private readonly title: string,
    private readonly sources: string,
    private readonly note?: string,
  ) {}

  ok(): void {
    this.checked += 1;
  }

  bad(example: string): void {
    this.checked += 1;
    this.violations += 1;
    if (this.examples.length < MAX_EXAMPLES) this.examples.push(example);
  }

  that(condition: boolean, example: () => string): void {
    if (condition) this.ok();
    else this.bad(example());
  }

  result(status?: InvariantStatus): InvariantResult {
    return {
      id: this.id,
      title: this.title,
      sources: this.sources,
      status: status ?? (this.violations > 0 ? "fail" : "pass"),
      checked: this.checked,
      violations: this.violations,
      examples: this.examples,
      ...(this.note ? { note: this.note } : {}),
    };
  }
}

export function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { count: 0, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
}

function matches(endpoint: PlanEndpoint, projectKey: string, type: string): boolean {
  return (
    endpoint.projectKey === projectKey &&
    (endpoint.filter.length === 0 || endpoint.filter.includes(type))
  );
}

interface Window {
  from: number;
  to: number;
}

/**
 * When the harness or the receiver had put an endpoint out of service, taken from the control log
 * and the receiver log, never from the database.
 */
function inactiveWindows(data: RunData): Map<string, Window[]> {
  const windows = new Map<string, Window[]>();
  const open = (key: string, from: number) => {
    const list = windows.get(key) ?? [];
    list.push({ from, to: Infinity });
    windows.set(key, list);
  };
  for (const c of data.control) {
    if (!c.target) continue;
    if ((c.action === "disable_endpoint" || c.action === "delete_endpoint") && c.phase === "start")
      open(c.target, c.t);
    if (c.action === "enable_endpoint" && c.phase === "done") {
      const last = windows.get(c.target)?.at(-1);
      if (last) last.to = c.t;
    }
  }
  const firstGone = new Map<string, number>();
  for (const r of data.receiver) {
    if (r.action === "gone_410" && !firstGone.has(r.endpoint)) firstGone.set(r.endpoint, r.t);
  }
  for (const [key, t] of firstGone) open(key, t);
  return windows;
}

interface Sent {
  key: string;
  logicalId: string;
  projectKey: string;
  type: string;
  payloadHash: string;
  firstSend: number;
}

interface Acked extends Sent {
  eventId: string;
  deliveries: number;
  firstAck: number;
}

function readClient(client: ClientRecord[]) {
  const sent = new Map<string, Sent>();
  const ackIds = new Map<string, Set<string>>();
  const acks = new Map<string, { eventId: string; deliveries: number; t: number }>();
  let errors = 0;
  let gaveUp = 0;
  let replayedAcks = 0;
  let totalAcks = 0;
  let deliberateResends = 0;
  for (const r of client) {
    switch (r.kind) {
      case "send":
        if (!sent.has(r.key)) {
          sent.set(r.key, {
            key: r.key,
            logicalId: r.logicalId,
            projectKey: r.projectKey,
            type: r.type,
            payloadHash: r.payloadHash,
            firstSend: r.t,
          });
        }
        if (r.deliberateResend) deliberateResends += 1;
        break;
      case "ack": {
        totalAcks += 1;
        if (r.replayed) replayedAcks += 1;
        const ids = ackIds.get(r.key) ?? new Set<string>();
        ids.add(r.eventId);
        ackIds.set(r.key, ids);
        if (!acks.has(r.key))
          acks.set(r.key, { eventId: r.eventId, deliveries: r.deliveries, t: r.t });
        break;
      }
      case "error":
        errors += 1;
        break;
      case "gave_up":
        gaveUp += 1;
        break;
    }
  }
  const acked: Acked[] = [];
  for (const [key, ack] of acks) {
    const s = sent.get(key);
    if (s) acked.push({ ...s, eventId: ack.eventId, deliveries: ack.deliveries, firstAck: ack.t });
  }
  return { sent, acked, ackIds, errors, gaveUp, replayedAcks, totalAcks, deliberateResends };
}

const CAUSES: Partial<Record<ReceiverAction, string>> = {
  process_then_500: "receiver processed it, then answered 500",
  process_then_reset: "receiver processed it, then dropped the connection",
  hang: "receiver processed it, but answered after the worker's timeout",
  ok: "receiver answered 2xx, but Murphy did not record it (worker killed, Postgres down)",
  slow: "receiver answered 2xx, but Murphy did not record it (worker killed, Postgres down)",
};

/** Checks every invariant. Pure: it reads only the logs and the snapshot it is given. */
export function verifyRun(data: RunData): RunResult {
  const { plan, db, receiver } = data;
  const client = readClient(data.client);

  const endpointKeyById = new Map(Object.entries(data.endpointIds).map(([k, id]) => [id, k]));
  const planEndpoint = new Map(plan.endpoints.map((e) => [e.key, e]));
  const dbEvents = new Map(db.events.map((e) => [e.id, e]));
  const dbEndpoints = new Map(db.endpoints.map((e) => [e.id, e]));
  const deliveriesByEvent = new Map<string, typeof db.deliveries>();
  for (const d of db.deliveries) {
    const list = deliveriesByEvent.get(d.eventId) ?? [];
    list.push(d);
    deliveriesByEvent.set(d.eventId, list);
  }
  const receiptsByMessage = new Map<string, ReceiverRecord[]>();
  for (const r of receiver) {
    const key = `${r.endpoint}|${r.webhookId}`;
    const list = receiptsByMessage.get(key) ?? [];
    list.push(r);
    receiptsByMessage.set(key, list);
  }
  const receipts = (endpoint: string, eventId: string) =>
    receiptsByMessage.get(`${endpoint}|msg_${eventId}`) ?? [];
  const got2xx = (rs: ReceiverRecord[]) => rs.some((r) => r.signatureValid && isClean2xx(r.action));
  const windows = inactiveWindows(data);
  const deleted = new Set(
    data.control
      .filter((c) => c.action === "delete_endpoint" && c.phase === "start")
      .map((c) => c.target),
  );

  // 1. Every 202 is durable.
  const i1 = new Check(
    "I1",
    "Every event that got a 202 is in the database, unchanged",
    "client log vs database",
  );
  for (const a of client.acked) {
    const row = dbEvents.get(a.eventId);
    if (!row)
      i1.bad(`${a.key}: got a 202 with id ${a.eventId}, but the event is not in the database`);
    else
      i1.that(
        row.idempotencyKey === a.key &&
          row.payloadHash === a.payloadHash &&
          row.type === a.type &&
          row.projectId === data.projectIds[a.projectKey],
        () => `${a.key}: the stored event differs from what the client sent`,
      );
  }

  // 2. Idempotency.
  const i2 = new Check(
    "I2",
    "An Idempotency-Key gives one event, whatever the retries",
    "client log vs database",
  );
  const rowsPerKey = new Map<string, number>();
  for (const e of db.events) {
    rowsPerKey.set(
      `${e.projectId}|${e.idempotencyKey}`,
      (rowsPerKey.get(`${e.projectId}|${e.idempotencyKey}`) ?? 0) + 1,
    );
  }
  for (const s of client.sent.values()) {
    const ids = client.ackIds.get(s.key);
    const rows = rowsPerKey.get(`${data.projectIds[s.projectKey]}|${s.key}`) ?? 0;
    if (ids && ids.size > 1) i2.bad(`${s.key}: 202s carried ${ids.size} different event ids`);
    else if (rows > 1) i2.bad(`${s.key}: ${rows} event rows`);
    else i2.ok();
  }
  for (const e of db.events) {
    i2.that(
      client.sent.has(e.idempotencyKey),
      () => `event ${e.id} has a key the client never sent`,
    );
  }

  // 3. Fan-out as acknowledged.
  const i3 = new Check(
    "I3",
    "The deliveries count in each 202 matches the rows in the database",
    "client log vs database",
  );
  for (const a of client.acked) {
    const rows = deliveriesByEvent.get(a.eventId)?.length ?? 0;
    i3.that(
      rows === a.deliveries,
      () => `${a.key}: the 202 said ${a.deliveries}, database has ${rows}`,
    );
  }

  // 4. No loss, the headline.
  const i4 = new Check(
    "I4",
    "No accepted event is lost: each expected delivery reached the receiver, went dead after trying, or is parked or cancelled on purpose",
    "client log + control log vs receiver log vs database",
    "Stable endpoints: expected deliveries come from the plan and the client log alone. Endpoints that change state: an event sent during the change may correctly get no delivery, so the row is taken from the database and its outcome checked against the receiver and control logs.",
  );
  let noDeliveryByDesign = 0;
  for (const a of client.acked) {
    const rows = deliveriesByEvent.get(a.eventId) ?? [];
    for (const endpoint of plan.endpoints) {
      const id = data.endpointIds[endpoint.key];
      const row = rows.find((r) => r.endpointId === id);
      const expected = matches(endpoint, a.projectKey, a.type);
      if (!expected) {
        if (row) i4.bad(`${a.key}: delivery to ${endpoint.key}, which should not get it`);
        continue;
      }
      if (!row) {
        const inactive = (windows.get(endpoint.key) ?? []).some(
          (w) => w.from <= a.firstAck && a.firstSend <= w.to,
        );
        if (!STABLE.has(endpoint.profile) && inactive) {
          noDeliveryByDesign += 1;
          i4.ok();
        } else {
          i4.bad(`${a.key}: no delivery row for ${endpoint.key}`);
        }
        continue;
      }
      const seen = receipts(endpoint.key, a.eventId);
      switch (row.status) {
        case "succeeded":
          i4.that(
            got2xx(seen),
            () => `${a.key} -> ${endpoint.key}: succeeded, receiver saw no 2xx`,
          );
          break;
        case "dead":
          i4.that(
            seen.length > 0 && endpoint.profile !== "control",
            () => `${a.key} -> ${endpoint.key}: dead after ${seen.length} receipts`,
          );
          break;
        case "cancelled":
          i4.that(
            deleted.has(endpoint.key),
            () => `${a.key} -> ${endpoint.key}: cancelled, never deleted`,
          );
          break;
        case "pending":
          i4.that(
            (windows.get(endpoint.key) ?? []).some((w) => w.to === Infinity) &&
              !deleted.has(endpoint.key),
            () =>
              `${a.key} -> ${endpoint.key}: pending, but the endpoint was not parked on purpose`,
          );
          break;
        default:
          i4.bad(`${a.key} -> ${endpoint.key}: ended ${row.status}`);
      }
    }
  }

  // 5. Murphy's success claims are true.
  const i5 = new Check(
    "I5",
    "Every delivery marked succeeded really got a signed 2xx at the receiver",
    "database vs receiver log",
  );
  for (const d of db.deliveries) {
    if (d.status !== "succeeded") continue;
    const key = endpointKeyById.get(d.endpointId) ?? "unknown";
    i5.that(
      got2xx(receipts(key, d.eventId)),
      () => `delivery ${d.id} on ${key}: no 2xx in the receiver log`,
    );
  }

  // 6. Everything received is genuine.
  const i6 = new Check(
    "I6",
    "Every receipt traces to a sent event: valid signature, same payload, right tenant, right id",
    "receiver log vs client log",
  );
  const sentByLogical = new Map([...client.sent.values()].map((s) => [s.logicalId, s]));
  const eventIdByKey = new Map(client.acked.map((a) => [a.key, a.eventId]));
  for (const r of receiver) {
    const s = r.logicalId ? sentByLogical.get(r.logicalId) : undefined;
    const endpoint = planEndpoint.get(r.endpoint);
    const ackedId = s ? eventIdByKey.get(s.key) : undefined;
    if (!r.signatureValid) i6.bad(`${r.webhookId} on ${r.endpoint}: invalid signature`);
    else if (!s)
      i6.bad(`${r.webhookId} on ${r.endpoint}: logical id ${r.logicalId} was never sent`);
    else if (r.payloadHash !== s.payloadHash)
      i6.bad(`${r.webhookId}: payload differs from what was sent`);
    else if (!endpoint || endpoint.projectKey !== s.projectKey)
      i6.bad(`${r.webhookId}: event of ${s.projectKey} reached ${r.endpoint}`);
    else if (r.eventType !== s.type)
      i6.bad(`${r.webhookId}: event type header ${r.eventType}, sent ${s.type}`);
    else if (ackedId && r.webhookId !== `msg_${ackedId}`)
      i6.bad(`${r.webhookId}: the 202 said event ${ackedId}`);
    else i6.ok();
  }

  // 7. Nothing is stuck.
  const i7 = new Check(
    "I7",
    "All deliveries are terminal, or parked on purpose",
    "database + control log + receiver log",
  );
  for (const d of db.deliveries) {
    const key = endpointKeyById.get(d.endpointId) ?? "unknown";
    const endpoint = dbEndpoints.get(d.endpointId);
    const explained = (windows.get(key) ?? []).some((w) => w.to === Infinity);
    switch (d.status) {
      case "succeeded":
      case "dead":
        i7.ok();
        break;
      case "cancelled":
        i7.that(
          deleted.has(key) && endpoint?.deleted === true,
          () => `delivery ${d.id} on ${key}: cancelled, not deleted on purpose`,
        );
        break;
      case "pending":
        i7.that(
          explained && endpoint?.status !== "active" && endpoint?.deleted === false,
          () =>
            `delivery ${d.id} on ${key}: pending and not parked (endpoint ${endpoint?.status}, deleted ${endpoint?.deleted})`,
        );
        break;
      default:
        i7.bad(`delivery ${d.id} on ${key}: stuck ${d.status}`);
    }
  }

  // 8. No leases left.
  const i8 = new Check(
    "I8",
    "Zero deliveries in flight, zero leases left over",
    "database only",
    "This compares the database with itself, because it is a statement about database state. I4 and I5 are the independent checks.",
  );
  for (const d of db.deliveries) {
    i8.that(
      d.status !== "in_flight" &&
        d.lockedBy === null &&
        d.lockedUntil === null &&
        d.claimToken === null,
      () => `delivery ${d.id}: status ${d.status}, locked_by ${d.lockedBy}`,
    );
  }

  // 9. History.
  const i9 = new Check(
    "I9",
    "Only legal transitions and no counter going backwards, across every change in the run",
    "audit history",
    "Recorded by triggers inside each writing transaction, so it includes states the final snapshot cannot show.",
  );
  for (const v of data.audit.examples) i9.bad(`${v.rule} on ${v.deliveryId}: ${v.detail}`);
  const auditExtra = data.audit.total - data.audit.examples.length;
  const i9Result = i9.result();
  i9Result.checked = data.audit.rowsChecked;
  i9Result.violations = data.audit.total;
  if (auditExtra > 0) i9Result.note = `${i9Result.note} ${auditExtra} more not shown.`;
  if (data.audit.rowsChecked === 0) {
    i9Result.status = "fail";
    i9Result.examples = ["the audit history is empty, so nothing was checked"];
  }

  // 10. Exactly once for an idempotent receiver.
  const i10 = new Check(
    "I10",
    "An idempotent receiver deduplicating on webhook-id processes each logical message exactly once",
    "receiver log vs client log",
    "A set keyed on webhook-id is exactly-once by construction, so the real check is that each client-generated logical id and endpoint only ever arrived under one webhook-id. If Murphy changed the id on a retry, this would fail.",
  );
  const logical = new Map<string, { ids: Set<string>; applied: number; processed: number }>();
  for (const r of receiver) {
    if (!r.processed) continue;
    const key = `${r.logicalId}|${r.endpoint}`;
    const entry = logical.get(key) ?? { ids: new Set<string>(), applied: 0, processed: 0 };
    entry.ids.add(r.webhookId);
    entry.processed += 1;
    if (r.idempotentApplied) entry.applied += 1;
    logical.set(key, entry);
  }
  for (const [key, entry] of logical) {
    if (entry.ids.size !== 1) i10.bad(`${key}: arrived under ${entry.ids.size} webhook-ids`);
    else if (entry.applied !== 1)
      i10.bad(`${key}: the idempotent handler applied it ${entry.applied} times`);
    else i10.ok();
  }

  // 11. Duplicates, for the report.
  const byCause: Record<string, number> = {};
  const history = new Map<string, ReceiverRecord>();
  let duplicates = 0;
  for (const r of [...receiver].sort((a, b) => a.t - b.t)) {
    if (!r.processed) continue;
    const key = `${r.endpoint}|${r.webhookId}`;
    const previous = history.get(key);
    if (previous) {
      duplicates += 1;
      const cause = CAUSES[previous.action] ?? previous.action;
      byCause[cause] = (byCause[cause] ?? 0) + 1;
    }
    history.set(key, r);
  }
  const i11 = new Check(
    "I11",
    `A naive receiver with no deduplication processed ${duplicates} duplicates`,
    "receiver log",
    "Reported, not pass or fail: delivery is at-least-once, so duplicates are expected. This is why receivers must deduplicate.",
  );

  // Distribution, for the report.
  const deliveriesByStatus: Record<string, number> = {};
  const deliveriesByProfile: Record<string, Record<string, number>> = {};
  for (const d of db.deliveries) {
    deliveriesByStatus[d.status] = (deliveriesByStatus[d.status] ?? 0) + 1;
    const key = endpointKeyById.get(d.endpointId) ?? "unknown";
    const label = planEndpoint.get(key)?.profile ?? "unknown";
    const row = (deliveriesByProfile[label] ??= {});
    row[d.status] = (row[d.status] ?? 0) + 1;
  }

  // Latency, from the client's clock to the receiver's. Murphy's timestamps are not used.
  const firstReceipt: Record<string, number[]> = { control: [], all: [] };
  const first2xx: Record<string, number[]> = { control: [], all: [] };
  for (const a of client.acked) {
    for (const endpoint of plan.endpoints) {
      if (!matches(endpoint, a.projectKey, a.type)) continue;
      const seen = receipts(endpoint.key, a.eventId);
      const first = seen[0];
      if (!first) continue;
      const groups = endpoint.profile === "control" ? ["control", "all"] : ["all"];
      for (const group of groups) firstReceipt[group]!.push(first.t - a.firstSend);
      const clean = seen.find((r) => isClean2xx(r.action));
      if (clean) for (const group of groups) first2xx[group]!.push(clean.t - a.firstSend);
    }
  }

  // Did the faults actually do anything?
  const actions = new Map<string, number>();
  for (const r of receiver) actions.set(r.action, (actions.get(r.action) ?? 0) + 1);
  const count = (a: string) => actions.get(a) ?? 0;
  const planned = (action: string) => plan.faults.filter((f) => f.action === action).length;
  const leases = Object.values(db.leaseExpiredByWorker).reduce((sum, n) => sum + n, 0);
  const distinctStarts = new Set(data.postmasterStarts).size;
  const effect = (name: string, ok: boolean, evidence: string): FaultEffect => ({
    name,
    ok,
    evidence,
  });
  const effects: FaultEffect[] = [
    effect(
      "Worker kills abandoned real work",
      leases > 0,
      `${leases} leases expired and were reaped`,
    ),
    effect(
      "Postgres really restarted",
      distinctStarts >= planned("restart_postgres") + 1,
      `${distinctStarts} distinct pg_postmaster_start_time values, ${planned("restart_postgres")} restarts planned`,
    ),
    effect(
      "The client felt the outages",
      client.errors > 0,
      `${client.errors} failed requests, retried with the same key`,
    ),
    ...(
      [
        ["fail_500", "Receiver answered 5xx"],
        ["slow", "Receiver answered slowly"],
        ["hang", "Receiver hung past the timeout"],
        ["process_then_500", "Receiver processed, then answered 500"],
        ["process_then_reset", "Receiver processed, then dropped the connection"],
        ["gone_410", "Receiver answered 410"],
      ] as const
    ).map(([action, name]) => effect(name, count(action) > 0, `${count(action)} times`)),
    effect("Duplicates occurred", duplicates > 0, `${duplicates} duplicates`),
    effect(
      "Some deliveries went dead",
      (deliveriesByStatus.dead ?? 0) > 0,
      `${deliveriesByStatus.dead ?? 0} dead`,
    ),
    effect(
      "Some deliveries parked",
      (deliveriesByStatus.pending ?? 0) > 0,
      `${deliveriesByStatus.pending ?? 0} parked`,
    ),
    effect(
      "Some deliveries were cancelled",
      (deliveriesByStatus.cancelled ?? 0) > 0,
      `${deliveriesByStatus.cancelled ?? 0} cancelled`,
    ),
  ];

  const invariants = [
    i1.result(),
    i2.result(),
    i3.result(),
    i4.result(),
    i5.result(),
    i6.result(),
    i7.result(),
    i8.result(),
    i9Result,
    i10.result(),
    i11.result("info"),
  ];
  const vacuous = effects.some((e) => !e.ok);
  const passed =
    invariants.every((i) => i.status !== "fail") &&
    !vacuous &&
    data.unexpectedExits.length === 0 &&
    !data.drainTimedOut &&
    client.gaveUp === 0;

  return {
    invariants,
    effects,
    counts: {
      eventsPlanned: plan.events.length,
      eventsAcked: client.acked.length,
      eventsNeverAcked: client.sent.size - client.acked.length,
      eventsInDatabase: db.events.length,
      clientRequestErrors: client.errors,
      clientGaveUp: client.gaveUp,
      deliberateResends: client.deliberateResends,
      replayedAcks: client.replayedAcks,
      deliveries: db.deliveries.length,
      noDeliveryByDesign,
      attemptRows: db.attemptRows,
      receiverArrivals: receiver.length,
      leasesReaped: leases,
      auditRowsChecked: data.audit.rowsChecked,
    },
    deliveriesByStatus,
    deliveriesByProfile,
    duplicates: { total: duplicates, byCause },
    latency: {
      "First arrival, control endpoint": percentiles(firstReceipt.control!),
      "First arrival, all endpoints": percentiles(firstReceipt.all!),
      "First clean 2xx, control endpoint": percentiles(first2xx.control!),
      "First clean 2xx, all endpoints": percentiles(first2xx.all!),
    },
    killedWorkerLeases: db.leaseExpiredByWorker,
    vacuous,
    passed,
  };
}
