import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import { nextRetryDelay, RETRY_JITTER, RETRY_SCHEDULE_MS } from "./retry.js";
import { sign, verify } from "./signing.js";

const secretArb = fc
  .uint8Array({ minLength: 1, maxLength: 64 })
  .map((bytes) => `whsec_${Buffer.from(bytes).toString("base64")}`);
const idArb = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes(" "));
const timestampArb = fc.integer({ min: 0, max: 4_102_444_800 });
const bodyArb = fc.uint8Array({ minLength: 1, maxLength: 512 }).map((b) => Buffer.from(b));

describe("properties", () => {
  it("jitter always stays within +/-20% of the scheduled delay", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: RETRY_SCHEDULE_MS.length }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempt, r) => {
          const base = RETRY_SCHEDULE_MS[attempt - 1]!;
          const delay = nextRetryDelay(attempt, { random: () => r });
          expect(delay).not.toBeNull();
          expect(delay!).toBeGreaterThanOrEqual(Math.floor(base * (1 - RETRY_JITTER)));
          expect(delay!).toBeLessThanOrEqual(Math.ceil(base * (1 + RETRY_JITTER)));
        },
      ),
    );
  });

  it("sign then verify round-trips", () => {
    fc.assert(
      fc.property(secretArb, idArb, timestampArb, bodyArb, (secret, id, timestamp, body) => {
        const signature = sign({ id, timestamp, body, secret });
        expect(
          verify({ id, timestamp: String(timestamp), signature, body, secret, now: timestamp }),
        ).toEqual({ valid: true });
      }),
    );
  });

  it("any single-byte body change fails verification", () => {
    fc.assert(
      fc.property(
        secretArb,
        idArb,
        timestampArb,
        bodyArb,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (secret, id, timestamp, body, index, flip) => {
          const signature = sign({ id, timestamp, body, secret });
          const changed = Buffer.from(body);
          const i = index % changed.length;
          changed[i] = changed[i]! ^ flip;
          expect(
            verify({
              id,
              timestamp: String(timestamp),
              signature,
              body: changed,
              secret,
              now: timestamp,
            }),
          ).toEqual({ valid: false, reason: "no_matching_signature" });
        },
      ),
    );
  });

  it("canonical JSON is a fixed point and parses back to an equal value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
        expect(JSON.parse(once)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });
});
