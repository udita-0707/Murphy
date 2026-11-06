import type { SideInput } from "./board";
import type { RunReport, Verdict } from "./types";

export type HandlerName = "naive" | "idempotent";

/** One side of a comparison. */
export type SideState =
  | { phase: "loading" }
  | {
      phase: "running";
      input: SideInput;
      lostContact: boolean;
      seed: number;
      startedAt: string | null;
    }
  | { phase: "done"; report: RunReport }
  | { phase: "did_not_start"; reason: string }
  | { phase: "gave_up"; input: SideInput | null }
  | { phase: "unreadable"; reason: string };

const EFFECT_NAMES = {
  credit: "Credit effect",
  booking: "Booking effect",
  refund: "Refund effect",
  hold: "Hold effect",
} as const;
type EffectKey = keyof typeof EFFECT_NAMES;
const EFFECT_KEYS = Object.keys(EFFECT_NAMES) as EffectKey[];

export interface Difference {
  entity: string;
  name: string;
  naive: string;
  idempotent: string;
  expected: string;
  numeric: boolean;
}

const NOT_REPORTED = "not reported";

/** Every way the two handlers' final states differ. Only ever computed from the two reports. */
export function differences(naive: RunReport, idempotent: RunReport): Difference[] {
  const out: Difference[] = [];
  for (const left of naive.entities) {
    const right = idempotent.entities.find((e) => e.id === left.id);
    if (!right) continue;
    const add = (
      name: string,
      l: string | undefined,
      r: string | undefined,
      expected: string,
      numeric: boolean,
    ) => {
      if ((l ?? NOT_REPORTED) === (r ?? NOT_REPORTED)) return;
      out.push({
        entity: left.id,
        name,
        naive: l ?? NOT_REPORTED,
        idempotent: r ?? NOT_REPORTED,
        expected,
        numeric: numeric && l !== undefined && r !== undefined,
      });
    };
    for (const key of EFFECT_KEYS) {
      add(
        EFFECT_NAMES[key],
        left.actual ? String(left.actual.effects[key]) : undefined,
        right.actual ? String(right.actual.effects[key]) : undefined,
        String(left.expected.effects[key]),
        true,
      );
    }
    add(
      "Balance",
      left.actual ? String(left.actual.balance_minor) : undefined,
      right.actual ? String(right.actual.balance_minor) : undefined,
      String(left.expected.balance_minor),
      true,
    );
    add("Final state", left.actual?.state, right.actual?.state, left.expected.state, false);
  }
  return out;
}

export type Comparison =
  | { kind: "waiting"; text: string }
  | { kind: "no_comparison"; text: string }
  | { kind: "diverged"; differences: Difference[] }
  | { kind: "not_separated"; text: string };

const VOID_ONE = "No comparison: one side was not a fair test, proves nothing.";
const VOID_BOTH = "No comparison: neither side was a fair test, proves nothing.";

function isFinal(side: SideState): boolean {
  return side.phase !== "loading" && side.phase !== "running";
}

function notSeparated(a: Verdict, b: Verdict): string {
  if (a === "passed" && b === "passed") return "Both passed. This run did not separate them.";
  if (a === "failed" && b === "failed") return "Both failed, and ended in the same final state.";
  return "The verdicts differ, but the final states do not.";
}

/** What the figure below the spine says. An errored side always means no comparison. */
export function compareSides(naive: SideState, idempotent: SideState): Comparison {
  const sides = [naive, idempotent];
  const errored = sides.filter((s) => s.phase === "done" && s.report.run.status === "errored");
  if (errored.length === 2) return { kind: "no_comparison", text: VOID_BOTH };
  if (errored.length === 1) return { kind: "no_comparison", text: VOID_ONE };
  if (sides.some((s) => s.phase === "did_not_start")) {
    return { kind: "no_comparison", text: "No comparison: one side did not start." };
  }
  if (sides.some((s) => s.phase === "unreadable")) {
    return { kind: "no_comparison", text: "No comparison: one report could not be read." };
  }
  if (sides.some((s) => s.phase === "gave_up")) {
    return { kind: "no_comparison", text: "Gave up watching. The run may still finish." };
  }
  if (naive.phase !== "done" || idempotent.phase !== "done") {
    const oneDone = sides.some(isFinal);
    return { kind: "waiting", text: oneDone ? "Waiting for the other side." : "Both running." };
  }
  const found = differences(naive.report, idempotent.report);
  if (found.length > 0) return { kind: "diverged", differences: found };
  return {
    kind: "not_separated",
    text: notSeparated(naive.report.run.status, idempotent.report.run.status),
  };
}
