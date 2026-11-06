import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  compile,
  evaluateRun,
  parseScenario,
  renderReport,
  runReportSchema,
  targetStateSchema,
  type EvidenceDelivery,
  type RunPlan,
  type StateResult,
} from "../src/index.js";

const START = new Date("2026-11-07T10:00:00.000Z");
const at = (ms: number) => new Date(START.getTime() + ms);
const RUN = "6e0f0c1c-0000-4000-8000-000000000001";

function planWith(faults: Record<string, unknown>, assertions?: unknown[]): RunPlan {
  const timeline = [
    { id: "created", emit: "reservation.created", entity: "stay" },
    { id: "confirmed", emit: "reservation.confirmed", entity: "stay" },
    { id: "cancelled", emit: "reservation.cancelled", entity: "stay" },
  ].map((step) => (faults[step.id] ? { ...step, faults: faults[step.id] } : step));
  return compile(
    parseScenario(
      stringify({
        version: 1,
        slug: "test",
        name: "Test scenario",
        difficulty: "beginner",
        provider: "booking",
        seed: 42,
        entities: [{ id: "stay", kind: "reservation", amount_minor: 1000, currency: "INR" }],
        timeline,
        assertions: assertions ?? [
          { final_state: { entity: "stay", state: "cancelled" } },
          { exactly_once_effect: { entity: "stay" } },
        ],
      }),
    ),
    { runId: RUN },
  );
}

/** One delivered row per planned offset, each answered 200 at its planned time. */
function delivered(plan: RunPlan, overrides: Record<string, Partial<EvidenceDelivery>[]> = {}) {
  return plan.steps.flatMap((step) =>
    step.due_offsets_ms.map((offset, i): EvidenceDelivery => ({
      deliveryId: `${step.id}-${i}`,
      eventId: `event-${step.id}`,
      step: step.id,
      status: "succeeded",
      attempts: [
        {
          attemptNo: 1,
          startedAt: at(offset + 50),
          durationMs: 5,
          responseStatus: 200,
          error: null,
        },
      ],
      ...overrides[step.id]?.[i],
    })),
  );
}

function correctState(plan: RunPlan): StateResult {
  return {
    ok: true,
    state: {
      entities: Object.fromEntries(plan.entities.map((e) => [e.provider_id, { ...e.expected }])),
    },
  };
}

function report(
  plan: RunPlan,
  deliveries: EvidenceDelivery[] = delivered(plan),
  state: StateResult = correctState(plan),
  deadlinePassed = false,
) {
  return evaluateRun({
    plan,
    endpointId: "ep-1",
    targetLabel: "naive",
    startedAt: START,
    finishedAt: at(9_000),
    deadlinePassed,
    deliveries,
    state,
  });
}

function withEffects(plan: RunPlan, changes: Record<string, unknown>): StateResult {
  const entity = plan.entities[0]!;
  return {
    ok: true,
    state: {
      entities: {
        [entity.provider_id]: {
          ...entity.expected,
          ...changes,
          effects: { ...entity.expected.effects, ...(changes.effects as object) },
        },
      },
    },
  };
}

const attempt = (n: number, ms: number, status: number | null, error: string | null = null) => ({
  attemptNo: n,
  startedAt: at(ms),
  durationMs: 5,
  responseStatus: status,
  error,
});

