import { describe, expect, it } from "vitest";
import {
  decodeSigningSecret,
  generateSigningSecret,
  sign,
  signHeaders,
  verify,
  WEBHOOK_HEADERS,
} from "./signing.js";

// Test vector from the Standard Webhooks specification.
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

function verifyVector(overrides: Partial<Parameters<typeof verify>[0]> = {}) {
  return verify({
    id: VECTOR.id,
    timestamp: String(VECTOR.timestamp),
    signature: VECTOR.signature,
    body: VECTOR.body,
    secret: VECTOR.secret,
    now: VECTOR.timestamp,
    ...overrides,
  });
}

describe("sign", () => {
  it("matches the Standard Webhooks test vector", () => {
    expect(sign(VECTOR)).toBe(VECTOR.signature);
  });

  it("signs Buffer bodies identically to strings", () => {
    expect(sign({ ...VECTOR, body: Buffer.from(VECTOR.body) })).toBe(VECTOR.signature);
  });

  it("accepts secrets without the whsec_ prefix", () => {
    expect(sign({ ...VECTOR, secret: VECTOR.secret.slice("whsec_".length) })).toBe(
      VECTOR.signature,
    );
  });
});

describe("generateSigningSecret", () => {
  it("produces whsec_-prefixed base64 of 32 bytes", () => {
    const secret = generateSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/);
    expect(decodeSigningSecret(secret)).toHaveLength(32);
    expect(generateSigningSecret()).not.toBe(secret);
  });

  it("rejects non-base64 and empty secrets", () => {
    expect(() => decodeSigningSecret("whsec_not base64!")).toThrow();
    expect(() => decodeSigningSecret("whsec_")).toThrow();
  });
});

describe("signHeaders", () => {
  it("sets the three Standard Webhooks headers", () => {
    const headers = signHeaders({ ...VECTOR, secrets: [VECTOR.secret] });
    expect(headers).toEqual({
      [WEBHOOK_HEADERS.id]: VECTOR.id,
      [WEBHOOK_HEADERS.timestamp]: String(VECTOR.timestamp),
      [WEBHOOK_HEADERS.signature]: VECTOR.signature,
    });
  });

  it("sends one space-separated signature per secret during rotation", () => {
    const other = generateSigningSecret();
    const headers = signHeaders({ ...VECTOR, secrets: [VECTOR.secret, other] });
    const parts = headers["webhook-signature"].split(" ");
    expect(parts).toEqual([VECTOR.signature, sign({ ...VECTOR, secret: other })]);
  });

  it("requires at least one secret", () => {
    expect(() => signHeaders({ ...VECTOR, secrets: [] })).toThrow();
  });
});

describe("verify", () => {
  it("accepts a valid signature", () => {
    expect(verifyVector()).toEqual({ valid: true });
  });

  it("accepts a match anywhere in a space-separated list (rotation)", () => {
    const stale = sign({ ...VECTOR, secret: generateSigningSecret() });
    expect(verifyVector({ signature: `${stale} ${VECTOR.signature}` })).toEqual({ valid: true });
    expect(verifyVector({ signature: `v2,abc ${VECTOR.signature}` })).toEqual({ valid: true });
  });

  it("rejects a wrong secret, wrong id, changed body and garbage signatures", () => {
    const fail = { valid: false, reason: "no_matching_signature" };
    expect(verifyVector({ secret: generateSigningSecret() })).toEqual(fail);
    expect(verifyVector({ id: "msg_other" })).toEqual(fail);
    expect(verifyVector({ body: '{"test": 2432232315}' })).toEqual(fail);
    expect(verifyVector({ signature: "v1,AAAA" })).toEqual(fail);
    expect(verifyVector({ signature: VECTOR.signature.replace("v1,", "v2,") })).toEqual(fail);
    expect(verifyVector({ signature: "nonsense" })).toEqual(fail);
  });

  it("rejects missing headers", () => {
    for (const key of ["id", "timestamp", "signature"] as const) {
      expect(verifyVector({ [key]: undefined })).toEqual({
        valid: false,
        reason: "missing_headers",
      });
    }
  });

  it("rejects non-numeric timestamps", () => {
    expect(verifyVector({ timestamp: "1614265330.5" })).toEqual({
      valid: false,
      reason: "invalid_timestamp",
    });
  });

  it("enforces a 5 minute tolerance in both directions", () => {
    const ts = VECTOR.timestamp;
    expect(verifyVector({ now: ts + 300 })).toEqual({ valid: true });
    expect(verifyVector({ now: ts - 300 })).toEqual({ valid: true });
    expect(verifyVector({ now: ts + 301 })).toEqual({ valid: false, reason: "timestamp_too_old" });
    expect(verifyVector({ now: ts - 301 })).toEqual({ valid: false, reason: "timestamp_too_new" });
  });

  it("uses the system clock by default", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign({ ...VECTOR, timestamp });
    expect(verify({ ...VECTOR, timestamp: String(timestamp), signature, now: undefined })).toEqual({
      valid: true,
    });
  });
});
