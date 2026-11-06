import { readMurphyBlock } from "@murphy/core";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { compile, parseScenario, ScenarioError } from "../src/index.js";

type Doc = Record<string, unknown>;

/** A valid booking scenario, to change one thing at a time. */
function base(): Doc {
  return {
    version: 1,
    slug: "test-scenario",
    name: "Test",
    difficulty: "beginner",
    provider: "booking",
    seed: 42,
    entities: [{ id: "stay", kind: "reservation", amount_minor: 450_000, currency: "INR" }],
    timeline: [
      { id: "created", emit: "reservation.created", entity: "stay" },
      { id: "confirmed", emit: "reservation.confirmed", entity: "stay" },
      { id: "cancelled", emit: "reservation.cancelled", entity: "stay" },
    ],
    assertions: [{ final_state: { entity: "stay", state: "cancelled" } }],
  };
}

function withFaults(faults: unknown, step = 2): Doc {
  const doc = base();
  const timeline = doc.timeline as Doc[];
  timeline[step] = { ...timeline[step], faults };
  return doc;
}

function issues(doc: Doc | string): string[] {
  try {
    parseScenario(typeof doc === "string" ? doc : stringify(doc));
  } catch (err) {
    if (err instanceof ScenarioError) return err.issues.map((i) => `${i.path}: ${i.message}`);
    throw err;
  }
  return [];
}

const parse = (doc: Doc) => parseScenario(stringify(doc));
const RUN = "6e0f0c1c-0000-4000-8000-000000000001";

