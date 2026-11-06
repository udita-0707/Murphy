import type { JsonObject, Repository, RunQueue } from "@murphy/db";
import { evaluateRun, targetStateSchema, type RunPlan, type StateResult } from "@murphy/simulator";
import { fetchTargetState } from "./net/fetch-state.js";
import type { MurphyMode, Resolver } from "./net/ssrf.js";

const STATE_TIMEOUT_MS = 5_000;

export interface RunFinisherOptions {
  repo: Repository;
  runs: RunQueue;
  mode: MurphyMode;
  resolver?: Resolver;
  /** Maximum runs finished per pass. */
  limit?: number;
  onFinish?: (info: { runId: string; status: string }) => void;
  onError?: (err: unknown, context: string) => void;
}

async function readState(
  stateUrl: string | null,
  runId: string,
  options: RunFinisherOptions,
): Promise<StateResult> {
  if (!stateUrl) return { ok: false, error: "the run has no state URL" };
  const fetched = await fetchTargetState({
    stateUrl,
    runId,
    mode: options.mode,
    timeoutMs: STATE_TIMEOUT_MS,
    resolver: options.resolver,
  });
  if (!fetched.ok) return fetched;
  const parsed = targetStateSchema.safeParse(fetched.body);
  if (!parsed.success) {
    return {
      ok: false,
      error: `the state response does not match the contract: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  return { ok: true, state: parsed.data };
}

/**
 * One pass: evaluates runs that have nothing left to send or that passed their deadline, and stores
 * each report. The store is guarded, so several workers can do this at once: the first write wins, and
 * a crash just leaves the run for the next pass.
 */
export async function finishRunsOnce(options: RunFinisherOptions): Promise<number> {
  const { repo, runs } = options;
  let finished = 0;
  for (const due of await runs.listFinishable(options.limit)) {
    try {
      const run = await repo.runs.get(due.projectId, due.id);
      if (!run || run.status !== "running" || !run.startedAt) continue;
      const report = evaluateRun({
        plan: run.plan as unknown as RunPlan,
        endpointId: run.endpointId,
        targetLabel: run.targetLabel,
        startedAt: run.startedAt,
        finishedAt: new Date(),
        deadlinePassed: due.deadlinePassed,
        deliveries: await repo.runs.deliveries(due.projectId, due.id),
        state: await readState(run.stateUrl, run.id, options),
      });
      const stored = await runs.finish(
        due.projectId,
        due.id,
        report.run.status,
        report as unknown as JsonObject,
      );
      if (stored) {
        finished += 1;
        options.onFinish?.({ runId: due.id, status: report.run.status });
      }
    } catch (err) {
      options.onError?.(err, `run ${due.id}`);
    }
  }
  return finished;
}

/** Runs the finisher on an interval until the returned stop function is called. */
export function startRunFinisher(
  options: RunFinisherOptions & { intervalMs: number },
): () => Promise<void> {
  let stopped = false;
  let busy = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped || busy) return;
    busy = true;
    running = finishRunsOnce(options)
      .catch((err) => options.onError?.(err, "run finisher"))
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(tick, options.intervalMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
