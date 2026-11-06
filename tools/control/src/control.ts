import { MurphyApiClient } from "@murphy/client";
import express, { type Express, type RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { Traffic } from "./traffic.js";

export const MAX_FAIL_SECONDS = 60;

export interface WorkerView {
  name: string;
  /** From the process itself. `crashed` means it exited without being asked to. */
  state: "running" | "restarting" | "crashed";
  pid: number | null;
}

/** Everything that touches a process. Each is one fixed action: nothing from a request reaches a command. */
export interface ControlActions {
  killWorker(): Promise<{ killed: string } | null>;
  workers(): WorkerView[];
  restartPostgres(): Promise<void>;
  /** Tells the target to fail, or reports why it could not. */
  failTarget(seconds: number): Promise<void>;
  targetStatus(): Promise<{ failing: boolean; fail_until: string | null; received: number } | null>;
}

export interface ControlOptions {
  token: string;
  port: number;
  apiUrl: string;
  sinkUrl: string;
  actions: ControlActions;
  /** For tests. */
  trafficIntervalMs?: number;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * The service binds to 127.0.0.1, but a browser on this machine can still reach it, so that is not enough:
 *
 * - A wrong Host means DNS rebinding: an attacker's name that resolves here.
 * - Any Origin means a browser sent this. Only the dashboard's server may call, and it sends none.
 * - The token is random per start, and only the dashboard's server has it.
 */
export function guardRequests(token: string, port: number): RequestHandler {
  const expected = digest(token);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (req, res, next) => {
    if (!hosts.has(req.get("host") ?? "")) {
      res.status(403).json({ error: "wrong host" });
      return;
    }
    if (req.get("origin") !== undefined) {
      res.status(403).json({ error: "browsers may not call this service" });
      return;
    }
    const presented = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(presented), expected)) {
      res.status(401).json({ error: "bad token" });
      return;
    }
    next();
  };
}

export interface ActionLogEntry {
  at: string;
  action: string;
  outcome: "started" | "done" | "failed";
  detail: string | null;
}

/** The app, without a port, so tests can drive it. */
export function createControlApp(options: ControlOptions): Express & { dispose(): void } {
  const app = express();
  app.disable("x-powered-by");
  app.use(guardRequests(options.token, options.port));
  app.use(express.json({ limit: "8kb" }));

  const log: ActionLogEntry[] = [];
  const note = (
    action: string,
    outcome: ActionLogEntry["outcome"],
    detail: string | null = null,
  ) => {
    log.unshift({ at: new Date().toISOString(), action, outcome, detail });
    log.length = Math.min(log.length, 30);
  };
  let traffic: Traffic | null = null;
  let postgresBusy = false;

  app.get("/status", async (_req, res) => {
    res.json({
      workers: options.actions.workers(),
      target: await options.actions.targetStatus().catch(() => null),
      traffic: traffic?.status() ?? null,
      postgres_restarting: postgresBusy,
      log,
    });
  });

  app.post("/actions/kill-worker", async (_req, res) => {
    const killed = await options.actions.killWorker();
    if (!killed) {
      res.status(409).json({ error: "no worker is running" });
      return;
    }
    note("Kill a worker", "done", `${killed.killed} killed with SIGKILL, restarting`);
    res.json(killed);
  });

  app.post("/actions/restart-postgres", (_req, res) => {
    if (postgresBusy) {
      res.status(409).json({ error: "Postgres is already restarting" });
      return;
    }
    postgresBusy = true;
    note("Restart Postgres", "started");
    res.status(202).json({ started: true });
    options.actions.restartPostgres().then(
      () => {
        postgresBusy = false;
        note("Restart Postgres", "done");
      },
      (err: unknown) => {
        postgresBusy = false;
        note("Restart Postgres", "failed", err instanceof Error ? err.message : String(err));
      },
    );
  });

  app.post("/actions/target-fail", async (req, res) => {
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
    try {
      await options.actions.failTarget(seconds);
      note("Target answers 500", "done", `for ${seconds} s`);
      res.json({ seconds });
    } catch (err) {
      note("Target answers 500", "failed", err instanceof Error ? err.message : String(err));
      res.status(502).json({ error: "the demo target did not answer" });
    }
  });

  /** Traffic runs as the caller's project, with the credential the dashboard's server forwarded. */
  app.post("/traffic/start", async (req, res) => {
    const token = (req.body as { token?: unknown }).token;
    if (typeof token !== "string" || !token) {
      res.status(400).json({ error: "token is required" });
      return;
    }
    if (traffic?.status().state === "running") {
      res.status(409).json({ error: "traffic is already running" });
      return;
    }
    traffic?.dispose();
    traffic = new Traffic({
      api: new MurphyApiClient({ apiUrl: options.apiUrl, token }),
      sinkUrl: options.sinkUrl,
      intervalMs: options.trafficIntervalMs,
    });
    try {
      await traffic.start();
      note("Traffic", "started");
      res.status(202).json({ started: true });
    } catch (err) {
      traffic = null;
      note("Traffic", "failed", err instanceof Error ? err.message : String(err));
      res.status(502).json({ error: "traffic could not start" });
    }
  });

  app.post("/traffic/stop", (_req, res) => {
    traffic?.stop();
    note("Traffic", "done", "stopped sending");
    res.json({ stopped: true });
  });

  return Object.assign(app, { dispose: () => traffic?.dispose() });
}
