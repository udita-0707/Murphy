import { nextRetryDelay } from "@murphy/core";
import type { DeliveryQueue, ReapedDelivery } from "@murphy/db";

/** Reaps of the same delivery that are free; from the 4th on, each counts as an attempt. */
export const FREE_REAPS = 3;

export interface ReaperOptions {
  queue: DeliveryQueue;
  intervalMs: number;
  /** Maximum rows reaped per pass. */
  limit?: number;
  onReap?: (reaped: ReapedDelivery[]) => void;
  onError?: (err: unknown) => void;
}

/** One reaper pass (ADR 007). */
export function reapOnce(queue: DeliveryQueue, limit = 100): Promise<ReapedDelivery[]> {
  return queue.reapExpired({
    limit,
    freeReaps: FREE_REAPS,
    retryDelay: (attemptCount) => nextRetryDelay(attemptCount),
  });
}

/** Runs the reaper on an interval until the returned stop function is called. */
export function startReaper(options: ReaperOptions): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = reapOnce(options.queue, options.limit)
      .then((reaped) => {
        if (reaped.length > 0) options.onReap?.(reaped);
      })
      .catch((err) => options.onError?.(err));
  };
  const timer = setInterval(() => {
    if (!stopped) tick();
  }, options.intervalMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
