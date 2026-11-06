import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  IllegalSequenceError,
  PROVIDERS,
  getProvider,
  legalEvents,
  newLedger,
  simulate,
  whyIllegal,
  type EntitySpec,
  type JsonValue,
  type LogicalStep,
  type ProviderProfile,
} from "../src/index.js";

const profiles = Object.values(PROVIDERS);

function entityFor(profile: ProviderProfile, amount = 49_900): EntitySpec {
  return {
    id: "e1",
    kind: profile.entityKind,
    amount_minor: amount,
    currency: profile.currencies[0],
  };
}

/** Follows the state machine, choosing among legal events with the given choices. */
function walk(profile: ProviderProfile, choices: readonly number[]): LogicalStep[] {
  const steps: LogicalStep[] = [];
  let ledger = newLedger(profile, { amount_minor: 49_900 });
  for (const choice of choices) {
    const options = legalEvents(profile, ledger);
    if (options.length === 0) break;
    const emit = options[choice % options.length]!;
    steps.push({ emit, entity: "e1" });
    ledger = profile.transitions[emit]!.apply(ledger, undefined);
  }
  return steps;
}

const seeds = fc.integer({ min: 0, max: 2 ** 31 - 1 });
const choices = fc.array(fc.nat(), { maxLength: 12 });

/** Collects every number under a key that holds money, anywhere in a payload. */
function amounts(value: JsonValue, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) amounts(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(amount|value_minor|.*_minor|amount_refunded)$/.test(key) && typeof item !== "object") {
        out.push(item);
      }
      amounts(item, out);
    }
  }
  return out;
}

