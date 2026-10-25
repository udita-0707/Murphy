import { describe, expect, it } from "vitest";
import { apiKeyMatches, generateApiKey, hashApiKey, parseApiKey } from "./api-keys.js";

describe("API keys", () => {
  it("have the format mk_<8-char prefix>_<base64url of 32 bytes>", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^mk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(`mk_${prefix}_`)).toBe(true);
    expect(Buffer.from(key.split("_").slice(2).join("_"), "base64url")).toHaveLength(32);
    expect(hash.equals(hashApiKey(key))).toBe(true);
  });

  it("parse back to their prefix, even when the secret contains underscores", () => {
    const key = `mk_abcd1234_${"_".repeat(43)}`;
    expect(parseApiKey(key)).toEqual({ prefix: "abcd1234" });
    const generated = generateApiKey();
    expect(parseApiKey(generated.key)).toEqual({ prefix: generated.prefix });
  });

  it("reject malformed keys", () => {
    for (const bad of [
      "",
      "mk_",
      "sk_abcd1234_" + "a".repeat(43),
      "mk_ABCD1234_" + "a".repeat(43),
      "mk_abcd1234_short",
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it("match only the original key", () => {
    const { key, hash } = generateApiKey();
    expect(apiKeyMatches(key, hash)).toBe(true);
    expect(apiKeyMatches(generateApiKey().key, hash)).toBe(false);
    expect(apiKeyMatches(key, Buffer.alloc(3))).toBe(false);
  });
});
