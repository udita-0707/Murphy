import type { Rng } from "./random.js";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * What a correct handler ends up with for one entity. These are net outcomes, not counts of events
 * seen: a reservation cancelled after confirming holds 0 bookings, whichever order those arrived in.
 *
 * - credit: times the payment's money was credited
 * - booking: reservations currently held
 * - refund: distinct refunds applied
 * - hold: authorisation holds currently open
 */
export interface Effects {
  credit: number;
  booking: number;
  refund: number;
  hold: number;
}

export const NO_EFFECTS: Effects = { credit: 0, booking: 0, refund: 0, hold: 0 };

/** The state of one entity as the provider sees it. */
export interface Ledger {
  state: string;
  amountMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  /** Money the merchant holds from this entity, in minor units. */
  balanceMinor: number;
  effects: Effects;
}

export interface EntitySpec {
  /** The scenario's name for this entity, such as `stay`. Not the provider's id. */
  id: string;
  kind: string;
  amount_minor: number;
  currency: string;
}

export interface Transition {
  from: readonly string[];
  /** Returns why this cannot happen now, when the state alone does not decide it. */
  guard?: (ledger: Ledger, amountMinor: number | undefined) => string | null;
  apply: (ledger: Ledger, amountMinor: number | undefined) => Ledger;
}

export interface PayloadInput {
  type: string;
  ledger: Ledger;
  /** The state before this event. */
  previous: Ledger;
  ids: Record<string, string>;
  currency: string;
  /** Unix seconds. Comes from the seed, not the clock. */
  createdAt: number;
  /** Set for events with their own amount, such as a refund. */
  amountMinor: number | undefined;
  /** A generator private to this one event. */
  rng: Rng;
}

export interface ProviderProfile {
  name: string;
  /** Says what the payloads resemble, without claiming to be that provider. */
  label: string;
  entityKind: string;
  currencies: readonly [string, ...string[]];
  initialState: string;
  transitions: Readonly<Record<string, Transition>>;
  /** Stable ids for one entity. Must contain `id`, the id a handler sees. */
  makeIds: (rng: Rng) => Record<string, string>;
  buildPayload: (input: PayloadInput) => JsonObject;
}

/** Refund guard and effect, shared by the profiles that take refunds. */
export const refund = {
  guard(ledger: Ledger, amountMinor: number | undefined): string | null {
    const remaining = ledger.capturedMinor - ledger.refundedMinor;
    if (remaining <= 0) return "nothing is left to refund";
    if (amountMinor !== undefined && amountMinor > remaining) {
      return `a refund of ${amountMinor} exceeds the ${remaining} left to refund`;
    }
    return null;
  },
  apply(ledger: Ledger, amountMinor: number | undefined): Ledger {
    const amount = amountMinor ?? ledger.capturedMinor - ledger.refundedMinor;
    const refundedMinor = ledger.refundedMinor + amount;
    return {
      ...ledger,
      state: refundedMinor === ledger.capturedMinor ? "refunded" : ledger.state,
      refundedMinor,
      balanceMinor: ledger.balanceMinor - amount,
      effects: { ...ledger.effects, refund: ledger.effects.refund + 1 },
    };
  },
};

/** Credit effect, shared by the profiles that take money. */
export function credit(ledger: Ledger, state: string): Ledger {
  return {
    ...ledger,
    state,
    capturedMinor: ledger.amountMinor,
    balanceMinor: ledger.balanceMinor + ledger.amountMinor,
    effects: { ...ledger.effects, credit: ledger.effects.credit + 1 },
  };
}
