import { copyNumber, faultsFor, type LiveDelivery } from "@murphy/client";
import type { LiveRun, RunReport } from "./types";

/** What a run looks like to the board, whether it comes from a live poll or a final report. */
export interface SideInput {
  steps: {
    id: string;
    event_type: string;
    planned_offsets_ms: number[];
    fault_kinds: string[];
  }[];
  deliveries: LiveDelivery[];
}

export function sideFromLive(run: LiveRun): SideInput {
  return { steps: run.steps, deliveries: run.deliveries };
}

export function sideFromReport(report: RunReport): SideInput {
  return {
    steps: report.steps.map((step) => ({
      id: step.id,
      event_type: step.event_type,
      planned_offsets_ms: step.planned_offsets_ms,
      fault_kinds: step.fault_kinds,
    })),
    deliveries: report.steps.flatMap((step) =>
      step.deliveries.map((d) => ({
        delivery_id: d.delivery_id,
        step: step.id,
        attempts: d.attempts,
      })),
    ),
  };
}

export type Cell =
  | { kind: "sent"; at_ms: number; status: number | null; error: string | null }
  | { kind: "due"; at_ms: number }
  | { kind: "absent" };

export interface BoardRow {
  /** What the row is, the same on both sides: step, copy and attempt. Never its position. */
  key: string;
  step: string;
  eventType: string;
  copy: number;
  attemptNo: number;
  faults: string[];
  cells: [Cell, Cell];
}

interface SideRow {
  key: string;
  step: string;
  eventType: string;
  copy: number;
  attemptNo: number;
  faults: string[];
  cell: Exclude<Cell, { kind: "absent" }>;
}

function rowsOf(side: SideInput): SideRow[] {
  const rows = new Map<string, SideRow>();
  const add = (
    step: SideInput["steps"][number],
    copy: number,
    attemptNo: number,
    cell: SideRow["cell"],
  ) => {
    const key = `${step.id}#${copy}#${attemptNo}`;
    rows.set(key, {
      key,
      step: step.id,
      eventType: step.event_type,
      copy,
      attemptNo,
      faults: faultsFor(step.fault_kinds, copy, attemptNo),
      cell,
    });
  };
  for (const step of side.steps) {
    // One planned offset per copy, so a duplicate is on the board before it is sent.
    step.planned_offsets_ms.forEach((at_ms, i) => add(step, i + 1, 1, { kind: "due", at_ms }));
  }
  const steps = new Map(side.steps.map((s) => [s.id, s]));
  for (const delivery of side.deliveries) {
    const step = steps.get(delivery.step);
    if (!step) continue;
    const copy = copyNumber(side.deliveries, delivery.step, delivery.delivery_id);
    for (const attempt of delivery.attempts) {
      add(step, copy, attempt.attempt_no, {
        kind: "sent",
        at_ms: attempt.at_ms ?? 0,
        status: attempt.status,
        error: attempt.error,
      });
    }
  }
  return [...rows.values()];
}

/** Real attempts first, in the order they really started; then what is still due, as planned. */
function rank(cells: readonly Cell[]): [number, number] {
  const sent = cells.flatMap((c) => (c.kind === "sent" ? [c.at_ms] : []));
  if (sent.length > 0) return [0, Math.min(...sent)];
  const due = cells.flatMap((c) => (c.kind === "due" ? [c.at_ms] : []));
  return [1, due.length > 0 ? Math.min(...due) : Infinity];
}

function byRank(a: readonly Cell[], b: readonly Cell[]): number {
  const [ag, at] = rank(a);
  const [bg, bt] = rank(b);
  return ag - bg || at - bt;
}

export interface AlignedBoard {
  rows: BoardRow[];
  /** True if the attempts both sides have really made happened in a different order. */
  orderDiffers: boolean;
}

function sentOrder(rows: readonly SideRow[], shared: ReadonlySet<string>): string[] {
  return rows
    .filter((r) => r.cell.kind === "sent" && shared.has(r.key))
    .sort((x, y) => byRank([x.cell], [y.cell]))
    .map((r) => r.key);
}

/**
 * Lines two runs up by what happened, not by the clock (ADR 013). A row on one side only stays visible,
 * with an explicit blank opposite, so an extra retry can never shift the rows after it.
 */
export function alignSides(a: SideInput | null, b: SideInput | null): AlignedBoard {
  const left = a ? rowsOf(a) : [];
  const right = b ? rowsOf(b) : [];
  const leftByKey = new Map(left.map((r) => [r.key, r]));
  const rightByKey = new Map(right.map((r) => [r.key, r]));
  const keys = new Set([...leftByKey.keys(), ...rightByKey.keys()]);

  const rows: BoardRow[] = [...keys].map((key) => {
    const l = leftByKey.get(key);
    const r = rightByKey.get(key);
    const any = (l ?? r)!;
    return {
      key,
      step: any.step,
      eventType: any.eventType,
      copy: any.copy,
      attemptNo: any.attemptNo,
      faults: any.faults,
      cells: [l?.cell ?? { kind: "absent" }, r?.cell ?? { kind: "absent" }],
    };
  });
  rows.sort((x, y) => byRank(x.cells, y.cells));

  const shared = new Set(
    [...keys].filter(
      (k) => leftByKey.get(k)?.cell.kind === "sent" && rightByKey.get(k)?.cell.kind === "sent",
    ),
  );
  const orderDiffers = sentOrder(left, shared).join() !== sentOrder(right, shared).join();
  return { rows, orderDiffers };
}

/** One run's rows, in real attempt order. */
export function singleSide(side: SideInput): BoardRow[] {
  return alignSides(side, null).rows;
}

export function startGapMs(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime());
}

export function formatAt(ms: number): string {
  return `+${(ms / 1000).toFixed(2)}s`;
}

/** How a row describes itself, so a duplicate or a retry is not mistaken for a new event. */
export function rowDetail(row: Pick<BoardRow, "copy" | "attemptNo">): string | null {
  const parts: string[] = [];
  if (row.copy > 1) parts.push(`copy ${row.copy}, same webhook-id`);
  if (row.attemptNo > 1) parts.push(`retry, attempt ${row.attemptNo}`);
  return parts.length > 0 ? parts.join(", ") : null;
}
