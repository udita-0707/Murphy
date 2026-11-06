import { sideFromLive } from "./board";
import type { SideState } from "./compare";
import { isReadableReport, type LiveRun } from "./types";

export const POLL_MS = 1_000;
/** Longer than any library scenario, and the same limit as the CLI. */
export const WATCH_LIMIT_MS = 5 * 60_000;

export interface WatchDeps {
  getRun(id: string): Promise<LiveRun>;
  getReport(id: string): Promise<unknown>;
  /** Removes the run's throwaway endpoint. A failure must not change what is shown. */
  cleanup(id: string): Promise<unknown>;
  /** The status of a failed request, or null if there was no answer. */
  statusOf(err: unknown): number | null;
  onChange(state: SideState, run: LiveRun | null): void;
  now?: () => number;
  pollMs?: number;
  limitMs?: number;
}

/**
 * Follows one run until it has a report. One request at a time: the next poll is only scheduled once
 * the last one has answered. A failed poll says so and carries on, and never changes a verdict.
 */
export function watchRun(id: string, deps: WatchDeps): () => void {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = now() + (deps.limitMs ?? WATCH_LIMIT_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: LiveRun | null = null;

  const emit = (state: SideState) => {
    if (!stopped) deps.onChange(state, last);
  };
  const running = (run: LiveRun, lostContact: boolean): SideState => ({
    phase: "running",
    input: sideFromLive(run),
    lostContact,
    seed: run.seed,
    startedAt: run.started_at,
  });

  const finish = async () => {
    const report = await deps.getReport(id);
    if (isReadableReport(report)) {
      emit({ phase: "done", report });
      void deps.cleanup(id).catch(() => undefined);
    } else {
      emit({
        phase: "unreadable",
        reason: "This report has a version this dashboard cannot read.",
      });
    }
  };

  const tick = async () => {
    try {
      const run = await deps.getRun(id);
      if (stopped) return;
      last = run;
      if (run.report_ready) {
        await finish();
        return;
      }
      emit(running(run, false));
    } catch (err) {
      if (stopped) return;
      const status = deps.statusOf(err);
      if (status === 404) {
        emit({ phase: "unreadable", reason: "This run does not exist in your project." });
        return;
      }
      // A key that stopped working: the app shell is already returning to the sign-in page.
      if (status === 401) return;
      if (last) emit(running(last, true));
    }
    if (now() > deadline) {
      emit({ phase: "gave_up", input: last ? sideFromLive(last) : null });
      return;
    }
    timer = setTimeout(() => void tick(), pollMs);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
