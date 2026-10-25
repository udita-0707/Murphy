import { createHash } from "node:crypto";

/**
 * Serialises a JSON-compatible value with object keys sorted recursively, so that two values
 * that differ only in key order produce the same string. Array order is preserved. Follows
 * JSON.stringify semantics for undefined, functions and toJSON.
 */
export function canonicalJson(value: unknown): string {
  const out = serialise(value);
  if (out === undefined) {
    throw new TypeError("value is not JSON-serialisable");
  }
  return out;
}

function serialise(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialise(item) ?? "null").join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = serialise((value as Record<string, unknown>)[key]);
      if (item !== undefined) parts.push(`${JSON.stringify(key)}:${item}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** SHA-256 (hex) of the canonical JSON of a value. Used for idempotency comparison (ADR 002). */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