describe("verdict", () => {
  it("passes when every assertion holds and every fault happened", () => {
    const r = report(planWith({}));
    expect(r.run).toMatchObject({ status: "passed", reason: null, seed: 42, duration_ms: 9_000 });
    expect(r.assertions.every((a) => a.status === "pass")).toBe(true);
  });

  it("fails on a wrong final state, and says what it was", () => {
    const plan = planWith({});
    const r = report(plan, delivered(plan), withEffects(plan, { state: "confirmed" }));
    expect(r.run.status).toBe("failed");
    expect(r.assertions[0]).toMatchObject({
      kind: "final_state",
      status: "fail",
      reason: 'Ended in "confirmed", expected "cancelled"',
    });
    expect(r.run.reason).toMatch(/2 of 2 assertions failed/);
  });

  it("errored runs prove nothing, whatever the assertions say", () => {
    const plan = planWith({ confirmed: { duplicate: { after_ms: 100 } } });
    const one = delivered(plan).filter((d) => d.deliveryId !== "confirmed-1");
    const r = report(plan, one);
    expect(r.run.status).toBe("errored");
    expect(r.run.reason).toMatch(/proves nothing.*duplicate on "confirmed"/);
  });

  it("is errored when a run got stuck past its deadline", () => {
    const plan = planWith({});
    const rows = delivered(plan);
    rows[0]!.status = "pending";
    rows[0]!.attempts = [];
    const r = report(plan, rows, correctState(plan), true);
    expect(r.run.status).toBe("errored");
    expect(r.run.reason).toMatch(/stuck: 1 deliveries/);
  });

  it("is errored when a delivery went dead, and points at the likely cause", () => {
    const plan = planWith({});
    const rows = delivered(plan);
    rows[1]!.status = "dead";
    rows[1]!.attempts = [attempt(1, 100, 401)];
    const r = report(plan, rows);
    expect(r.run.status).toBe("errored");
    expect(r.run.reason).toMatch(/never got through \(dead, last answer: 401\).*secret/);
  });

  it("is errored when the state cannot be read, and marks assertions not evaluated", () => {
    const plan = planWith({});
    const r = report(plan, delivered(plan), { ok: false, error: "connection refused" });
    expect(r.run.status).toBe("errored");
    expect(r.run.reason).toMatch(/connection refused/);
    expect(new Set(r.assertions.map((a) => a.status))).toEqual(new Set(["not_evaluated"]));
  });

  it("fails if the target reported nothing for the entity", () => {
    const plan = planWith({});
    const r = report(plan, delivered(plan), { ok: true, state: { entities: {} } });
    expect(r.run.status).toBe("failed");
    expect(r.assertions[0]!.reason).toMatch(/reported nothing/);
    expect(r.entities[0]!.actual).toBeNull();
  });
});

describe("assertions", () => {
  const booked = () => planWith({}, [{ no_double_booking: { entity: "stay" } }]);

  it("no_double_booking fails above the expected count", () => {
    const plan = booked();
    const r = report(plan, delivered(plan), withEffects(plan, { effects: { booking: 1 } }));
    expect(r.assertions[0]).toMatchObject({ status: "fail" });
    expect(r.assertions[0]!.reason).toMatch(/Holds 1 bookings, expected 0/);
  });

  it("exactly_once_effect lists every difference", () => {
    const plan = planWith({});
    const r = report(
      plan,
      delivered(plan),
      withEffects(plan, { balance_minor: 7, effects: { refund: 3 } }),
    );
    const reason = r.assertions[1]!.reason;
    expect(reason).toMatch(/balance is 7, expected 0/i);
    expect(reason).toMatch(/refund effect is 3, expected 0/);
  });

  it("no_double_credit compares against the state machine", () => {
    const yaml = stringify({
      version: 1,
      slug: "credit",
      name: "Credit",
      difficulty: "beginner",
      provider: "payments",
      seed: 1,
      entities: [{ id: "pay", kind: "payment", amount_minor: 1000, currency: "INR" }],
      timeline: [
        { id: "auth", emit: "payment.authorized", entity: "pay" },
        { id: "capture", emit: "payment.captured", entity: "pay" },
      ],
      assertions: [{ no_double_credit: { entity: "pay" } }],
    });
    const plan = compile(parseScenario(yaml), { runId: RUN });
    const good = report(plan);
    expect(good.assertions[0]).toMatchObject({ status: "pass", reason: "Credited 1 time(s)" });
    const bad = report(plan, delivered(plan), withEffects(plan, { effects: { credit: 2 } }));
    expect(bad.assertions[0]!.reason).toMatch(/Credited 2 times, expected 1/);
  });

  it("final_state also checks a stated balance", () => {
    const plan = planWith({}, [
      { final_state: { entity: "stay", state: "cancelled", balance_minor: 0 } },
    ]);
    const r = report(plan, delivered(plan), withEffects(plan, { balance_minor: 5 }));
    expect(r.assertions[0]!.reason).toBe("Balance is 5, expected 0");
  });
});

