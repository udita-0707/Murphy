import type { Repository } from "@murphy/db";
import { Router, type RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  generateSessionToken,
  hashSessionToken,
  isSessionToken,
  SESSION_LIFETIME_MS,
} from "../sessions.js";
import { parse } from "../validation.js";

const loginBody = z.strictObject({
  github_id: z.number().int().positive(),
  login: z.string().min(1).max(39),
});
const revokeBody = z.strictObject({ token: z.string().max(256) });

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Compares digests, so neither the length nor the content of the secret can be timed. */
function requireSecret(secret: string): RequestHandler {
  const expected = digest(secret);
  return (req, _res, next) => {
    const presented = digest(req.get("x-murphy-internal") ?? "");
    if (!timingSafeEqual(presented, expected)) {
      throw new ApiError(404, "not_found", "route not found");
    }
    next();
  };
}

/**
 * Called only by the dashboard's server, after it has verified a GitHub login (ADR 014). A caller
 * without the secret sees a route that does not exist.
 */
export function internalRouter(repo: Repository, secret: string): Router {
  const router = Router();
  router.use(requireSecret(secret));

  router.post("/github-login", async (req, res) => {
    const body = parse(loginBody, req.body);
    const project = await repo.projects.findOrCreateByOwner(
      `github:${body.github_id}`,
      `GitHub: ${body.login}`,
    );
    const { token, hash } = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    await repo.sessions.create(project.id, { tokenHash: hash, expiresAt });
    res.status(201).json({ token, expires_at: expiresAt.toISOString() });
  });

  router.post("/session-revoke", async (req, res) => {
    const body = parse(revokeBody, req.body);
    if (isSessionToken(body.token)) {
      await repo.sessions.revokeByHash(hashSessionToken(body.token), new Date());
    }
    res.status(204).end();
  });

  return router;
}
