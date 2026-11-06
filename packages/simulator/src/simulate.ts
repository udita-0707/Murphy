import { NO_EFFECTS, type EntitySpec, type JsonObject, type Ledger } from "./model.js";
import type { ProviderProfile } from "./model.js";
import { booking } from "./providers/booking.js";
import { payments } from "./providers/payments.js";
import { upi } from "./providers/upi.js";
import { Rng } from "./random.js";

export const PROVIDERS: Readonly<Record<string, ProviderProfile>> = { payments, upi, booking };

export function getProvider(name: string): ProviderProfile | undefined {
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
}

export interface LogicalStep {
  emit: string;
  entity: string;
  /** For events with their own amount, such as a partial refund. */
  amount_minor?: number;
}

export interface SimulatedEvent {
  index: number;
  type: string;
  entity: string;
  /** The provider's id for the entity, which is what a handler sees. */
  providerId: string;
  /** State after this event. */
  state: string;
  payload: JsonObject;
}

export interface FinalEntity extends EntitySpec {
  providerId: string;
  ledger: Ledger;
}

export interface Simulation {
  events: SimulatedEvent[];
  entities: FinalEntity[];
}

/** A sequence the provider would never emit. Carries the step, for error messages. */
export class IllegalSequenceError extends Error {
  constructor(
    readonly stepIndex: number,
    message: string,
  ) {
    super(message);
    this.name = "IllegalSequenceError";
  }
}

export function newLedger(profile: ProviderProfile, spec: { amount_minor: number }): Ledger {
  return {
    state: profile.initialState,
    amountMinor: spec.amount_minor,
    capturedMinor: 0,
    refundedMinor: 0,
    balanceMinor: 0,
    effects: { ...NO_EFFECTS },
  };
}

/** Why this event cannot happen now, or null if it can. */
export function whyIllegal(
  profile: ProviderProfile,
  ledger: Ledger,
  type: string,
  amountMinor?: number,
): string | null {
  const transition = Object.hasOwn(profile.transitions, type) ? profile.transitions[type] : null;
  if (!transition) {
    return `${profile.name} has no event "${type}" (it has: ${Object.keys(profile.transitions).join(", ")})`;
  }
  if (!transition.from.includes(ledger.state)) {
    return `${type} cannot follow state "${ledger.state}" (it needs: ${transition.from.join(", ")})`;
  }
  return transition.guard?.(ledger, amountMinor) ?? null;
}

/** The events that are legal next. Empty means the entity is finished. */
export function legalEvents(profile: ProviderProfile, ledger: Ledger): string[] {
  return Object.keys(profile.transitions).filter((t) => whyIllegal(profile, ledger, t) === null);
}

/**
 * Runs a logical sequence through the provider's state machine, in order, and builds each event's
 * payload. Throws if the sequence is illegal, so only legal sequences are ever emitted. Faults such
 * as reordering change when a payload is sent, never this order.
 *
 * Same inputs, same output: nothing here reads the clock or any outside random source.
 */
export function simulate(
  profile: ProviderProfile,
  specs: readonly EntitySpec[],
  steps: readonly LogicalStep[],
  seed: number,
): Simulation {
  const entities = new Map<
    string,
    { spec: EntitySpec; ids: Record<string, string>; ledger: Ledger; clock: number; rng: Rng }
  >();
  for (const spec of specs) {
    if (spec.kind !== profile.entityKind) {
      throw new Error(
        `entity "${spec.id}" has kind "${spec.kind}", but ${profile.name} simulates "${profile.entityKind}"`,
      );
    }
    if (!(profile.currencies as readonly string[]).includes(spec.currency)) {
      throw new Error(
        `entity "${spec.id}" uses ${spec.currency}, but ${profile.name} supports ${profile.currencies.join(", ")}`,
      );
    }
    const rng = new Rng(seed, `entity:${spec.id}`);
    entities.set(spec.id, {
      spec,
      ids: profile.makeIds(rng),
      ledger: newLedger(profile, spec),
      // Some time in 2026, fixed by the seed.
      clock: 1_767_225_600 + rng.int(0, 300 * 86_400),
      rng,
    });
  }

  const events = steps.map((step, index): SimulatedEvent => {
    const entity = entities.get(step.entity);
    if (!entity) throw new IllegalSequenceError(index, `no entity called "${step.entity}"`);
    const why = whyIllegal(profile, entity.ledger, step.emit, step.amount_minor);
    if (why) throw new IllegalSequenceError(index, why);

    const previous = entity.ledger;
    entity.ledger = profile.transitions[step.emit]!.apply(previous, step.amount_minor);
    entity.clock += entity.rng.int(30, 600);
    return {
      index,
      type: step.emit,
      entity: step.entity,
      providerId: entity.ids.id!,
      state: entity.ledger.state,
      payload: profile.buildPayload({
        type: step.emit,
        ledger: entity.ledger,
        previous,
        ids: entity.ids,
        currency: entity.spec.currency,
        createdAt: entity.clock,
        amountMinor: step.amount_minor,
        rng: new Rng(seed, `event:${index}`),
      }),
    };
  });

  return {
    events,
    entities: [...entities.values()].map((e) => ({
      ...e.spec,
      providerId: e.ids.id!,
      ledger: e.ledger,
    })),
  };
}
