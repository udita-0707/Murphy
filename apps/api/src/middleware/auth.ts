import type { Repository } from "@murphy/db";
import type { RequestHandler, Response } from "express";
import { apiKeyMatches, parseApiKey } from "../api-keys.js";
import { unauthorized } from "../errors.js";

/** Authenticates `Authorization: Bearer mk_...` and stores the caller's project id. */
export function authenticate(repo: Repository): RequestHandler {
  return async (req, res, next) => {
    const header = req.get("authorization");
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    const key = match?.[1];
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
