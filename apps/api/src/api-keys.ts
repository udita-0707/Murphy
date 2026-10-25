import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_PATTERN = /^mk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedApiKey {
  /** The full key; shown to the user exactly once. */
  key: string;
  prefix: string;
  hash: Buffer;
}

/** Generates `mk_<8-char prefix>_<base64url of 32 random bytes>`. */
export function generateApiKey(): GeneratedApiKey {
  const bytes = randomBytes(8);
  const prefix = Array.from(bytes, (b) => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join("");
  const key = `mk_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, hash: hashApiKey(key) };
}

/** Returns the lookup prefix, or null if the string is not shaped like a Murphy key. */
export function parseApiKey(key: string): { prefix: string } | null {
  const match = KEY_PATTERN.exec(key);
  return match ? { prefix: match[1]! } : null;
}

export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

/** Constant-time check of a presented key against a stored SHA-256 hash. */
export function apiKeyMatches(key: string, storedHash: Buffer): boolean {
  const presented = hashApiKey(key);
  return presented.length === storedHash.length && timingSafeEqual(presented, storedHash);
}
