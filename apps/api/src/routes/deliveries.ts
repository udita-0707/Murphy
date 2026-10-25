import { BULK_REPLAY_CAP, type Repository } from "@murphy/db";
import { Router } from "express";
import { ApiError, notFound } from "../errors.js";
import { projectIdOf } from "../middleware/auth.js";
import { serializeDelivery, serializeDeliveryWithAttempts } from "../serializers.js";
import {
  bulkReplayBody,
  dlqRetryBody,
  encodeCursor,
  listDeliveriesQuery,
  listDlqQuery,
  parse,
  uuidParam,
} from "../validation.js";

/** GET /v1/deliveries, GET /v1/deliveries/:id, POST /v1/deliveries/:id/replay */
export function deliveriesRouter(repo: Repository): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const query = parse(listDeliveriesQuery, req.query);
    const page = await repo.deliveries.list(projectIdOf(res), {
      status: query.status,
      endpointId: query.endpoint_id,
      eventId: query.event_id,
      limit: query.limit,
      cursor: query.cursor,
    });
    res.json({
      data: page.data.map(serializeDelivery),
      next_cursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  });

  router.get("/:id", async (req, res) => {
    const id = parseId(req.params);
    const delivery = await repo.deliveries.get(projectIdOf(res), id);
    if (!delivery) throw notFound("delivery");
    res.json(serializeDeliveryWithAttempts(delivery));
  });

  router.post("/:id/replay", async (req, res) => {
    const id = parseId(req.params);
    const result = await repo.deliveries.replay(projectIdOf(res), id);
    switch (result.outcome) {
      case "replayed":
        res.status(202).json(serializeDelivery(result.delivery));
        return;
      case "not_found":
        throw notFound("delivery");
      case "endpoint_deleted":
        throw new ApiError(
          409,
          "endpoint_deleted",
          "the delivery's endpoint was deleted; it cannot be replayed",
        );
      case "in_progress":
        throw new ApiError(
          409,
          "delivery_in_progress",
          `the delivery is ${result.status}; only succeeded, failed or dead deliveries can be replayed`,
        );
    }
  });

  return router;
}

/** POST /v1/replay: bulk replay by status, endpoint and time range. */
export function bulkReplayRouter(repo: Repository): Router {
  const router = Router();
  router.post("/", async (req, res) => {
    const body = parse(bulkReplayBody, req.body ?? {});
    const replayed = await repo.deliveries.bulkReplay(projectIdOf(res), {
      statuses: Array.isArray(body.status) ? body.status : [body.status],
      endpointId: body.endpoint_id,
      from: body.from ? new Date(body.from) : undefined,
      to: body.to ? new Date(body.to) : undefined,
    });
    res.status(202).json({ replayed, limit: BULK_REPLAY_CAP });
  });
  return router;
}

/** GET /v1/dlq, POST /v1/dlq/retry: dead deliveries. */
export function dlqRouter(repo: Repository): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const query = parse(listDlqQuery, req.query);
    const page = await repo.deliveries.list(projectIdOf(res), {
      status: "dead",
      endpointId: query.endpoint_id,
      limit: query.limit,
      cursor: query.cursor,
    });
    res.json({
      data: page.data.map(serializeDelivery),
      next_cursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    });
  });

  router.post("/retry", async (req, res) => {
    const body = parse(dlqRetryBody, req.body ?? {});
    const replayed = await repo.deliveries.bulkReplay(projectIdOf(res), {
      statuses: ["dead"],
      endpointId: body.endpoint_id,
    });
    res.status(202).json({ replayed, limit: BULK_REPLAY_CAP });
  });

  return router;
}

function parseId(params: unknown): string {
  const result = uuidParam.safeParse(params);
  if (!result.success) throw notFound("delivery");
  return result.data.id;
}
