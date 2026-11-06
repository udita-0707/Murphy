import { sideFromReport, type SideInput } from "./board";
import type { SideState } from "./compare";
import type { RunReport } from "./types";

/** A finished report as it looked `atMs` into the run, so a real run can be replayed. */
export function sideAt(report: RunReport, atMs: number): SideState {
  const whole = sideFromReport(report);
  const latest = Math.max(...report.timeline.map((t) => t.at_ms));
  if (atMs > latest) return { phase: "done", report };
  const input: SideInput = {
    steps: whole.steps,
    deliveries: whole.deliveries.map((d) => ({
      ...d,
      attempts: d.attempts.filter((a) => (a.at_ms ?? 0) <= atMs),
    })),
  };
  return {
    phase: "running",
    input,
    lostContact: false,
    seed: report.run.seed,
    startedAt: report.run.started_at,
  };
}

export interface FaultInfo {
  kind: string;
  name: string;
  origin: "Engine" | "Target";
  /** What Murphy does, from the fault's real definition. */
  does: string;
  /** What goes wrong in a handler that was not ready. */
  breaks: string;
  /** The events as they really arrive. */
  arrives: { label: string; note?: string; hot?: boolean }[];
}

export const FAULTS: FaultInfo[] = [
  {
    kind: "duplicate",
    name: "Duplicate",
    origin: "Engine",
    does: "Sends the event again, with the same webhook-id.",
    breaks: "A guest holds two rooms.",
    arrives: [
      { label: "created" },
      { label: "confirmed" },
      { label: "confirmed", note: "again", hot: true },
    ],
  },
  {
    kind: "reorder",
    name: "Reorder",
    origin: "Engine",
    does: "Sends an event before one that logically comes first.",
    breaks: "A cancelled booking ends up confirmed.",
    arrives: [
      { label: "created" },
      { label: "cancelled", note: "too early", hot: true },
      { label: "confirmed" },
    ],
  },
  {
    kind: "delay",
    name: "Delay",
    origin: "Engine",
    does: "Sends the event later than planned.",
    breaks: "Whatever assumed it would be on time.",
    arrives: [
      { label: "authorized" },
      { label: "", note: "waiting", hot: true },
      { label: "failed" },
    ],
  },
  {
    kind: "drop_then_redeliver",
    name: "Lost reply",
    origin: "Target",
    does: "Your handler runs, its reply is lost, and Murphy retries.",
    breaks: "The money moves twice.",
    arrives: [
      { label: "failed", note: "503", hot: true },
      { label: "failed", note: "retry" },
    ],
  },
  {
    kind: "respond_with",
    name: "Forced reply",
    origin: "Target",
    does: "Your target answers a failing status first, without running the handler.",
    breaks: "A retry nobody planned for.",
    arrives: [
      { label: "refund", note: "500", hot: true },
      { label: "refund", note: "retry" },
    ],
  },
];

export const SCENARIOS = [
  { name: "Duplicate confirmation webhook causes a double booking", provider: "Booking" },
  { name: "Cancel event arrives before the confirmation", provider: "Booking" },
  {
    name: "Cancellation after payment, and the refund webhook is redelivered",
    provider: "Booking",
  },
  { name: "Two partial refunds, one of them redelivered", provider: "Booking" },
  { name: "Payment captured webhook arrives twice", provider: "Razorpay-style" },
  { name: "Captured arrives before authorized", provider: "Razorpay-style" },
  { name: "Delayed failure, then a retry after a lost reply", provider: "Razorpay-style" },
  { name: "UPI success arrives, then a stale expiry", provider: "UPI-style" },
];
