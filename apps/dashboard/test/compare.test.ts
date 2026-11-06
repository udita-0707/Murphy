import { describe, expect, it } from "vitest";
import { sideFromLive } from "@/lib/board";
import { compareSides, differences, type SideState } from "@/lib/compare";
import { fixtures as f } from "@/lib/fixtures";
import type { RunReport } from "@/lib/types";

const done = (report: RunReport): SideState => ({ phase: "done", report });
const running: SideState = {
  phase: "running",
  input: sideFromLive(f.liveRunning),
  lostContact: false,
  seed: 1,
  startedAt: null,
};

describe("differences", () => {
  it("finds 2 vs 1 on the booking effect, from the reports", () => {
    const found = differences(f.duplicateNaive, f.duplicateIdempotent);
    expect(found[0]).toMatchObject({
      name: "Booking effect",
      naive: "2",
      idempotent: "1",
      expected: "1",
      numeric: true,
    });
  });

  it("finds a difference in final state", () => {
    const found = differences(f.reorderNaive, f.reorderIdempotent);
    expect(found.map((d) => d.name)).toContain("Final state");
  });

  it("finds nothing when both reports agree", () => {
    expect(differences(f.duplicateIdempotent, f.duplicateIdempotent)).toEqual([]);
  });

  it("says when a side reported nothing, instead of inventing a number", () => {
    const silent = structuredClone(f.duplicateNaive);
    silent.entities[0]!.actual = null;
    const found = differences(silent, f.duplicateIdempotent);
    expect(found[0]).toMatchObject({ naive: "not reported", numeric: false });
  });
});

describe("compareSides", () => {
  it("shows the figure only when both sides finished fairly", () => {
    expect(compareSides(done(f.duplicateNaive), done(f.duplicateIdempotent)).kind).toBe("diverged");
  });

  it("waits while either side is running, and shows no figure", () => {
    expect(compareSides(running, running)).toEqual({ kind: "waiting", text: "Both running." });
    expect(compareSides(running, done(f.duplicateIdempotent))).toEqual({
      kind: "waiting",
      text: "Waiting for the other side.",
    });
    expect(compareSides(done(f.duplicateNaive), { phase: "loading" }).kind).toBe("waiting");
  });

  it("refuses to compare when one side errored, in the brief's words", () => {
    const result = compareSides(done(f.errored), done(f.duplicateIdempotent));
    expect(result).toEqual({
      kind: "no_comparison",
      text: "No comparison: one side was not a fair test, proves nothing.",
    });
  });

  it("refuses when an errored side finishes while the other is still running", () => {
    expect(compareSides(done(f.errored), running).kind).toBe("no_comparison");
  });

  it("refuses when both errored", () => {
    expect(compareSides(done(f.errored), done(f.errored))).toEqual({
      kind: "no_comparison",
      text: "No comparison: neither side was a fair test, proves nothing.",
    });
  });

  it("refuses when one side did not start, or a report cannot be read, or we gave up", () => {
    expect(compareSides({ phase: "did_not_start", reason: "x" }, running).kind).toBe(
      "no_comparison",
    );
    expect(compareSides(done(f.duplicateNaive), { phase: "unreadable", reason: "x" }).kind).toBe(
      "no_comparison",
    );
    expect(compareSides({ phase: "gave_up", input: null }, done(f.duplicateNaive))).toEqual({
      kind: "no_comparison",
      text: "Gave up watching. The run may still finish.",
    });
  });

  it("does not force the expected story when both pass", () => {
    expect(compareSides(done(f.duplicateIdempotent), done(f.duplicateIdempotent))).toEqual({
      kind: "not_separated",
      text: "Both passed. This run did not separate them.",
    });
  });

  it("says so when both fail the same way", () => {
    expect(compareSides(done(f.duplicateNaive), done(f.duplicateNaive))).toEqual({
      kind: "not_separated",
      text: "Both failed, and ended in the same final state.",
    });
  });

  it("shows a surprising result as it is: the naive side passing is still a difference", () => {
    const result = compareSides(done(f.duplicateIdempotent), done(f.duplicateNaive));
    expect(result.kind).toBe("diverged");
    if (result.kind === "diverged")
      expect(result.differences[0]).toMatchObject({ naive: "1", idempotent: "2" });
  });
});