describe("faults are checked against the attempt log", () => {
  const faultOf = (r: ReturnType<typeof report>) => r.faults[0]!;

  it("delay: happened if the first attempt was not early", () => {
    const plan = planWith({ confirmed: { delay_ms: 5_000 } });
    expect(faultOf(report(plan))).toMatchObject({ kind: "delay", realised: true });
    const early = delivered(plan, { confirmed: [{ attempts: [attempt(1, 100, 200)] }] });
    expect(faultOf(report(plan, early))).toMatchObject({ realised: false });
    expect(report(plan, early).run.status).toBe("errored");
  });

  it("delay allows for a small difference between clocks", () => {
    const plan = planWith({ confirmed: { delay_ms: 5_000 } });
    const due = plan.steps[1]!.due_offsets_ms[0]!;
    const slightly = delivered(plan, { confirmed: [{ attempts: [attempt(1, due - 900, 200)] }] });
    expect(faultOf(report(plan, slightly)).realised).toBe(true);
  });

  it("reorder: happened only if the order really inverted", () => {
    const plan = planWith({ cancelled: { reorder_before: "confirmed" } });
    expect(faultOf(report(plan))).toMatchObject({ kind: "reorder", realised: true });
    expect(faultOf(report(plan)).evidence).toMatch(/Arrived 1500 ms before "confirmed"/);

    const late = delivered(plan, { cancelled: [{ attempts: [attempt(1, 99_000, 200)] }] });
    const r = report(plan, late);
    expect(faultOf(r)).toMatchObject({ realised: false });
    expect(faultOf(r).evidence).toMatch(/timing cancelled the reorder/);
    expect(r.run.status).toBe("errored");
  });

  it("duplicate: happened only if both copies got a 2xx", () => {
    const plan = planWith({ confirmed: { duplicate: { after_ms: 100 } } });
    expect(faultOf(report(plan)).realised).toBe(true);
    const refused = delivered(plan, {
      confirmed: [{}, { status: "dead", attempts: [attempt(1, 2_000, 400)] }],
    });
    expect(faultOf(report(plan, refused)).realised).toBe(false);
  });

  it("drop_then_redeliver: 503 then 2xx, else the target did not cooperate", () => {
    const plan = planWith({ confirmed: { drop_then_redeliver: { lost: "response" } } });
    const obeyed = delivered(plan, {
      confirmed: [{ attempts: [attempt(1, 2_500, 503), attempt(2, 7_500, 200)] }],
    });
    expect(faultOf(report(plan, obeyed))).toMatchObject({
      realised: true,
      realised_by: "target",
    });

    const ignored = report(plan);
    expect(faultOf(ignored).realised).toBe(false);
    expect(faultOf(ignored).evidence).toMatch(/did not obey the _murphy block/);
    expect(ignored.run.status).toBe("errored");
  });

  it("respond_with: the listed statuses then 2xx", () => {
    const plan = planWith({ confirmed: { respond_with: [500, 429] } });
    const obeyed = delivered(plan, {
      confirmed: [
        { attempts: [attempt(1, 2_500, 500), attempt(2, 7_500, 429), attempt(3, 38_000, 200)] },
      ],
    });
    expect(faultOf(report(plan, obeyed)).realised).toBe(true);
    const wrong = delivered(plan, {
      confirmed: [{ attempts: [attempt(1, 2_500, 500), attempt(2, 7_500, 200)] }],
    });
    expect(faultOf(report(plan, wrong)).realised).toBe(false);
  });

  it("states who realised each fault", () => {
    const plan = planWith({
      created: { delay_ms: 1 },
      confirmed: { duplicate: { after_ms: 1 } },
      cancelled: { drop_then_redeliver: { lost: "request" } },
    });
    const by = Object.fromEntries(report(plan).faults.map((f) => [f.kind, f.realised_by]));
    expect(by).toEqual({ delay: "engine", duplicate: "engine", drop_then_redeliver: "target" });
  });
});

