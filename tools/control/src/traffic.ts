import type { MurphyApiClient } from "@murphy/client";
import { MurphyClientError } from "@murphy/client";
import { randomUUID } from "node:crypto";

export type EventOutcome = "delivered" | "retrying" | "dead" | "lost";

/**
 * What became of an accepted event, read from the API by its id. "Lost" means an accepted event with no delivery
 * that succeeded or is still going, and no dead letter to replay. That is the number the panel exists to show at zero.
 */
export function classify(statuses: readonly string[]): EventOutcome {
  if (statuses.includes("succeeded")) return "delivered";
  if (statuses.some((s) => s === "pending" || s === "in_flight" || s === "failed")) {
    return "retrying";
  }
  if (statuses.includes("dead")) return "dead";
  return "lost";
}

export interface TrafficCounts {
  accepted: number;
  delivered: number;
  retrying: number;
  dead: number;
  lost: number;
  /** A send the API did not accept, usually while Postgres restarts. Never counted as accepted. */
  refused: number;
}

export type TrafficState = "idle" | "running" | "draining";

export interface TrafficDeps {
  api: MurphyApiClient;
  sinkUrl: string;
  /** How long between events. */
  intervalMs?: number;
  /** A run stops by itself, so it can never be left going. */
  maxMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_MAX_MS = 5 * 60_000;

/**
 * Steady, real traffic through the real API: every event is accepted with a 202 and delivered by the real worker.
 * A refused send is retried with the same idempotency key, so one logical event can never count twice.
 */
export class Traffic {
  private state: TrafficState = "idle";
  private endpointId: string | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private stopAt = 0;
  private refused = 0;
  private pendingKey: string | null = null;
  private lastChecked: string | null = null;
  private checkFailing = false;
  /** Every accepted event, and the last thing known about it. */
  private readonly events = new Map<string, EventOutcome>();

  constructor(private readonly deps: TrafficDeps) {}

  counts(): TrafficCounts {
    const out = { accepted: this.events.size, delivered: 0, retrying: 0, dead: 0, lost: 0 };
    for (const outcome of this.events.values()) out[outcome] += 1;
    return { ...out, refused: this.refused };
  }

  status() {
    return {
      state: this.state,
      ...this.counts(),
      last_checked_at: this.lastChecked,
      /** True while the API cannot answer, so the counts may be behind. */
      check_failing: this.checkFailing,
    };
  }

  async start(): Promise<void> {
    if (this.state === "running") return;
    if (!this.endpointId) {
      const endpoint = await this.deps.api.request<{ id: string }>("POST", "/v1/endpoints", {
        url: this.deps.sinkUrl,
        description: "murphy chaos panel traffic",
        event_filter: ["chaos.tick"],
      });
      this.endpointId = endpoint.id;
    }
    this.state = "running";
    this.stopAt = Date.now() + (this.deps.maxMs ?? DEFAULT_MAX_MS);
    this.scheduleSend(0);
    this.scheduleCheck(0);
  }

  /** Stops sending. Checking carries on until every accepted event has an outcome. */
  stop(): void {
    if (this.state === "running") this.state = "draining";
    if (this.sendTimer) clearTimeout(this.sendTimer);
  }

  /** Stops everything, for shutting down. */
  dispose(): void {
    this.state = "idle";
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.checkTimer) clearTimeout(this.checkTimer);
  }

  private scheduleSend(delay: number) {
    this.sendTimer = setTimeout(() => void this.send(), delay);
  }

  private scheduleCheck(delay: number) {
    this.checkTimer = setTimeout(() => void this.check(), delay);
  }

  private async send() {
    if (this.state !== "running") return;
    if (Date.now() > this.stopAt) {
      this.stop();
      return;
    }
    const key = this.pendingKey ?? randomUUID();
    this.pendingKey = key;
    try {
      const accepted = await this.postEvent(key);
      this.pendingKey = null;
      if (!this.events.has(accepted)) this.events.set(accepted, "retrying");
    } catch (err) {
      if (!(err instanceof MurphyClientError)) throw err;
      this.refused += 1;
    }
    if (this.state === "running") this.scheduleSend(this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  private async postEvent(key: string): Promise<string> {
    const res = await this.deps.api.request<{ id: string }>(
      "POST",
      "/v1/events",
      { type: "chaos.tick", payload: { sent_at: new Date().toISOString() } },
      { "idempotency-key": key },
    );
    return res.id;
  }

  /** Re-reads every event not yet settled. A failure here changes no count: it only says the API is away. */
  private async check() {
    const open = [...this.events].filter(([, o]) => o === "retrying" || o === "lost");
    try {
      for (const [id] of open) {
        const event = await this.deps.api.request<{ deliveries: { status: string }[] }>(
          "GET",
          `/v1/events/${id}`,
        );
        this.events.set(id, classify(event.deliveries.map((d) => d.status)));
      }
      this.lastChecked = new Date().toISOString();
      this.checkFailing = false;
    } catch (err) {
      if (!(err instanceof MurphyClientError)) throw err;
      this.checkFailing = true;
    }
    const settled = [...this.events.values()].every((o) => o !== "retrying");
    if (this.state === "draining" && settled && !this.checkFailing) {
      this.state = "idle";
      return;
    }
    if (this.state !== "idle") this.scheduleCheck(1_000);
  }
}
