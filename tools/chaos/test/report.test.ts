import { describe, expect, it } from "vitest";
import { makePlan } from "../src/plan.js";
import { buildReport, renderRunReport, verdict, type RunMeta } from "../src/report.js";
import { expectedFailure, isSabotage } from "../src/sabotage.js";
import { renderSummary } from "../src/summary.js";
import type { RunResult } from "../src/types.js";

const result: RunResult = {
  invariants: [
    {
      id: "I1",
      title: "Every 202 is durable",
      sources: "client log vs database",
      status: "pass",
      checked: 10,
      violations: 0,
      examples: [],
    },
    {
      id: "I8",
      title: "No leases",
      sources: "database only",
      status: "pass",
      checked: 5,
      violations: 0,
      examples: [],
      note: "This compares the database with itself.",
    },
  ],
  effects: [{ name: "Worker kills abandoned real work", ok: true, evidence: "3 leases" }],
  counts: { eventsAcked: 10, deliveries: 20, noDeliveryByDesign: 2 },
  deliveriesByStatus: { succeeded: 20 },
  deliveriesByProfile: { control: { succeeded: 20 } },
  duplicates: { total: 4, byCause: { "receiver processed it, then answered 500": 4 } },
  latency: { "First arrival, control endpoint": { count: 10, p50: 12, p95: 300 } },
  killedWorkerLeases: { "w0.0": 3 },
  vacuous: false,
  passed: true,
};

const meta: RunMeta = {
  seed: 1001,
  plan: makePlan({ seed: 1001, events: 10 }),
  startedAt: "2026-11-05T00:00:00.000Z",
  durationSeconds: 100,
  drainSeconds: 20,
  settings: { fsync: "on" },
  control: [
    { t: 5000, action: "kill_worker", phase: "start", target: "w0.0", detail: "pid 1" },
    { t: 5001, action: "kill_worker", phase: "done", target: "w0.0" },
  ],
  loadStartedAt: 1000,
  sabotage: null,
  sabotageDetail: null,
  unexpectedExits: [],
  drainTimedOut: false,
};

describe("chaos report", () => {
  const report = buildReport(meta, result);
  const text = renderRunReport(report);

  it("states the result, the seed and how to rerun it", () => {
    expect(text).toContain("**Result: PASS.** Seed 1001");
    expect(text).toContain("pnpm chaos --seed 1001");
  });

  it("names the sources of each invariant and flags a database-only check", () => {
    expect(text).toContain("client log vs database");
    expect(text).toContain("This compares the database with itself.");
  });

  it("includes the faults with their timing, latency and duplicates by cause", () => {
    expect(text).toContain("| 4 s | SIGKILL worker | w0.0 |");
    expect(text).toContain("| First arrival, control endpoint | 10 | 12 ms | 300 ms |");
    expect(text).toContain("receiver processed it, then answered 500 | 4");
  });

  it("says what was not proven, including the disabled-endpoint limit", () => {
    expect(text).toContain("## What this does not prove");
    expect(text).toContain("Disabled and paused endpoints get no new deliveries");
    expect(text).toContain("Process crashes, not power loss");
    expect(text).toContain("Compressed time");
  });

  it("only includes start records in the timeline, and the JSON carries the plan hash", () => {
    expect(report.timeline).toHaveLength(1);
    expect(report.meta.planHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("shows failing examples and marks sabotaged runs", () => {
    const failed: RunResult = {
      ...result,
      passed: false,
      invariants: [
        { ...result.invariants[0]!, status: "fail", violations: 1, examples: ["k1: missing"] },
      ],
    };
    const damaged = renderRunReport(
      buildReport({ ...meta, sabotage: "lost-event", sabotageDetail: "deleted event x" }, failed),
    );
    expect(damaged).toContain("**Result: FAIL.**");
    expect(damaged).toContain("deliberately damaged");
    expect(damaged).toContain("`k1: missing`");
  });

  it("distinguishes a vacuous run from a failed one", () => {
    expect(verdict(buildReport(meta, { ...result, passed: false, vacuous: true }))).toMatch(
      /^VACUOUS/,
    );
  });
});

describe("sabotage modes", () => {
  it("accepts only the two modes, each with the invariant it must break", () => {
    expect(isSabotage("lost-event")).toBe(true);
    expect(isSabotage("fake-success")).toBe(true);
    expect(isSabotage("other")).toBe(false);
    expect(isSabotage(undefined)).toBe(false);
    expect(expectedFailure("lost-event")).toBe("I1");
    expect(expectedFailure("fake-success")).toBe("I5");
  });
});

describe("summary document", () => {
  const seed = (n: number, passed = true) =>
    buildReport({ ...meta, seed: n }, { ...result, passed });
  const control = (mode: "lost-event" | "fake-success", caught: boolean) =>
    buildReport(
      { ...meta, sabotage: mode, sabotageDetail: "damaged it" },
      {
        ...result,
        passed: false,
        invariants: [
          { ...result.invariants[0]!, id: "I1", status: caught ? "fail" : "pass" },
          { ...result.invariants[0]!, id: "I5", status: "pass" },
        ],
      },
    );

  it("counts passes honestly and adds up accepted events", () => {
    const text = renderSummary([seed(1), seed(2, false), seed(3)], [], "");
    expect(text).toContain("**2 of 3 seeded runs passed.**");
    expect(text).toContain("accepted 30 events");
    expect(text).toContain("# Full detail: seed 1");
  });

  it("states the limit on the claim in its headline, with the real count", () => {
    const counts = { ...result.counts, noDeliveryByDesign: 7 };
    const run = buildReport({ ...meta, seed: 1 }, { ...result, counts });
    const [headline] = renderSummary([run, run], [], "").split("## How to read this");
    expect(headline).toContain("gets no delivery for that endpoint");
    expect(headline).toContain("That happened 14 times");
    expect(headline).not.toContain("none was lost");
  });

  it("reports whether each negative control was caught", () => {
    expect(renderSummary([seed(1)], [control("lost-event", true)], "")).toContain(
      "failed, as it must",
    );
    expect(renderSummary([seed(1)], [control("lost-event", false)], "")).toContain(
      "**DID NOT FAIL**",
    );
  });

  it("refuses to treat a normal run as a negative control, or to summarise nothing", () => {
    expect(() => renderSummary([seed(1)], [seed(2)], "")).toThrow(/not a sabotage run/);
    expect(() => renderSummary([], [], "")).toThrow(/at least one/);
  });

  it("keeps the limits and the notes in the document", () => {
    const text = renderSummary([seed(1)], [], "## Bugs found\n\nA bug.");
    expect(text).toContain("Disabled and paused endpoints get no new deliveries");
    expect(text).toContain("## Bugs found");
  });
});
