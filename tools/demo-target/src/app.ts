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
}

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