describe("parseScenario", () => {
  it("accepts a valid scenario and applies defaults", () => {
    const scenario = parse(base());
    expect(scenario.step_gap_ms).toBe(1_500);
    expect(scenario.timeline).toHaveLength(3);
  });

  it("reports broken YAML", () => {
    expect(issues("a: [1,")[0]).toMatch(/not valid YAML/);
  });

  it("reports a missing field by path", () => {
    const doc = base();
    delete doc.slug;
    expect(issues(doc)[0]).toMatch(/^slug: /);
  });

  it("rejects unknown keys, so a typo is not silently ignored", () => {
    expect(issues({ ...base(), asertions: [] }).join()).toMatch(/asertions/);
    expect(issues(withFaults({ duplcate: {} })).join()).toMatch(/timeline\[2\]\.faults.*duplcate/);
  });

  it("names an unknown provider and lists the real ones", () => {
    expect(issues({ ...base(), provider: "kyc" })).toEqual([
      'provider: unknown provider "kyc" (use: payments, upi, booking)',
    ]);
  });

  it("rejects fractional minor units", () => {
    const doc = base();
    (doc.entities as Doc[])[0]!.amount_minor = 499.5;
    expect(issues(doc)[0]).toMatch(/^entities\[0\]\.amount_minor: /);
  });

  it("rejects an illegal sequence and names the step", () => {
    const doc = base();
    (doc.timeline as Doc[]).reverse();
    doc.assertions = [{ exactly_once_effect: { entity: "stay" } }];
    expect(issues(doc)[0]).toMatch(/^timeline\[0\]\.emit: reservation\.cancelled cannot follow/);
  });

  it("rejects an unknown entity, a repeated step id and an unknown assertion entity", () => {
    const unknown = base();
    (unknown.timeline as Doc[])[0]!.entity = "ghost";
    expect(issues(unknown)[0]).toBe('timeline[0].entity: no entity called "ghost"');

    const repeated = base();
    (repeated.timeline as Doc[])[1]!.id = "created";
    expect(issues(repeated)[0]).toMatch(/the step id "created" is used twice/);

    expect(
      issues({ ...base(), assertions: [{ final_state: { entity: "ghost", state: "x" } }] })[0],
    ).toMatch(/assertions\[0\]\.final_state\.entity: no entity called "ghost"/);
  });

  it("rejects a final_state the timeline cannot reach", () => {
    expect(
      issues({ ...base(), assertions: [{ final_state: { entity: "stay", state: "confirmed" } }] }),
    ).toEqual([
      'assertions[0].final_state.state: the timeline ends "stay" in state "cancelled", not "confirmed"',
    ]);
    expect(
      issues({
        ...base(),
        assertions: [{ final_state: { entity: "stay", state: "cancelled", balance_minor: 9 } }],
      })[0],
    ).toMatch(/balance of 0, not 9/);
  });

  it("rejects assertions that could never fail", () => {
    expect(
      issues({ ...base(), assertions: [{ no_double_credit: { entity: "stay" } }] })[0],
    ).toMatch(/never credited.*could never fail/);
    expect(
      issues({ ...base(), assertions: [{ ordering_tolerated: { entity: "stay" } }] })[0],
    ).toMatch(/no step.*reordered or delayed/);
    const noBooking = base();
    noBooking.timeline = [{ id: "created", emit: "reservation.created", entity: "stay" }];
    noBooking.assertions = [{ no_double_booking: { entity: "stay" } }];
    expect(issues(noBooking)[0]).toMatch(/never booked/);
  });

  it("rejects faults that make no sense", () => {
    expect(issues(withFaults({ reorder_before: "nope" }))[0]).toBe(
      'timeline[2].faults.reorder_before: no step called "nope"',
    );
    expect(issues(withFaults({ reorder_before: "confirmed" }, 0))[0]).toMatch(
      /does not come before "created"/,
    );
    expect(issues(withFaults({ delay_ms: 100, reorder_before: "confirmed" }))[0]).toMatch(
      /a delay can undo the reorder/,
    );
    expect(
      issues(withFaults({ duplicate: {}, drop_then_redeliver: { lost: "response" } }))[0],
    ).toMatch(/cannot be combined/);
    expect(
      issues(withFaults({ respond_with: [503], drop_then_redeliver: { lost: "request" } }))[0],
    ).toMatch(/not both/);
  });

  it("rejects a reorder onto a step that is itself reordered", () => {
    const doc = base();
    const timeline = doc.timeline as Doc[];
    timeline[1] = { ...timeline[1], faults: { reorder_before: "created" } };
    timeline[2] = { ...timeline[2], faults: { reorder_before: "confirmed" } };
    expect(issues(doc)[0]).toMatch(/is itself reordered/);
  });

  it("rejects forced statuses that would break the run", () => {
    expect(issues(withFaults({ respond_with: [410] }))[0]).toMatch(/really disable the endpoint/);
    expect(issues(withFaults({ respond_with: [302] }))[0]).toMatch(/302 is not retried/);
    expect(issues(withFaults({ respond_with: [200] }))[0]).toMatch(/200 is not retried/);
    expect(issues(withFaults({ respond_with: [503, 503, 503] }))[0]).toMatch(/respond_with/);
    expect(issues(withFaults({ respond_with: [503, 429] }))).toEqual([]);
  });

  it("lists every problem at once", () => {
    const doc = base();
    (doc.timeline as Doc[])[0]!.entity = "ghost";
    (doc.timeline as Doc[])[1]!.entity = "phantom";
    expect(issues(doc)).toHaveLength(2);
  });

  it("refuses a huge file and alias bombs", () => {
    expect(issues("x".repeat(70_000))[0]).toMatch(/larger than/);
    const anchors = ["a0: &a0 [x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i <= 12; i++)
      anchors.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}]`);
    expect(issues(anchors.join("\n"))[0]).toMatch(/not valid YAML/);
  });
});

describe("compile", () => {
  const compiled = (doc: Doc, seed?: number) => compile(parse(doc), { runId: RUN, seed });
  const offsets = (doc: Doc) =>
    Object.fromEntries(compiled(doc).steps.map((s) => [s.id, s.due_offsets_ms]));

  it("spaces steps by the gap, after a lead time", () => {
    expect(offsets(base())).toEqual({
      created: [1_000],
      confirmed: [2_500],
      cancelled: [4_000],
    });
  });

  it("a delay moves only that step", () => {
    expect(offsets(withFaults({ delay_ms: 700 }, 1))).toEqual({
      created: [1_000],
      confirmed: [3_200],
      cancelled: [4_000],
    });
  });

  it("a duplicate adds a second row, and does not move others", () => {
    expect(offsets(withFaults({ duplicate: { after_ms: 300 } }, 1))).toEqual({
      created: [1_000],
      confirmed: [2_500, 2_800],
      cancelled: [4_000],
    });
  });

  it("a reorder sends the step before its target, keeping the logical order", () => {
    const plan = compiled(withFaults({ reorder_before: "confirmed" }));
    expect(Object.fromEntries(plan.steps.map((s) => [s.id, s.due_offsets_ms]))).toEqual({
      created: [1_000],
      cancelled: [2_500],
      confirmed: [4_000],
    });
    expect(plan.steps.map((s) => s.id)).toEqual(["created", "confirmed", "cancelled"]);
  });

  it("time scale shrinks every wait", () => {
    const plan = compile(parse(withFaults({ duplicate: { after_ms: 1_000 } }, 1)), {
      runId: RUN,
      timeScale: 0.1,
    });
    expect(plan.steps[1]!.due_offsets_ms).toEqual([250, 350]);
  });

  it("marks every event as simulated, in a signed top-level block", () => {
    const plan = compiled(base());
    for (const step of plan.steps) {
      expect(readMurphyBlock(step.payload)).toMatchObject({
        simulated: true,
        version: 1,
        run_id: RUN,
        scenario: "test-scenario",
        step: step.id,
        event: step.emit,
        entity_id: step.provider_id,
      });
    }
  });

  it("only target faults appear in the block", () => {
    const block = (faults: unknown) =>
      readMurphyBlock(compiled(withFaults(faults)).steps[2]!.payload)!;
    expect(block({ duplicate: {} }).forced_responses).toBeUndefined();
    expect(block({ delay_ms: 5 }).forced_responses).toBeUndefined();
    expect(block({ reorder_before: "confirmed" }).forced_responses).toBeUndefined();
    expect(block({ drop_then_redeliver: { lost: "response" } }).forced_responses).toEqual([
      { status: 503, run_handler: true },
    ]);
    expect(block({ drop_then_redeliver: { lost: "request" } }).forced_responses).toEqual([
      { status: 503, run_handler: false },
    ]);
    expect(block({ respond_with: [500, 429] }).forced_responses).toEqual([
      { status: 500, run_handler: false },
      { status: 429, run_handler: false },
    ]);
  });

  it("says plainly who realises each fault", () => {
    const by = (faults: unknown) =>
      compiled(withFaults(faults)).steps[2]!.faults.map((f) => [f.kind, f.realised_by]);
    expect(by({ delay_ms: 5 })).toEqual([["delay", "engine"]]);
    expect(by({ reorder_before: "confirmed" })).toEqual([["reorder", "engine"]]);
    expect(by({ duplicate: {} })).toEqual([["duplicate", "engine"]]);
    expect(by({ drop_then_redeliver: { lost: "response" } })).toEqual([
      ["drop_then_redeliver", "target"],
    ]);
    expect(by({ respond_with: [503] })).toEqual([["respond_with", "target"]]);
  });

  it("takes expected state from the state machine", () => {
    expect(compiled(base()).entities[0]).toMatchObject({
      id: "stay",
      kind: "reservation",
      expected: { state: "cancelled", balance_minor: 0, effects: { booking: 0 } },
    });
  });

  it("is deterministic: same seed and run give the same plan, a new seed changes the payloads", () => {
    expect(compiled(base())).toEqual(compiled(base()));
    expect(compiled(base(), 7).steps[0]!.provider_id).not.toBe(
      compiled(base(), 8).steps[0]!.provider_id,
    );
    expect(compiled(base(), 7).seed).toBe(7);
  });

  it("allows for retries in the deadline", () => {
    const quiet = compiled(base()).deadline_offset_ms;
    const retried = compiled(withFaults({ respond_with: [503, 503] })).deadline_offset_ms;
    expect(retried - quiet).toBeGreaterThanOrEqual(35_000);
  });

  it("a custom retry schedule shortens the deadline", () => {
    const plan = compile(parse(withFaults({ respond_with: [503, 503] })), {
      runId: RUN,
      retrySchedule: [10, 10],
    });
    expect(plan.deadline_offset_ms).toBeLessThan(compiled(base()).deadline_offset_ms + 100);
  });
});

describe("readMurphyBlock", () => {
  const good = {
    simulated: true,
    version: 1,
    run_id: "r",
    scenario: "s",
    step: "t",
    event: "e",
    entity_id: "i",
  };

  it("reads a good block, and ignores ordinary events", () => {
    expect(readMurphyBlock({ _murphy: good })).toEqual(good);
    expect(readMurphyBlock({ id: "pay_1" })).toBeNull();
    expect(readMurphyBlock(null)).toBeNull();
    expect(readMurphyBlock("text")).toBeNull();
  });

  it("rejects malformed blocks rather than half-obeying them", () => {
    expect(readMurphyBlock({ _murphy: { ...good, simulated: false } })).toBeNull();
    expect(readMurphyBlock({ _murphy: { ...good, version: 2 } })).toBeNull();
    expect(readMurphyBlock({ _murphy: { ...good, run_id: 1 } })).toBeNull();
    expect(readMurphyBlock({ _murphy: { ...good, forced_responses: "503" } })).toBeNull();
    expect(
      readMurphyBlock({ _murphy: { ...good, forced_responses: [{ status: "503" }] } }),
    ).toBeNull();
  });
});
