import { canonicalHash } from "@murphy/core";
import type { JsonObject, Repository } from "@murphy/db";
import { Router } from "express";
import { ApiError, notFound } from "../errors.js";
import { projectIdOf } from "../middleware/auth.js";
import { serializeEvent } from "../serializers.js";
import { createEventBody, idempotencyKey, parse, uuidParam } from "../validation.js";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

export function eventsRouter(repo: Repository): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const rawKey = req.get(IDEMPOTENCY_KEY_HEADER);
    if (rawKey === undefined) {
      throw new ApiError(400, "idempotency_key_required", "the Idempotency-Key header is required");
    }
    const key = parse(idempotencyKey, rawKey);
    const body = parse(createEventBody, req.body);
    // The body came from JSON.parse, so the payload is JSON.
    const payload = body.payload as JsonObject;

    const result = await repo.events.accept(projectIdOf(res), {
      type: body.type,
      payload,
      idempotencyKey: key,
      requestHash: canonicalHash({ type: body.type, payload }),
    });

    switch (result.outcome) {
      case "created":
        res.status(202).json({ id: result.eventId, deliveries: result.deliveries });
        return;
      case "replayed":
        res
          .status(202)
          .setHeader(IDEMPOTENT_REPLAYED_HEADER, "true")
          .json({ id: result.eventId, deliveries: result.deliveries });
        return;
      case "conflict":
        throw new ApiError(
          409,
          "idempotency_key_reused",
          "this Idempotency-Key was already used with a different event type or payload",
        );
    }
  });

  router.get("/:id", async (req, res) => {
    const params = uuidParam.safeParse(req.params);
    if (!params.success) throw notFound("event");
    const event = await repo.events.getWithDeliveries(projectIdOf(res), params.data.id);
    if (!event) throw notFound("event");
    res.json(serializeEvent(event));
  });

  return router;
}
