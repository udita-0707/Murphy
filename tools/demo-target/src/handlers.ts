import type { EntityState, TargetEvent, TargetState } from "@murphy/sdk";

/**
 * Two versions of the same webhook handler, for simulator demos.
 *
 * NaiveHandler is what a first version often looks like: it applies each webhook as it arrives. It
 * double-credits on a duplicate and ends in the wrong state when events arrive out of order.
 *
 * IdempotentHandler deduplicates on webhook-id, and works out the state from which facts it has seen,
 * so arrival order does not matter.
 *
 * Both are demo code. IdempotentHandler keeps its dedupe set in one process's memory; a real one needs
 * a unique constraint in a database, written in the same transaction as the effect.
 */
export interface DemoHandler {
  apply(event: TargetEvent): void;
  state(runId: string): TargetState;
}

interface Parsed {
  entityId: string;
  /** What the entity is, read from the payload's shape as a real handler would. */
  kind: "payment" | "upi" | "reservation";
  type: string;
  /** The entity's whole amount. */
  amountMinor: number;
  /** Set on a refund. */
  refundMinor: number | null;
  refundId: string | null;
}

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict => (value ?? {}) as Dict;

/** Reads what a handler needs from a provider's payload. */
export function parseEvent(event: TargetEvent): Parsed {
  const entityId = event.murphy?.entity_id;
  if (!entityId) throw new Error("the demo target only handles simulated events");
  const p = event.payload;
  const type = event.type;

  if ("collect" in p) {
    const collect = dict(p.collect);
    return {
      entityId,
      kind: "upi",
      type,
      amountMinor: Number(dict(collect.amount).value_minor),
      refundMinor: null,
      refundId: null,
    };
  }
  if ("data" in p) {
    const data = dict(p.data);
    const refund = data.refund === undefined ? null : dict(data.refund);
    return {
      entityId,
      kind: "reservation",
      type,
      amountMinor: Number(dict(data.reservation).total_minor),
      refundMinor: refund ? Number(refund.amount_minor) : null,
      refundId: refund ? String(refund.id) : null,
    };
  }
  const payload = dict(p.payload);
  const refund = payload.refund === undefined ? null : dict(dict(payload.refund).entity);
  return {
    entityId,
    kind: "payment",
    type,
    amountMinor: Number(dict(dict(payload.payment).entity).amount),
    refundMinor: refund ? Number(refund.amount) : null,
    refundId: refund ? String(refund.id) : null,
  };
}

type Runs<T> = Map<string, Map<string, T>>;

function entityOf<T>(runs: Runs<T>, runId: string, id: string, create: () => T): T {
  let run = runs.get(runId);
  if (!run) {
    run = new Map();
    runs.set(runId, run);
  }
  let entity = run.get(id);
  if (entity === undefined) {
    entity = create();
    run.set(id, entity);
  }
  return entity;
}

interface NaiveEntity {
  state: string;
  credit: number;
  booking: number;
  refund: number;
  hold: number;
  balance: number;
}

/** Applies every delivery it receives, in arrival order. The last write wins. */
export class NaiveHandler implements DemoHandler {
  private readonly runs: Runs<NaiveEntity> = new Map();

  apply(event: TargetEvent): void {
    const e = parseEvent(event);
    const entity = entityOf(this.runs, event.murphy!.run_id, e.entityId, () => ({
      state: "new",
      credit: 0,
      booking: 0,
      refund: 0,
      hold: 0,
      balance: 0,
    }));
    switch (e.type) {
      case "payment.authorized":
        entity.state = "authorized";
        entity.hold += 1;
        return;
      case "payment.failed":
        // A hold exists only once authorized, but this does not notice it already released one.
        if (entity.state !== "new") entity.hold -= 1;
        entity.state = "failed";
        return;
      case "payment.captured":
        entity.credit += 1;
        entity.balance += e.amountMinor;
        if (e.kind === "reservation") {
          entity.state = "paid";
        } else {
          entity.state = "captured";
          entity.hold -= 1;
        }
        return;
      case "refund.processed":
        entity.refund += 1;
        entity.balance -= e.refundMinor ?? 0;
        if (entity.balance <= 0) entity.state = "refunded";
        return;
      case "reservation.created":
        entity.state = "created";
        return;
      case "reservation.confirmed":
        entity.state = "confirmed";
        entity.booking += 1;
        return;
      case "reservation.cancelled":
        entity.state = "cancelled";
        entity.booking = Math.max(0, entity.booking - 1);
        return;
      case "upi.collect.initiated":
        entity.state = "initiated";
        return;
      case "upi.collect.pending":
        entity.state = "pending";
        return;
      case "upi.collect.success":
        entity.state = "success";
        entity.credit += 1;
        entity.balance += e.amountMinor;
        return;
      case "upi.collect.failed":
        entity.state = "failed";
        return;
      case "upi.collect.expired":
        entity.state = "expired";
        return;
      default:
        throw new Error(`unknown event ${e.type}`);
    }
  }

