"use client";

import Link from "next/link";
import { singleSide } from "@/lib/board";
import { useRunWatch } from "@/lib/use-run-watch";
import { ReportView } from "./report-view";
import { ErrorState, Loading } from "./states";
import { TimelineTable } from "./timeline-table";
import { PendingPlate } from "./verdict";

/** Live while running, then the final report. */
export function RunView({ id }: { id: string }) {
  const { side, run } = useRunWatch(id);
  switch (side.phase) {
    case "loading":
      return <Loading label="Loading the run" rows={4} />;
    case "done":
      return <ReportView report={side.report} />;
    case "did_not_start":
    case "unreadable":
      return (
        <ErrorState title="This run cannot be shown.">
          <p>{side.phase === "unreadable" ? side.reason : "It did not start."}</p>
          <Link className="btn" href="/scenarios">
            Back to scenarios
          </Link>
        </ErrorState>
      );
    case "gave_up":
    case "running":
      return (
        <div className="report" data-live="true">
          <header className="board__head">
            <div className="board__heading">
              <h1 className="board__title">{run?.scenario.name ?? "Run"}</h1>
              <p className="board__meta">
                {run?.target_label ?? "Your handler"}. Same seed, same payloads: {run?.seed}.
              </p>
            </div>
          </header>
          {side.phase === "running" ? (
            <PendingPlate variant="pending" title="Running">
              {side.lostContact ? "Lost contact, retrying. The run itself is unaffected." : null}
            </PendingPlate>
          ) : (
            <PendingPlate variant="none" title="Gave up watching">
              The run may still finish.
            </PendingPlate>
          )}
          {side.input && <TimelineTable rows={singleSide(side.input)} />}
        </div>
      );
  }
}
