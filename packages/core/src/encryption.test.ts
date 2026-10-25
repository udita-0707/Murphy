import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseEncryptionKey } from "./encryption.js";

const key = randomBytes(32);

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("whsec_abc", key);
    const b = encryptSecret("whsec_abc", key);
    expect(decryptSecret(a, key)).toBe("whsec_abc");
    expect(a.equals(b)).toBe(false);
  });

  it("fails on tampering or the wrong key", () => {
    const data = encryptSecret("whsec_abc", key);
    const tampered = Buffer.from(data);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(data, randomBytes(32))).toThrow();
    expect(() => decryptSecret(Buffer.alloc(5), key)).toThrow();
  });
});

describe("parseEncryptionKey", () => {
  it("accepts base64 of 32 bytes", () => {
    expect(parseEncryptionKey(key.toString("base64")).equals(key)).toBe(true);
  });

  it("rejects missing or wrong-length keys", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/openssl rand -base64 32/);
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
