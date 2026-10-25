import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson, sha256Hex } from "./canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("is insensitive to key order", () => {
    expect(canonicalJson({ x: 1, y: { a: 1, b: 2 } })).toBe(
      canonicalJson({ y: { b: 2, a: 1 }, x: 1 }),
    );
  });

  it("follows JSON.stringify for primitives, undefined and toJSON", () => {
    expect(canonicalJson('hé"llo')).toBe(JSON.stringify('hé"llo'));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
    expect(canonicalJson({ d: new Date("2026-11-12T00:00:00Z") })).toBe(
      '{"d":"2026-11-12T00:00:00.000Z"}',
    );
  });

  it("throws for values with no JSON representation", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe("canonicalHash", () => {
  it("is SHA-256 hex of the canonical JSON", () => {
    expect(canonicalHash({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
    expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different values", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
  });
});
