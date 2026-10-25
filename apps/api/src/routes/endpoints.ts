import { encryptSecret, generateSigningSecret } from "@murphy/core";
import type { Repository } from "@murphy/db";
import { Router } from "express";
import { notFound } from "../errors.js";
import { projectIdOf } from "../middleware/auth.js";
import { serializeEndpoint } from "../serializers.js";
import { createEndpointBody, parse, updateEndpointBody, uuidParam } from "../validation.js";

export function endpointsRouter(repo: Repository, encryptionKey: Buffer): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const body = parse(createEndpointBody, req.body);
    const secret = generateSigningSecret();
    const endpoint = await repo.endpoints.create(projectIdOf(res), {
      url: body.url,
      description: body.description ?? null,
      eventFilter: body.event_filter ?? [],
      secretEnc: encryptSecret(secret, encryptionKey),
    });
    // The signing secret is returned here and never again.
    res.status(201).json({ ...serializeEndpoint(endpoint), secret });
  });

  router.get("/", async (_req, res) => {
    const endpoints = await repo.endpoints.list(projectIdOf(res));
    res.json({ data: endpoints.map(serializeEndpoint) });
  });

  router.get("/:id", async (req, res) => {
    const { id } = parseId(req.params);
    const endpoint = await repo.endpoints.get(projectIdOf(res), id);
    if (!endpoint) throw notFound("endpoint");
    res.json(serializeEndpoint(endpoint));
  });

  router.patch("/:id", async (req, res) => {
    const { id } = parseId(req.params);
    const body = parse(updateEndpointBody, req.body);
    const endpoint = await repo.endpoints.update(projectIdOf(res), id, {
      url: body.url,
      description: body.description,
      eventFilter: body.event_filter,
      status: body.status,
    });
    if (!endpoint) throw notFound("endpoint");
    res.json(serializeEndpoint(endpoint));
  });

  router.delete("/:id", async (req, res) => {
    const { id } = parseId(req.params);
    const deleted = await repo.endpoints.delete(projectIdOf(res), id);
    if (!deleted) throw notFound("endpoint");
    res.status(204).end();
  });

  return router;
}

/** Malformed ids cannot exist, so they are a 404 rather than a validation error. */
function parseId(params: unknown): { id: string } {
  const result = uuidParam.safeParse(params);
  if (!result.success) throw notFound("endpoint");
  return result.data;
}