describe("the report", () => {
  it("is valid against its own schema and versioned", () => {
    const r = report(planWith({ confirmed: { duplicate: { after_ms: 100 } } }));
    expect(r.schema_version).toBe(1);
    expect(runReportSchema.safeParse(JSON.parse(JSON.stringify(r))).success).toBe(true);
  });

  it("gives a per-step record and a timeline in real order", () => {
    const plan = planWith({ cancelled: { reorder_before: "confirmed" } });
    const r = report(plan);
    expect(r.steps.map((s) => s.id)).toEqual(["created", "confirmed", "cancelled"]);
    expect(r.timeline.map((t) => t.step)).toEqual(["created", "cancelled", "confirmed"]);
    expect(r.steps[2]).toMatchObject({
      event_type: "reservation.cancelled",
      webhook_id: "msg_event-cancelled",
      fault_kinds: ["reorder"],
    });
    expect(r.summary).toMatchObject({ deliveries: 3, attempts: 3, faults_realised: 1 });
  });

  it("never contains request headers or signatures", () => {
    const text = JSON.stringify(report(planWith({})));
    expect(text).not.toMatch(/signature|whsec_/i);
  });

  it("states its limits", () => {
    const text = report(planWith({})).limits.join(" ");
    expect(text).toMatch(/not exact copies/);
    expect(text).toMatch(/target itself reported/);
  });
});

describe("markdown", () => {
  it("leads with the verdict and names the handler", () => {
    const plan = planWith({});
    const text = renderReport(report(plan, delivered(plan), withEffects(plan, { state: "x" })));
    expect(text.split("\n")[0]).toBe("# FAILED: Test scenario");
    expect(text).toMatch(/\| Handler \| naive \|/);
    expect(text).toMatch(/\| FAIL \| final_state \| stay \|/);
    expect(text).toMatch(/## What this does not prove/);
  });

  it("says plainly which faults came from Murphy and which from the target", () => {
    const plan = planWith({
      confirmed: { duplicate: { after_ms: 100 } },
      cancelled: { drop_then_redeliver: { lost: "response" } },
    });
    const text = renderReport(report(plan));
    expect(text).toMatch(/\*\*Engine\*\* faults came from Murphy's real delivery worker alone/);
    expect(text).toMatch(/\| confirmed \| duplicate \| Engine \|/);
    expect(text).toMatch(/\| cancelled \| drop_then_redeliver \| Target \|/);
    expect(text).toMatch(/\*\*No\*\*/);
  });

  it("escapes table cells, and says when no faults ran", () => {
    const plan = planWith({});
    const text = renderReport(report(plan, delivered(plan), withEffects(plan, { state: "a|b" })));
    expect(text).toContain("a\\|b");
    expect(text).toContain("None.");
  });
});

describe("target state contract", () => {
  it("fills in what a target leaves out, and ignores extras", () => {
    expect(
      targetStateSchema.parse({ entities: { a: { state: "x", extra: 1 } }, more: true }),
    ).toEqual({
      entities: {
        a: {
          state: "x",
          balance_minor: 0,
          effects: { credit: 0, booking: 0, refund: 0, hold: 0 },
        },
      },
    });
  });

  it("rejects what cannot be understood", () => {
    expect(targetStateSchema.safeParse({}).success).toBe(false);
    expect(targetStateSchema.safeParse({ entities: { a: { state: 1 } } }).success).toBe(false);
  });
});
