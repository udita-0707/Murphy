import { readMurphyBlock, verify, WEBHOOK_HEADERS, type MurphyBlock } from "@murphy/core";
import express, { type Router } from "express";

/** Header carrying the event type (ADR 006). Not covered by the signature. */
const EVENT_TYPE_HEADER = "webhook-event-type";
const MAX_BODY = "1mb";
/** How many webhook-ids are remembered for counting arrivals. Oldest go first. */
const MAX_TRACKED_IDS = 10_000;

export interface TargetEvent {
  /** Stable across retries and duplicates. This is what a handler should deduplicate on. */
  webhookId: string;
  type: string;
  /** The verified body, including `_murphy` on simulated events. */
  payload: Record<string, unknown>;
  /** The signed block on a simulated event, null on an ordinary one. */
  murphy: MurphyBlock | null;
}

export interface EntityState {
  state: string;
  effects: { credit?: number; booking?: number; refund?: number; hold?: number };
  balance_minor: number;
}

/** What Murphy reads at the end of a run to check your handler's result. */
export interface TargetState {
  entities: Record<string, EntityState>;
}

export interface MurphyTargetOptions {
  /** The endpoint's signing secret, or a function returning all that are currently valid. */
  secret: string | (() => readonly string[]);
  /** Your handler. Throw to answer 500, or return nothing to answer 200. */
  onEvent: (event: TargetEvent) => void | Promise<void>;
  /** Your handler's result for one run, keyed by the entity's id (`_murphy.entity_id`). */
  state: (runId: string) => TargetState | Promise<TargetState>;
  /** Set false to ignore forced responses, as a target without this helper would. */
  obeyFaults?: boolean;
  /** Called for every verified arrival, before anything else. For logs and tests. */
  onArrival?: (arrival: {
    event: TargetEvent;
    arrival: number;
    forcedStatus: number | null;
  }) => void;
  /** Current time in unix seconds, for tests. */
  now?: () => number;
}

/**
 * The target side of a Murphy scenario, as Express middleware. Mount it before `express.json()`,
 * because signatures cover the raw body:
 *
 *   app.use("/webhooks/murphy", murphyTarget({ secret, onEvent, state }));
 *
 * - `POST /` verifies the signature, obeys any forced responses in the signed `_murphy` block, and
 *   calls your handler.
 * - `GET /state?run_id=...` returns your handler's result for the run.
 *
 * The state route has no authentication and is meant for test targets, so do not expose real data
 * through it.
 */
export function murphyTarget(options: MurphyTargetOptions): Router {
  const obeyFaults = options.obeyFaults ?? true;
  const secrets =
    typeof options.secret === "string"
      ? () => [options.secret as string]
      : (options.secret as () => readonly string[]);
  const arrivals = new Map<string, number>();
  const router = express.Router();

  const countArrival = (webhookId: string): number => {
    const count = (arrivals.get(webhookId) ?? 0) + 1;
    arrivals.set(webhookId, count);
    if (arrivals.size > MAX_TRACKED_IDS) {
      const oldest = arrivals.keys().next().value;
      if (oldest !== undefined) arrivals.delete(oldest);
    }
    return count;
  };

  router.post("/", express.raw({ type: () => true, limit: MAX_BODY }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(500).json({
        error: "the body was already parsed: mount murphyTarget() before express.json()",
      });
      return;
    }
    const header = (name: string) => req.get(name);
    const webhookId = header(WEBHOOK_HEADERS.id);
    const timestamp = header(WEBHOOK_HEADERS.timestamp);
    const signature = header(WEBHOOK_HEADERS.signature);
    const body = req.body;
    const valid = secrets().some(
      (secret) =>
        verify({ id: webhookId, timestamp, signature, body, secret, now: options.now?.() }).valid,
    );
    if (!valid || webhookId === undefined) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: "body is not JSON" });
      return;
    }
    const murphy = readMurphyBlock(payload);
    const event: TargetEvent = {
      webhookId,
      type: header(EVENT_TYPE_HEADER) ?? murphy?.event ?? "",
      payload,
      murphy,
    };

    const arrival = countArrival(webhookId);
    const forced = obeyFaults ? murphy?.forced_responses?.[arrival - 1] : undefined;
    options.onArrival?.({ event, arrival, forcedStatus: forced?.status ?? null });

    try {
      if (!forced || forced.run_handler) await options.onEvent(event);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "handler failed" });
      return;
    }
    if (forced) {
      res.status(forced.status).json({ forced_by: "murphy", status: forced.status });
      return;
    }
    res.status(200).json({ ok: true });
  });

  router.get("/state", async (req, res) => {
    const runId = req.query.run_id;
    if (typeof runId !== "string" || runId === "") {
      res.status(400).json({ error: "run_id is required" });
      return;
    }
    res.json(await options.state(runId));
  });

  return router;
}
