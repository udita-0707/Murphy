import type { Repository } from "@murphy/db";
import type { RequestHandler, Response } from "express";
import { apiKeyMatches, parseApiKey } from "../api-keys.js";
import { unauthorized } from "../errors.js";
import { hashSessionToken, isSessionToken } from "../sessions.js";

/**
 * Authenticates `Authorization: Bearer mk_...` or a session token `ms_...` (ADR 014), and stores the
 * caller's project id. Either way every route below sees only one project.
 */
export function authenticate(repo: Repository): RequestHandler {
  return async (req, res, next) => {
    const header = req.get("authorization");
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const key = match?.[1];
    if (key && isSessionToken(key)) {
      const session = await repo.sessions.findActiveByHash(hashSessionToken(key), new Date());
      if (!session) throw unauthorized();
      res.locals.projectId = session.projectId;
      next();
      return;
    }
    const parsed = key ? parseApiKey(key) : null;
    if (!key || !parsed) {
      throw unauthorized();
    }
    const record = await repo.apiKeys.findActiveByPrefix(parsed.prefix);
    if (!record || !apiKeyMatches(key, record.keyHash)) {
      throw unauthorized();
    }
    res.locals.projectId = record.projectId;
    next();
  };
}

/** The authenticated tenant. Only valid on routes behind `authenticate`. */
export function projectIdOf(res: Response): string {
  const projectId: unknown = res.locals.projectId;
  if (typeof projectId !== "string") {
    throw new Error("projectIdOf called on an unauthenticated route");
  }
  return projectId;
}
