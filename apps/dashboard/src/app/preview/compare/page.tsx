import { notFound } from "next/navigation";
import { CompareBoard } from "@/components/compare-board";
import { sideFromLive } from "@/lib/board";
import type { SideState } from "@/lib/compare";
import { fixtures as f } from "@/lib/fixtures";

const done = (report: typeof f.errored): SideState => ({ phase: "done", report });
const running: SideState = {
  phase: "running",
  input: sideFromLive(f.liveRunning),
  lostContact: false,
  seed: f.liveRunning.seed,
  startedAt: f.liveRunning.started_at,
};

const from = (naive: typeof f.errored, idempotent: typeof f.errored) => ({
  title: naive.scenario.name,
  provider: naive.scenario.provider_label,
  seed: naive.run.seed,
  naive: done(naive),
  idempotent: done(idempotent),
});

const live = {
  title: f.duplicateNaive.scenario.name,
  provider: f.duplicateNaive.scenario.provider_label,
  seed: f.duplicateNaive.run.seed,
};

const CASES: Record<
  string,
  { title: string; provider: string; seed: number; naive: SideState; idempotent: SideState }
> = {
  duplicate: from(f.duplicateNaive, f.duplicateIdempotent),
  reorder: from(f.reorderNaive, f.reorderIdempotent),
  retry: from(f.retryNaive, f.retryIdempotent),
  errored: from(f.errored, f.duplicateIdempotent),
  running: { ...live, naive: running, idempotent: running },
  early: { ...live, naive: running, idempotent: done(f.duplicateIdempotent) },
};

/** Fixtures for design checks. Not part of the product, and absent from a production build. */
export default async function Preview({
  searchParams,
}: {
  searchParams: Promise<{ case?: string; theme?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const c = CASES[params.case ?? "duplicate"];
  if (!c) notFound();
  return (
    <main className="container page">
      <CompareBoard
        title={c.title}
        provider={c.provider}
        seed={c.seed}
        naive={c.naive}
        idempotent={c.idempotent}
        actions={
          <div className="preview-actions">
            <button type="button" className="btn btn--primary">
              Run on both handlers
            </button>
            <button type="button" className="btn">
              Download comparison
            </button>
          </div>
        }
      />
    </main>
  );
}
