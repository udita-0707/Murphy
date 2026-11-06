"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, ApiRequestError } from "@/lib/api";
import type { SideState } from "@/lib/compare";
import { compareUrl, type PairResponse } from "@/lib/scenarios";
import { useRunWatch, type Watched } from "@/lib/use-run-watch";
import { CompareBoard } from "./compare-board";
import { DownloadComparison } from "./download-button";
import { Empty } from "./states";

export interface CompareParams {
  naive: string | null;
  idempotent: string | null;
  naiveError: string | null;
  idempotentError: string | null;
}

const providerOf = (side: SideState) =>
  side.phase === "done" ? side.report.scenario.provider_label : null;

/** Only says "same seed" when both sides are known to have used it. */
function sharedSeed(a: Watched, b: Watched): number | null {
  if (a.run && b.run) return a.run.seed === b.run.seed ? a.run.seed : null;
  return null;
}

function RunAgain({ scenarioId }: { scenarioId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const pair = await apiRequest<PairResponse>("/api/compare", {
        method: "POST",
        body: JSON.stringify({ scenario_id: scenarioId }),
      });
      router.push(compareUrl(pair));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "The runs did not start.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        aria-busy={busy}
        onClick={run}
      >
        {busy ? "Starting both" : "Run on both handlers"}
      </button>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function CompareView({ naive, idempotent, naiveError, idempotentError }: CompareParams) {
  const idle = (reason: string | null): SideState =>
    reason ? { phase: "did_not_start", reason } : { phase: "loading" };
  const left = useRunWatch(naive, idle(naiveError));
  const right = useRunWatch(idempotent, idle(idempotentError));

  if (!naive && !idempotent && !naiveError && !idempotentError) {
    return (
      <Empty title="Nothing to compare yet.">
        <Link className="btn" href="/scenarios">
          Pick a scenario
        </Link>
      </Empty>
    );
  }

  const run = left.run ?? right.run;
  const finished = left.side.phase !== "running" && left.side.phase !== "loading";
  const bothFinished = finished && right.side.phase !== "running" && right.side.phase !== "loading";

  return (
    <CompareBoard
      title={run?.scenario.name ?? "Comparison"}
      provider={providerOf(left.side) ?? providerOf(right.side)}
      seed={sharedSeed(left, right)}
      naive={left.side}
      idempotent={right.side}
      live
      actions={
        bothFinished && run ? (
          <div className="preview-actions">
            <RunAgain scenarioId={run.scenario_id} />
            {left.side.phase === "done" && right.side.phase === "done" && (
              <DownloadComparison naive={left.side.report} idempotent={right.side.report} />
            )}
          </div>
        ) : null
      }
    />
  );
}
