import { describe, expect, it } from "vitest";
import {
  alignSides,
  formatAt,
  rowDetail,
  sideFromLive,
  sideFromReport,
  singleSide,
  startGapMs,
  type SideInput,
} from "@/lib/board";
import { fixtures as f } from "@/lib/fixtures";

const side = (deliveries: SideInput["deliveries"]): SideInput => ({
  steps: [
    { id: "a", event_type: "first", planned_offsets_ms: [1000], fault_kinds: [] },
    { id: "b", event_type: "second", planned_offsets_ms: [2000, 3500], fault_kinds: ["duplicate"] },
  ],
  deliveries,
});
const attempt = (attempt_no: number, at_ms: number, status: number | null = 200) => ({
  attempt_no,
  at_ms,
  status,
  error: null,
});

describe("alignSides", () => {
  it("shows planned rows as due before anything is sent, including a planned duplicate", () => {
    const { rows } = alignSides(side([]), side([]));
    expect(rows.map((r) => r.key)).toEqual(["a#1#1", "b#1#1", "b#2#1"]);
    expect(rows[0]?.cells).toEqual([
      { kind: "due", at_ms: 1000 },
      { kind: "due", at_ms: 1000 },
    ]);
  });

  it("matches rows on what they are, even when the two clocks differ", () => {
    const { rows, orderDiffers } = alignSides(
      side([{ delivery_id: "1", step: "a", attempts: [attempt(1, 1000)] }]),
      side([{ delivery_id: "9", step: "a", attempts: [attempt(1, 1450)] }]),
    );
    expect(rows[0]?.cells).toEqual([
      { kind: "sent", at_ms: 1000, status: 200, error: null },
      { kind: "sent", at_ms: 1450, status: 200, error: null },
    ]);
    expect(orderDiffers).toBe(false);
  });

  it("keeps an extra retry visible, with a blank opposite, and does not shift later rows", () => {
    const left = side([
      { delivery_id: "1", step: "a", attempts: [attempt(1, 1000, 503), attempt(2, 1500)] },
      { delivery_id: "2", step: "b", attempts: [attempt(1, 2000)] },
    ]);
    const right = side([
      { delivery_id: "3", step: "a", attempts: [attempt(1, 1000)] },
      { delivery_id: "4", step: "b", attempts: [attempt(1, 2000)] },
    ]);
    const { rows } = alignSides(left, right);
    const retry = rows.find((r) => r.key === "a#1#2");
    expect(retry?.cells[0]).toMatchObject({ kind: "sent", status: 200 });
    expect(retry?.cells[1]).toEqual({ kind: "absent" });
    const later = rows.find((r) => r.key === "b#1#1");
    expect(later?.cells[0]).toMatchObject({ kind: "sent" });
    expect(later?.cells[1]).toMatchObject({ kind: "sent" });
  });

  it("orders real attempts before what is still due", () => {
    const { rows } = alignSides(
      side([{ delivery_id: "1", step: "b", attempts: [attempt(1, 2000)] }]),
      side([]),
    );
    expect(rows[0]?.key).toBe("b#1#1");
    expect(rows[1]?.key).toBe("a#1#1");
  });

  it("orders by when attempts really started, so a reorder shows", () => {
    const { rows } = alignSides(
      side([
        { delivery_id: "1", step: "b", attempts: [attempt(1, 900)] },
        { delivery_id: "2", step: "a", attempts: [attempt(1, 2100)] },
      ]),
      null,
    );
    expect(rows.slice(0, 2).map((r) => r.step)).toEqual(["b", "a"]);
  });

  it("says when the two sides saw attempts in a different order", () => {
    const { orderDiffers } = alignSides(
      side([
        { delivery_id: "1", step: "a", attempts: [attempt(1, 1000)] },
        { delivery_id: "2", step: "b", attempts: [attempt(1, 1100)] },
      ]),
      side([
        { delivery_id: "3", step: "b", attempts: [attempt(1, 900)] },
        { delivery_id: "4", step: "a", attempts: [attempt(1, 1000)] },
      ]),
    );
    expect(orderDiffers).toBe(true);
  });

  it("tags a duplicate only on the later copy", () => {
    const { rows } = alignSides(side([]), null);
    expect(rows.find((r) => r.key === "b#1#1")?.faults).toEqual([]);
    expect(rows.find((r) => r.key === "b#2#1")?.faults).toEqual(["duplicate"]);
  });

  it("copes with no data on either side", () => {
    expect(alignSides(null, null)).toEqual({ rows: [], orderDiffers: false });
  });
});

describe("on real reports", () => {
  it("aligns the duplicate scenario into three rows with nothing missing", () => {
    const { rows } = alignSides(
      sideFromReport(f.duplicateNaive),
      sideFromReport(f.duplicateIdempotent),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.cells.map((c) => c.kind)).toEqual(["sent", "sent"]);
    expect(rows[2]?.faults).toEqual(["duplicate"]);
  });

  it("gives each row of a report the same real order as its timeline", () => {
    for (const report of [f.duplicateNaive, f.reorderNaive, f.retryNaive]) {
      const rows = singleSide(sideFromReport(report));
      const sent = rows.filter((r) => r.cells[0].kind === "sent");
      const at = sent.map((r) => (r.cells[0].kind === "sent" ? r.cells[0].at_ms : -1));
      expect(at).toEqual(report.timeline.map((t) => t.at_ms));
    }
  });

  it("reads a live snapshot, with planned rows still due", () => {
    const rows = singleSide(sideFromLive(f.liveRunning));
    expect(rows.some((r) => r.cells[0].kind === "sent")).toBe(true);
    expect(rows.some((r) => r.cells[0].kind === "due")).toBe(true);
  });
});

describe("helpers", () => {
  it("formats times", () => expect(formatAt(1310)).toBe("+1.31s"));
  it("describes copies and retries, and says nothing for a plain row", () => {
    expect(rowDetail({ copy: 1, attemptNo: 1 })).toBeNull();
    expect(rowDetail({ copy: 2, attemptNo: 1 })).toBe("copy 2, same webhook-id");
    expect(rowDetail({ copy: 1, attemptNo: 3 })).toBe("retry, attempt 3");
  });
  it("measures the gap between starts, and admits when it does not know", () => {
    expect(startGapMs("2026-11-07T00:00:00.000Z", "2026-11-07T00:00:00.012Z")).toBe(12);
    expect(startGapMs(null, "2026-11-07T00:00:00.012Z")).toBeNull();
  });
});