describe.each(profiles.map((p) => [p.name, p] as const))("%s profile", (_name, profile) => {
  it("every walk through the state machine is accepted", () => {
    fc.assert(
      fc.property(seeds, choices, (seed, path) => {
        const steps = walk(profile, path);
        const { events } = simulate(profile, [entityFor(profile)], steps, seed);
        expect(events.map((e) => e.type)).toEqual(steps.map((s) => s.emit));
      }),
    );
  });

  it("rejects any event that is not legal in the current state", () => {
    fc.assert(
      fc.property(seeds, choices, fc.nat(), (seed, path, pick) => {
        const steps = walk(profile, path);
        let ledger = newLedger(profile, { amount_minor: 49_900 });
        for (const step of steps) ledger = profile.transitions[step.emit]!.apply(ledger, undefined);
        const legal = legalEvents(profile, ledger);
        const illegal = Object.keys(profile.transitions).filter((t) => !legal.includes(t));
        if (illegal.length === 0) return;
        const emit = illegal[pick % illegal.length]!;
        expect(() =>
          simulate(profile, [entityFor(profile)], [...steps, { emit, entity: "e1" }], seed),
        ).toThrow(IllegalSequenceError);
      }),
    );
  });

  it("the same seed gives the same payloads", () => {
    fc.assert(
      fc.property(seeds, choices, (seed, path) => {
        const steps = walk(profile, path);
        expect(simulate(profile, [entityFor(profile)], steps, seed)).toEqual(
          simulate(profile, [entityFor(profile)], steps, seed),
        );
      }),
    );
  });

  it("different seeds give different ids", () => {
    const steps = walk(profile, [0]);
    const id = (seed: number) =>
      simulate(profile, [entityFor(profile)], steps, seed).entities[0]!.providerId;
    expect(id(1)).not.toBe(id(2));
  });

  it("amounts are non-negative whole minor units, and money never goes negative", () => {
    fc.assert(
      fc.property(seeds, choices, fc.integer({ min: 1, max: 10_000_000 }), (seed, path, amount) => {
        const steps = walk(profile, path);
        const sim = simulate(profile, [entityFor(profile, amount)], steps, seed);
        for (const event of sim.events) {
          for (const value of amounts(event.payload)) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value as number).toBeGreaterThanOrEqual(0);
          }
        }
        expect(sim.entities[0]!.ledger.balanceMinor).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("keeps the entity's id stable across its events, and carries it in each payload", () => {
    const steps = walk(profile, [0, 0, 0, 0, 0]);
    const { events, entities } = simulate(profile, [entityFor(profile)], steps, 7);
    expect(events.length).toBeGreaterThan(1);
    for (const event of events) {
      expect(event.providerId).toBe(entities[0]!.providerId);
      expect(JSON.stringify(event.payload)).toContain(event.providerId);
    }
  });

  it("does not depend on the clock", () => {
    const steps = walk(profile, [0]);
    const first = simulate(profile, [entityFor(profile)], steps, 9);
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      expect(simulate(profile, [entityFor(profile)], steps, 9)).toEqual(first);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("payments", () => {
  const profile = getProvider("payments")!;
  const entity = entityFor(profile);
  const run = (...emits: (string | LogicalStep)[]) =>
    simulate(
      profile,
      [entity],
      emits.map((e) => (typeof e === "string" ? { emit: e, entity: "e1" } : e)),
      42,
    );

  it("has Razorpay-style ids and shape", () => {
    const { events, entities } = run("payment.authorized", "payment.captured");
    expect(entities[0]!.providerId).toMatch(/^pay_[0-9A-Za-z]{14}$/);
    expect(events[1]!.payload).toMatchObject({
      entity: "event",
      event: "payment.captured",
      contains: ["payment"],
      payload: {
        payment: {
          entity: { id: entities[0]!.providerId, amount: 49_900, currency: "INR", captured: true },
        },
      },
    });
  });

  it("captures once and credits once", () => {
    const { entities } = run("payment.authorized", "payment.captured");
    expect(entities[0]!.ledger).toMatchObject({
      state: "captured",
      balanceMinor: 49_900,
      effects: { credit: 1, hold: 0 },
    });
  });

  it("cannot capture before authorizing, or twice", () => {
    expect(() => run("payment.captured")).toThrow(/cannot follow state "created"/);
    expect(() => run("payment.authorized", "payment.captured", "payment.captured")).toThrow(
      /cannot follow state "captured"/,
    );
  });

  it("releases the hold when an authorized payment fails", () => {
    const { entities } = run("payment.authorized", "payment.failed");
    expect(entities[0]!.ledger).toMatchObject({
      state: "failed",
      balanceMinor: 0,
      effects: { credit: 0, hold: 0 },
    });
  });

  it("tracks partial refunds, and refuses to refund more than was captured", () => {
    const part = { emit: "refund.processed", entity: "e1", amount_minor: 20_000 };
    const { entities, events } = run("payment.authorized", "payment.captured", part);
    expect(entities[0]!.ledger).toMatchObject({
      state: "captured",
      balanceMinor: 29_900,
      effects: { refund: 1 },
    });
    expect(events[2]!.payload).toMatchObject({
      contains: ["refund", "payment"],
      payload: { refund: { entity: { amount: 20_000, status: "processed" } } },
    });
    expect(() =>
      run("payment.authorized", "payment.captured", { ...part, amount_minor: 50_000 }),
    ).toThrow(/exceeds the 49900 left/);
  });

  it("a full refund ends the payment", () => {
    const { entities } = run("payment.authorized", "payment.captured", "refund.processed");
    expect(entities[0]!.ledger).toMatchObject({ state: "refunded", balanceMinor: 0 });
    expect(whyIllegal(profile, entities[0]!.ledger, "refund.processed")).toMatch(/cannot follow/);
  });
});

describe("upi", () => {
  const profile = getProvider("upi")!;
  const run = (...emits: string[]) =>
    simulate(
      profile,
      [entityFor(profile)],
      emits.map((emit) => ({ emit: `upi.collect.${emit}`, entity: "e1" })),
      42,
    );

  it("goes from initiated through pending to success, with a bank reference", () => {
    const { events, entities } = run("initiated", "pending", "success");
    expect(entities[0]!.ledger).toMatchObject({ state: "success", effects: { credit: 1 } });
    expect(events[2]!.payload).toMatchObject({
      event_type: "upi.collect.success",
      collect: { status: "success", amount: { value_minor: 49_900, currency: "INR" } },
    });
    expect(JSON.stringify(events[2]!.payload)).toMatch(/"rrn":"\d{12}"/);
    expect(events[1]!.payload).toMatchObject({ collect: { rrn: null } });
  });

  it("allows a late bank confirmation after expiry, and nothing else after it", () => {
    const { entities } = run("initiated", "pending", "expired", "success");
    expect(entities[0]!.ledger).toMatchObject({
      state: "success",
      balanceMinor: 49_900,
      effects: { credit: 1 },
    });
    expect(() => run("initiated", "pending", "expired", "failed")).toThrow(/cannot follow/);
    expect(() => run("initiated", "pending", "success", "expired")).toThrow(/cannot follow/);
  });

  it("only takes rupees", () => {
    expect(() => simulate(profile, [{ ...entityFor(profile), currency: "USD" }], [], 1)).toThrow(
      /supports INR/,
    );
  });
});

describe("booking", () => {
  const profile = getProvider("booking")!;
  const run = (...emits: (string | LogicalStep)[]) =>
    simulate(
      profile,
      [entityFor(profile, 450_000)],
      emits.map((e) => (typeof e === "string" ? { emit: e, entity: "e1" } : e)),
      42,
    );

  it("creates, confirms and takes payment", () => {
    const { entities, events } = run(
      "reservation.created",
      "reservation.confirmed",
      "payment.captured",
    );
    expect(entities[0]!.providerId).toMatch(/^res_/);
    expect(entities[0]!.ledger).toMatchObject({
      state: "paid",
      balanceMinor: 450_000,
      effects: { booking: 1, credit: 1 },
    });
    expect(events[2]!.payload).toMatchObject({
      type: "payment.captured",
      data: { reservation: { status: "paid", paid_minor: 450_000, currency: "INR" } },
    });
  });

  it("cancelling frees the booking but keeps the money until a refund", () => {
    const { entities } = run(
      "reservation.created",
      "reservation.confirmed",
      "payment.captured",
      "reservation.cancelled",
    );
    expect(entities[0]!.ledger).toMatchObject({
      state: "cancelled",
      balanceMinor: 450_000,
      effects: { booking: 0, credit: 1 },
    });
  });

  it("two different partial refunds both count", () => {
    const refund = (amount_minor: number) => ({
      emit: "refund.processed",
      entity: "e1",
      amount_minor,
    });
    const { entities, events } = run(
      "reservation.created",
      "reservation.confirmed",
      "payment.captured",
      refund(100_000),
      refund(50_000),
    );
    expect(entities[0]!.ledger).toMatchObject({
      state: "paid",
      balanceMinor: 300_000,
      effects: { refund: 2 },
    });
    const refundId = (i: number) =>
      (events[i]!.payload.data as { refund: { id: string } }).refund.id;
    expect(refundId(3)).not.toBe(refundId(4));
  });

  it("a full refund after a cancel ends at refunded, with no money held", () => {
    const { entities } = run(
      "reservation.created",
      "reservation.confirmed",
      "payment.captured",
      "reservation.cancelled",
      "refund.processed",
    );
    expect(entities[0]!.ledger).toMatchObject({ state: "refunded", balanceMinor: 0 });
  });

  it("refuses illegal sequences", () => {
    expect(() => run("reservation.confirmed")).toThrow(/cannot follow state "none"/);
    expect(() => run("reservation.created", "payment.captured")).toThrow(/cannot follow/);
    expect(() =>
      run("reservation.created", "reservation.cancelled", "reservation.confirmed"),
    ).toThrow(/cannot follow state "cancelled"/);
    expect(() => run("reservation.created", "reservation.cancelled", "refund.processed")).toThrow(
      /nothing is left to refund/,
    );
  });
});

describe("simulate", () => {
  const profile = getProvider("payments")!;

  it("names the step and the problem", () => {
    let error: unknown;
    try {
      simulate(profile, [entityFor(profile)], [{ emit: "payment.teleported", entity: "e1" }], 1);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(IllegalSequenceError);
    expect((error as IllegalSequenceError).stepIndex).toBe(0);
    expect((error as IllegalSequenceError).message).toMatch(/no event "payment.teleported"/);
  });

  it("refuses an unknown entity, a wrong kind and an unsupported currency", () => {
    const entity = entityFor(profile);
    expect(() =>
      simulate(profile, [entity], [{ emit: "payment.failed", entity: "nope" }], 1),
    ).toThrow(/no entity called "nope"/);
    expect(() => simulate(profile, [{ ...entity, kind: "reservation" }], [], 1)).toThrow(/kind/);
    expect(() => simulate(profile, [{ ...entity, currency: "XXX" }], [], 1)).toThrow(/supports/);
  });

  it("keeps entities independent, so adding one does not change another's ids", () => {
    const one = simulate(profile, [entityFor(profile)], [], 5);
    const two = simulate(profile, [{ ...entityFor(profile), id: "e0" }, entityFor(profile)], [], 5);
    expect(two.entities.find((e) => e.id === "e1")!.providerId).toBe(one.entities[0]!.providerId);
  });

  it("does not treat inherited names as providers or events", () => {
    expect(getProvider("constructor")).toBeUndefined();
    const ledger = newLedger(profile, { amount_minor: 1 });
    expect(whyIllegal(profile, ledger, "toString")).toMatch(/no event/);
  });
});
