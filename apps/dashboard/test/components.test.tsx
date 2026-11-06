import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompareBoard } from "@/components/compare-board";
import { ReportView } from "@/components/report-view";
import { StatusBadge, VerdictPlate } from "@/components/verdict";
import { sideFromLive } from "@/lib/board";
import type { SideState } from "@/lib/compare";
import { fixtures as f } from "@/lib/fixtures";
import type { RunReport } from "@/lib/types";

const done = (report: RunReport): SideState => ({ phase: "done", report });

describe("verdicts differ in wording and shape, not only colour", () => {
  it("FAIL has its word, a mark and the reason", () => {
    const { container } = render(
      <VerdictPlate status="failed" reason="Holds 2 bookings, expected 1" />,
    );
    expect(screen.getByText("FAIL")).toBeTruthy();
    expect(screen.getByText("Holds 2 bookings, expected 1")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector(".verdict--failed")).toBeTruthy();
  });

  it("PASS is limited to this run", () => {
    render(<VerdictPlate status="passed" reason={null} />);
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(screen.getByText("Survived these faults, in this run")).toBeTruthy();
  });

  it("errored says it proves nothing, says why, and has no cross or check", () => {
    const { container } = render(
      <VerdictPlate status="errored" reason="the state endpoint answered 404" />,
    );
    expect(screen.getByText("ERRORED")).toBeTruthy();
    expect(screen.getByText("Not a fair test, proves nothing")).toBeTruthy();
    expect(screen.getByText("the state endpoint answered 404")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByText("FAIL")).toBeNull();
  });

  it("badges keep the same three words", () => {
    render(
      <>
        <StatusBadge status="failed" />
        <StatusBadge status="passed" />
        <StatusBadge status="errored" />
        <StatusBadge status="running" />
      </>,
    );
    for (const word of ["FAIL", "PASS", "ERRORED", "Running"])
      expect(screen.getByText(word)).toBeTruthy();
  });
});

