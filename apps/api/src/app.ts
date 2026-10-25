import type { Repository } from "@murphy/db";
import express, { type ErrorRequestHandler, type Express } from "express";
import { ApiError, type ErrorBody, notFound } from "./errors.js";
import { authenticate } from "./middleware/auth.js";
import { getRequestId, requestId } from "./middleware/request-id.js";
import { bulkReplayRouter, deliveriesRouter, dlqRouter } from "./routes/deliveries.js";
import { endpointsRouter } from "./routes/endpoints.js";
import { eventsRouter } from "./routes/events.js";

export interface AppDeps {
  repo: Repository;
  encryptionKey: Buffer;
  /** Called for unexpected (500) errors. Defaults to console.error. */
  logError?: (err: unknown, requestId: string) => void;
}

/** Builds the Express app without binding a port, so tests can drive it directly. */
export function createApp({ repo, encryptionKey, logError = defaultLogError }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  app.use(requestId);
  app.use(express.json({ limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const v1 = express.Router();
  v1.use(authenticate(repo));
  v1.use("/endpoints", endpointsRouter(repo, encryptionKey));
  v1.use("/events", eventsRouter(repo));
  v1.use("/deliveries", deliveriesRouter(repo));
  v1.use("/replay", bulkReplayRouter(repo));
  v1.use("/dlq", dlqRouter(repo));
  app.use("/v1", v1);

  app.use((_req, _res, next) => {
    next(notFound("route"));
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const id = getRequestId(res.locals);
    const apiError = toApiError(err);
    if (!apiError) logError(err, id);
    const { status, code, message, headers } =
      apiError ?? new ApiError(500, "internal_error", "internal server error");
    const body: ErrorBody = { error: { code, message, request_id: id } };
    res.status(status).set(headers).json(body);
  };
  app.use(errorHandler);

  return app;
}

/** Maps known errors (ours and body-parser's) to API errors; null means unexpected. */
function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (typeof err === "object" && err !== null && "type" in err) {
    switch ((err as { type: unknown }).type) {
      case "entity.parse.failed":
        return new ApiError(400, "invalid_json", "request body is not valid JSON");
      case "entity.too.large":
        return new ApiError(413, "payload_too_large", "request body exceeds 256kb");
      case "encoding.unsupported":
      case "charset.unsupported":
        return new ApiError(415, "unsupported_encoding", "unsupported request body encoding");
    }
  }
  return null;
}

function defaultLogError(err: unknown, requestId: string): void {
  console.error(JSON.stringify({ level: "error", request_id: requestId, err: String(err) }), err);
}
