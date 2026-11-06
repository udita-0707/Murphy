import { createHash, randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^ms_[A-Za-z0-9_-]{43}$/;
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function generateSessionToken(): { token: string; hash: Buffer } {
  const token = `ms_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashSessionToken(token) };
}

export function isSessionToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