describe("ReportView on real reports", () => {
  it("failed: shows the assertion's reason, engine evidence, expected against reported, and limits", () => {
    render(<ReportView report={f.duplicateNaive} />);
    expect(screen.getByText("Booking effect is 2, expected 1")).toBeTruthy();
    expect(screen.getByText("Engine: duplicate", { selector: ".card .chip" })).toBeTruthy();
    expect(screen.getByText(/Evidence: 2 deliveries with the same webhook-id/)).toBeTruthy();
    expect(screen.getByText("Expected")).toBeTruthy();
    expect(screen.getByText("Reported")).toBeTruthy();
    expect(screen.getByText("What this does not prove")).toBeTruthy();
    for (const limit of f.duplicateNaive.limits) expect(screen.getByText(limit)).toBeTruthy();
  });

  it("passed: says PASS, and still shows the limits", () => {
    render(<ReportView report={f.duplicateIdempotent} />);
    expect(screen.getByText("Survived these faults, in this run")).toBeTruthy();
    expect(screen.getByText("What this does not prove")).toBeTruthy();
    expect(screen.queryByText("FAIL")).toBeNull();
  });

  it("errored: looks and reads differently from failed", () => {
    const { container } = render(<ReportView report={f.errored} />);
    expect(screen.getAllByText("ERRORED").length).toBeGreaterThan(0);
    expect(screen.getByText("Not a fair test, proves nothing")).toBeTruthy();
    expect(container.querySelector(".verdict--failed")).toBeNull();
    expect(screen.getAllByText("Not evaluated").length).toBeGreaterThan(0);
  });

  it("labels target faults as target, apart from engine ones", () => {
    render(<ReportView report={f.retryNaive} />);
    expect(screen.getAllByText("Target: drop, then redeliver").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Engine: delay").length).toBeGreaterThan(0);
  });
});

describe("CompareBoard", () => {
  const board = (naive: SideState, idempotent: SideState) =>
    render(<CompareBoard title="t" naive={naive} idempotent={idempotent} />);
  const figure = () => screen.getByTestId("figure");

  it("FAIL on one side, PASS on the other, and the real figure", () => {
    const { container } = board(done(f.duplicateNaive), done(f.duplicateIdempotent));
    const side = (name: string) => container.querySelector(`[data-side="${name}"]`) as HTMLElement;
    expect(within(side("naive")).getByText("FAIL")).toBeTruthy();
    expect(within(side("idempotent")).getByText("PASS")).toBeTruthy();
    expect(within(figure()).getByText("Booking effect")).toBeTruthy();
    expect(within(figure()).getByText("2 vs 1, expected 1")).toBeTruthy();
  });

  it("one side errored: the plate shows, and no number is compared", () => {
    board(done(f.errored), done(f.duplicateIdempotent));
    expect(figure().textContent).toBe(
      "No comparison: one side was not a fair test, proves nothing.",
    );
    expect(screen.queryByText("Booking effect")).toBeNull();
    expect(screen.getByText("PASS")).toBeTruthy();
  });

  it("one side finished early: its verdict stays, and there is no comparison yet", () => {
    const running: SideState = {
      phase: "running",
      input: sideFromLive(f.liveRunning),
      lostContact: false,
      seed: 1,
      startedAt: null,
    };
    board(running, done(f.duplicateIdempotent));
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(figure().textContent).toBe("Waiting for the other side.");
  });

  it("says lost contact without changing the verdict area", () => {
    const lost: SideState = {
      phase: "running",
      input: sideFromLive(f.liveRunning),
      lostContact: true,
      seed: 1,
      startedAt: null,
    };
    board(lost, lost);
    expect(
      screen.getAllByText("Lost contact, retrying. The run itself is unaffected.").length,
    ).toBe(2);
    expect(screen.queryByText("FAIL")).toBeNull();
    expect(screen.queryByText("PASS")).toBeNull();
  });

  it("a side that did not start says why", () => {
    board({ phase: "did_not_start", reason: "busy" }, done(f.duplicateIdempotent));
    expect(screen.getByText("Did not start")).toBeTruthy();
    expect(screen.getByText("busy")).toBeTruthy();
    expect(figure().textContent).toBe("No comparison: one side did not start.");
  });

  it("a row that goes from due to sent shows the attempt on both sides", () => {
    const running: SideState = {
      phase: "running",
      input: {
        steps: [{ id: "a", event_type: "first", planned_offsets_ms: [1000], fault_kinds: [] }],
        deliveries: [],
      },
      lostContact: false,
      seed: 1,
      startedAt: null,
    };
    const { container, rerender } = render(
      <CompareBoard title="t" naive={running} idempotent={running} />,
    );
    expect(container.querySelectorAll(".cell--due")).toHaveLength(2);
    const sent: SideState = {
      ...running,
      input: {
        ...running.input,
        deliveries: [
          {
            delivery_id: "d",
            step: "a",
            attempts: [{ attempt_no: 1, at_ms: 1010, status: 200, error: null }],
          },
        ],
      },
    };
    rerender(<CompareBoard title="t" naive={sent} idempotent={sent} />);
    expect(container.querySelectorAll(".cell--due")).toHaveLength(0);
    expect(container.querySelectorAll(".cell--sent")).toHaveLength(2);
  });

  it("marks motion on a live board only", () => {
    const { container } = render(
      <CompareBoard
        title="t"
        live
        naive={done(f.duplicateNaive)}
        idempotent={done(f.duplicateIdempotent)}
      />,
    );
    expect(container.querySelector(".board")?.getAttribute("data-live")).toBe("true");
    const { container: still } = render(
      <CompareBoard
        title="t"
        naive={done(f.duplicateNaive)}
        idempotent={done(f.duplicateIdempotent)}
      />,
    );
    expect(still.querySelector(".board")?.getAttribute("data-live")).toBe("false");
  });
});
