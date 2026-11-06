import { murphyTarget, type MurphyTargetOptions } from "@murphy/sdk";
import express, { type Express } from "express";
import { IdempotentHandler, NaiveHandler, type DemoHandler } from "./handlers.js";

export { IdempotentHandler, NaiveHandler, type DemoHandler } from "./handlers.js";

export const DEMO_HANDLERS = ["naive", "idempotent"] as const;
export type DemoHandlerName = (typeof DEMO_HANDLERS)[number];

export interface Arrival {
  handler: string;
  webhookId: string;
  runId: string | null;
  step: string | null;
  arrival: number;
  forcedStatus: number | null;
  atMs: number;
}

export interface DemoTarget {
  app: Express;
  /** Everything that arrived, recorded by the target itself. */
  arrivals: Arrival[];
  handlers: Record<string, DemoHandler>;
  addSecret(secret: string): void;
}

export interface DemoTargetOptions {
  /** Secrets valid from the start. Others are added with POST /_secrets. */
  secrets?: string[];
  /** Extra handlers, by name, for tests. */
  handlers?: Record<string, DemoHandler>;
  /** Overrides for one handler's target, by name, for tests. */
  targetOptions?: Record<string, Partial<MurphyTargetOptions>>;
  /**
   * The chaos panel's routes (ADR 015). Off unless asked, and `main.ts` only asks in local mode, so in
   * any other mode these routes do not exist.
   */
  chaos?: boolean;
}

/** The longest the panel can make the target fail, so it can never be left broken. */
export const MAX_FAIL_SECONDS = 60;

/**
 * A demo app with a naive and an idempotent webhook handler:
 *
 *   POST /naive, GET /naive/state        POST /idempotent, GET /idempotent/state
 *
 * Secrets come from the endpoints Murphy creates, so they are added at runtime with POST /_secrets.
 * That route has no authentication, so this app must only listen on localhost.
 */
export function createDemoTarget(options: DemoTargetOptions = {}): DemoTarget {
  const secrets = new Set(options.secrets ?? []);
  const arrivals: Arrival[] = [];
  const handlers: Record<string, DemoHandler> = {
    naive: new NaiveHandler(),
    idempotent: new IdempotentHandler(),
    ...options.handlers,
  };

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => void res.json({ ok: true }));

  if (options.chaos) {
    let failUntil = 0;
    const received = new Set<string>();
    app.post("/_chaos/fail", express.json(), (req, res) => {
      const seconds = (req.body as { seconds?: unknown }).seconds;
      if (
        typeof seconds !== "number" ||
        !Number.isInteger(seconds) ||
        seconds < 1 ||
        seconds > MAX_FAIL_SECONDS
      ) {
        res
          .status(400)
          .json({ error: `seconds must be a whole number from 1 to ${MAX_FAIL_SECONDS}` });
        return;
      }
      failUntil = Date.now() + seconds * 1000;
      res.json({ fail_until: new Date(failUntil).toISOString() });
    });
    app.get("/_chaos/status", (_req, res) => {
      res.json({
        failing: Date.now() < failUntil,
        fail_until: failUntil > Date.now() ? new Date(failUntil).toISOString() : null,
        received: received.size,
      });
    });
    // A failing target answers 500 to every delivery, on every handler. Reading state still works.
    app.use((req, res, next) => {
      if (req.method === "POST" && Date.now() < failUntil) {
        res.status(500).json({ error: "the chaos panel asked this target to fail" });
        return;
      }
      next();
    });
    // Where the panel's steady traffic lands. It records what really arrived, as a second opinion.
    app.post("/_chaos/sink", (req, res) => {
      const id = req.get("webhook-id");
      if (id) received.add(id);
      res.status(204).end();
    });
  }
  app.post("/_secrets", express.json(), (req, res) => {
    const secret = (req.body as { secret?: unknown }).secret;
    if (typeof secret !== "string" || !secret.startsWith("whsec_")) {
      res.status(400).json({ error: "secret must be a whsec_ string" });
      return;
    }
    secrets.add(secret);
    res.status(204).end();
  });

  for (const [name, handler] of Object.entries(handlers)) {
    app.use(
      `/${name}`,
      murphyTarget({
        secret: () => [...secrets],
        onEvent: (event) => handler.apply(event),
        state: (runId) => handler.state(runId),
        onArrival: ({ event, arrival, forcedStatus }) => {
          arrivals.push({
            handler: name,
            webhookId: event.webhookId,
            runId: event.murphy?.run_id ?? null,
            step: event.murphy?.step ?? null,
            arrival,
            forcedStatus,
            atMs: Date.now(),
          });
        },
        ...options.targetOptions?.[name],
      }),
    );
  }

  return { app, arrivals, handlers, addSecret: (secret) => void secrets.add(secret) };
}
