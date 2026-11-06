import { readMurphyBlock } from "@murphy/core";
import type { TargetEvent } from "@murphy/sdk";
import {
  compile,
  getProvider,
  legalEvents,
  newLedger,
  parseScenario,
  PROVIDERS,
  simulate,
  type LogicalStep,
  type ProviderProfile,
} from "@murphy/simulator";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IdempotentHandler, NaiveHandler, type DemoHandler } from "../src/handlers.js";

const RUN = "run-1";

/** The events a provider would send, as a target would see them. */
function eventsFor(profile: ProviderProfile, steps: LogicalStep[], seed: number) {
  const entity = {
    id: "e1",
    kind: profile.entityKind,
    amount_minor: 90_000,
    currency: profile.currencies[0],
  };
  const sim = simulate(profile, [entity], steps, seed);
  const events: TargetEvent[] = sim.events.map((e) => ({
    webhookId: `msg_${e.index}`,
    type: e.type,
    payload: e.payload as Record<string, unknown>,
    murphy: {
      simulated: true,
      version: 1,
      run_id: RUN,
      scenario: "s",
      step: `s${e.index}`,
      event: e.type,
      entity_id: e.providerId,
    },
  }));
  return { events, final: sim.entities[0]! };
}

function walk(profile: ProviderProfile, choices: readonly number[]): LogicalStep[] {
  const steps: LogicalStep[] = [];
  let ledger = newLedger(profile, { amount_minor: 90_000 });
  for (const choice of choices) {
    const options = legalEvents(profile, ledger);
    if (options.length === 0) break;
    const emit = options[choice % options.length]!;
    steps.push({ emit, entity: "e1" });
    ledger = profile.transitions[emit]!.apply(ledger, undefined);
  }
  return steps;
}

function resultOf(handler: DemoHandler, id: string) {
  return handler.state(RUN).entities[id];
}

const expected = (final: ReturnType<typeof eventsFor>["final"]) => ({
  state: final.ledger.state,
  effects: final.ledger.effects,
  balance_minor: final.ledger.balanceMinor,
});

describe.each(Object.values(PROVIDERS).map((p) => [p.name, p] as const))(
  "%s handlers",
  (_name, profile) => {
    const path = fc.array(fc.nat(), { minLength: 1, maxLength: 8 });

    it("both handlers match the state machine when nothing goes wrong", () => {
      fc.assert(
        fc.property(path, (choices) => {
          const steps = walk(profile, choices);
          const { events, final } = eventsFor(profile, steps, 3);
          for (const handler of [new NaiveHandler(), new IdempotentHandler()]) {
            for (const event of events) handler.apply(event);
            expect(resultOf(handler, final.providerId)).toEqual(expected(final));
          }
        }),
      );
    });

    it("the idempotent handler matches it for any arrival order and any duplicates", () => {
      fc.assert(
        fc.property(
          path,
          fc.array(fc.nat(), { maxLength: 8 }),
          fc.integer(),
          (choices, copies, shuffle) => {
            const steps = walk(profile, choices);
            const { events, final } = eventsFor(profile, steps, 3);
            const arrivals = [...events, ...copies.map((c) => events[c % events.length]!)];
            // A seeded shuffle, so fast-check can shrink and replay a failure.
            const keyed = arrivals.map((event, i) => ({
              event,
              key: Math.imul(i + 1, shuffle | 1) >>> 0,
            }));
            keyed.sort((a, b) => a.key - b.key);

            const handler = new IdempotentHandler();
            for (const { event } of keyed) handler.apply(event);
            expect(resultOf(handler, final.providerId)).toEqual(expected(final));
          },
        ),
      );
    });
  },
);

describe("what the naive handler gets wrong", () => {
  const booking = getProvider("booking")!;
  const scenarioSteps = (...emits: string[]) => emits.map((emit) => ({ emit, entity: "e1" }));

  it("books twice on a duplicate", () => {
    const { events, final } = eventsFor(
      booking,
      scenarioSteps("reservation.created", "reservation.confirmed"),
      1,
    );
    const handler = new NaiveHandler();
    for (const event of [...events, events[1]!]) handler.apply(event);
    expect(resultOf(handler, final.providerId)!.effects.booking).toBe(2);
  });

  it("ends confirmed when a cancel arrives before the confirm", () => {
    const { events, final } = eventsFor(
      booking,
      scenarioSteps("reservation.created", "reservation.confirmed", "reservation.cancelled"),
      1,
    );
    const handler = new NaiveHandler();
    for (const event of [events[0]!, events[2]!, events[1]!]) handler.apply(event);
    expect(resultOf(handler, final.providerId)!.state).toBe("confirmed");
    expect(final.ledger.state).toBe("cancelled");
  });

  it("refunds twice when a refund webhook is redelivered", () => {
    const { events, final } = eventsFor(
      booking,
      scenarioSteps(
        "reservation.created",
        "reservation.confirmed",
        "payment.captured",
        "refund.processed",
      ),
      1,
    );
    const handler = new NaiveHandler();
    for (const event of [...events, events[3]!]) handler.apply(event);
    expect(resultOf(handler, final.providerId)!.effects.refund).toBe(2);
  });
});

describe("the idempotent handler", () => {
  const booking = getProvider("booking")!;

  it("counts two different partial refunds, which a dedupe on entity id would lose", () => {
    const { events, final } = eventsFor(
      booking,
      [
        { emit: "reservation.created", entity: "e1" },
        { emit: "reservation.confirmed", entity: "e1" },
        { emit: "payment.captured", entity: "e1" },
        { emit: "refund.processed", entity: "e1", amount_minor: 10_000 },
        { emit: "refund.processed", entity: "e1", amount_minor: 20_000 },
      ],
      1,
    );
    const handler = new IdempotentHandler();
    for (const event of events) handler.apply(event);
    expect(resultOf(handler, final.providerId)).toMatchObject({
      effects: { refund: 2 },
      balance_minor: 60_000,
    });
  });

  it("keeps runs apart", () => {
    const scenario = parseScenario(`
version: 1
slug: t
name: T
difficulty: beginner
provider: booking
seed: 1
entities:
  - { id: stay, kind: reservation, amount_minor: 100, currency: INR }
timeline:
  - { id: created, emit: reservation.created, entity: stay }
assertions:
  - final_state: { entity: stay, state: created }
`);
    const toEvent = (runId: string): TargetEvent => {
      const step = compile(scenario, { runId }).steps[0]!;
      return {
        webhookId: `msg_${runId}`,
        type: step.emit,
        payload: step.payload as Record<string, unknown>,
        murphy: readMurphyBlock(step.payload),
      };
    };
    const handler = new IdempotentHandler();
    handler.apply(toEvent("a"));
    expect(Object.keys(handler.state("a").entities)).toHaveLength(1);
    expect(handler.state("b").entities).toEqual({});
  });
});