  state(runId: string): TargetState {
    const entities: Record<string, EntityState> = {};
    for (const [id, e] of this.runs.get(runId) ?? []) {
      entities[id] = {
        state: e.state,
        effects: { credit: e.credit, booking: e.booking, refund: e.refund, hold: e.hold },
        balance_minor: e.balance,
      };
    }
    return { entities };
  }
}

interface Facts {
  kind: Parsed["kind"];
  amountMinor: number;
  seen: Set<string>;
  /** Keyed by refund id, so two different partial refunds both count. */
  refunds: Map<string, number>;
}

/** Deduplicates on webhook-id, and derives the state from the facts seen, in any order. */
export class IdempotentHandler implements DemoHandler {
  private readonly runs: Runs<Facts> = new Map();
  private readonly processed = new Set<string>();

  apply(event: TargetEvent): void {
    if (this.processed.has(event.webhookId)) return;
    const e = parseEvent(event);
    const facts = entityOf(this.runs, event.murphy!.run_id, e.entityId, () => ({
      kind: e.kind,
      amountMinor: e.amountMinor,
      seen: new Set<string>(),
      refunds: new Map<string, number>(),
    }));
    facts.seen.add(e.type);
    if (e.refundId !== null) facts.refunds.set(e.refundId, e.refundMinor ?? 0);
    this.processed.add(event.webhookId);
  }

  state(runId: string): TargetState {
    const entities: Record<string, EntityState> = {};
    for (const [id, facts] of this.runs.get(runId) ?? []) entities[id] = derive(facts);
    return { entities };
  }
}

function derive(f: Facts): EntityState {
  const refunded = [...f.refunds.values()].reduce((sum, amount) => sum + amount, 0);
  const has = (type: string) => f.seen.has(type);
  // A refund proves the money was taken, even if the capture has not arrived yet.
  const credited = has("payment.captured") || has("upi.collect.success") || f.refunds.size > 0;
  const balance = credited ? f.amountMinor - refunded : 0;
  const full = credited && refunded >= f.amountMinor;
  const effects = { credit: credited ? 1 : 0, refund: f.refunds.size };

  switch (f.kind) {
    case "payment": {
      const state = full
        ? "refunded"
        : credited
          ? "captured"
          : has("payment.failed")
            ? "failed"
            : has("payment.authorized")
              ? "authorized"
              : "new";
      return {
        state,
        effects: { ...effects, booking: 0, hold: state === "authorized" ? 1 : 0 },
        balance_minor: balance,
      };
    }
    case "upi": {
      const state = credited
        ? "success"
        : has("upi.collect.failed")
          ? "failed"
          : has("upi.collect.expired")
            ? "expired"
            : has("upi.collect.pending")
              ? "pending"
              : has("upi.collect.initiated")
                ? "initiated"
                : "new";
      return { state, effects: { ...effects, booking: 0, hold: 0 }, balance_minor: balance };
    }
    case "reservation": {
      const cancelled = has("reservation.cancelled");
      const state = full
        ? "refunded"
        : cancelled
          ? "cancelled"
          : credited
            ? "paid"
            : has("reservation.confirmed")
              ? "confirmed"
              : has("reservation.created")
                ? "created"
                : "new";
      return {
        state,
        effects: {
          ...effects,
          booking: has("reservation.confirmed") && !cancelled ? 1 : 0,
          hold: 0,
        },
        balance_minor: balance,
      };
    }
  }
}
