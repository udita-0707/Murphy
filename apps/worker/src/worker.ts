import type { ClaimedDelivery, DeliveryQueue } from "@murphy/db";

export type DeliveryHandler = (delivery: ClaimedDelivery, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  queue: DeliveryQueue;
  handler: DeliveryHandler;
  workerId: string;
  batchSize: number;
  projectCap: number;
  concurrency: number;
  pollMs: number;
  leaseMs: number;
  onError?: (err: unknown, context: string) => void;
}

/**
 * The claim loop: claim due deliveries under a lease, run them with bounded concurrency,
 * and sleep when idle. stop() stops claiming, waits for in-flight work up to a timeout, then
 * aborts what is left and releases its leases back to pending.
 */
export class Worker {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private wake: (() => void) | null = null;

  constructor(private readonly options: WorkerOptions) {}

  get activeCount(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Returns the number of leases released because their work did not finish in time. */
  async stop(timeoutMs: number): Promise<number> {
    if (!this.running) return 0;
    this.running = false;
    this.wake?.();
    await this.loop;

    const pending = [...this.inFlight.values()];
    const finished = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      sleep(timeoutMs).then(() => false),
    ]);
    if (finished) return 0;

    const leftover = [...this.inFlight.keys()];
    this.abort.abort();
    // The guarded final write (status in_flight AND locked_by = me) cannot succeed once the
    // lease is released, so release first and let aborted handlers fail harmlessly.
    const released = await this.options.queue.releaseLeases(this.options.workerId, leftover);
    await Promise.allSettled([...this.inFlight.values()]);
    return released;
  }

  private async run(): Promise<void> {
    const { queue, workerId, batchSize, projectCap, concurrency, pollMs, leaseMs } = this.options;
    while (this.running) {
      const free = concurrency - this.inFlight.size;
      let claimed: ClaimedDelivery[] = [];
      if (free > 0) {
        try {
          claimed = await queue.claim({
            workerId,
            batchSize: Math.min(batchSize, free),
            projectCap,
            leaseMs,
          });
        } catch (err) {
          this.report(err, "claim");
        }
      }
      for (const delivery of claimed) this.dispatch(delivery);

      if (!this.running) break;
      if (claimed.length > 0 && claimed.length === Math.min(batchSize, free)) continue;
      // Idle, or at capacity: wait for a slot to free up or the poll interval, whichever first.
      await this.idle(free <= 0 ? undefined : pollMs);
    }
  }

  private dispatch(delivery: ClaimedDelivery): void {
    const task = this.options
      .handler(delivery, this.abort.signal)
      .catch((err) => this.report(err, `delivery ${delivery.id}`))
      .finally(() => {
        this.inFlight.delete(delivery.id);
        this.wake?.();
      });
    this.inFlight.set(delivery.id, task);
  }

  private idle(ms: number | undefined): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      if (ms !== undefined) timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private report(err: unknown, context: string): void {
    (this.options.onError ?? defaultOnError)(err, context);
  }
}

function defaultOnError(err: unknown, context: string): void {
  console.error(JSON.stringify({ level: "error", context, err: String(err) }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
