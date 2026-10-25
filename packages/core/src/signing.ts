import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Standard Webhooks header names. */
export const WEBHOOK_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

/** Receivers reject timestamps more than this far in the past or future. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";

/** Generates a new signing secret: `whsec_` followed by base64 of 32 random bytes. */
export function generateSigningSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64");
}

/** Decodes a `whsec_`-prefixed (or bare) base64 secret into its key bytes. */
export function decodeSigningSecret(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("signing secret must be base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) {
    throw new Error("signing secret is empty");
  }
  return key;
}

export interface SignInput {
  id: string;
  /** Unix seconds. */
  timestamp: number;
  /** The exact raw body bytes that will be sent. */
  body: string | Buffer;
  secret: string;
}

/** Returns one signature, `v1,<base64 HMAC-SHA256>`, over `{id}.{timestamp}.{body}`. */
export function sign({ id, timestamp, body, secret }: SignInput): string {
  return `${SIGNATURE_VERSION},${hmac(decodeSigningSecret(secret), id, timestamp, body).toString("base64")}`;
}

/**
 * Builds the three Standard Webhooks headers. With several secrets (rotation) the signature
 * header carries one space-separated signature per secret.
 */
export function signHeaders(input: {
  id: string;
  timestamp: number;
  body: string | Buffer;
  secrets: readonly string[];
}): Record<(typeof WEBHOOK_HEADERS)[keyof typeof WEBHOOK_HEADERS], string> {
  if (input.secrets.length === 0) {
    throw new Error("at least one signing secret is required");
  }
  return {
    [WEBHOOK_HEADERS.id]: input.id,
    [WEBHOOK_HEADERS.timestamp]: String(input.timestamp),
    [WEBHOOK_HEADERS.signature]: input.secrets
      .map((secret) => sign({ id: input.id, timestamp: input.timestamp, body: input.body, secret }))
      .join(" "),
  };
}

export type VerifyFailure =
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_too_old"
  | "timestamp_too_new"
  | "no_matching_signature";

export type VerifyResult = { valid: true } | { valid: false; reason: VerifyFailure };

export interface VerifyInput {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string | Buffer;
  secret: string;
  /** Current time in unix seconds; defaults to the system clock. */
  now?: number;
  toleranceSeconds?: number;
}

/**
 * Verifies a Standard Webhooks signature. Accepts any one matching `v1` signature among
 * space-separated candidates (secret rotation), compares in constant time, and enforces the
 * timestamp tolerance in both directions.
 */
export function verify(input: VerifyInput): VerifyResult {
  const { id, timestamp, signature, body, secret } = input;
  if (!id || !timestamp || !signature) {
    return { valid: false, reason: "missing_headers" };
  }
  if (!/^\d{1,15}$/.test(timestamp)) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  const ts = Number(timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (now - ts > tolerance) return { valid: false, reason: "timestamp_too_old" };
  if (ts - now > tolerance) return { valid: false, reason: "timestamp_too_new" };

  const expected = hmac(decodeSigningSecret(secret), id, ts, body);
  for (const candidate of signature.split(" ")) {
    const comma = candidate.indexOf(",");
    if (comma === -1 || candidate.slice(0, comma) !== SIGNATURE_VERSION) continue;
    const given = Buffer.from(candidate.slice(comma + 1), "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return { valid: true };
    }
  }
  return { valid: false, reason: "no_matching_signature" };
}

function hmac(key: Buffer, id: string, timestamp: number, body: string | Buffer): Buffer {
  return createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
    .digest();
}
