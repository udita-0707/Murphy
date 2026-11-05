import { describe, expect, it } from "vitest";
import { decide, isClean2xx, isProcessed } from "../src/decide.js";
import { hash01, makePlan, planHash } from "../src/plan.js";

describe("chaos plan", () => {
  it("is identical for the same seed", () => {
    expect(makePlan({ seed: 1001 })).toEqual(makePlan({ seed: 1001 }));
    expect(planHash(makePlan({ seed: 1001 }))).toBe(planHash(makePlan({ seed: 1001 })));
  });

  it("differs between seeds", () => {
    const a = makePlan({ seed: 1001 });
    const b = makePlan({ seed: 2002 });
    expect(planHash(a)).not.toBe(planHash(b));
    expect(a.faults).not.toEqual(b.faults);
  });

  it("plans every kind of fault, in time order, inside the load", () => {
    const plan = makePlan({ seed: 7, events: 300, rate: 50 });
    const actions = new Set(plan.faults.map((f) => f.action));
    expect(actions).toEqual(
      new Set([
        "kill_worker",
        "kill_api",
        "restart_postgres",
        "disable_endpoint",
        "enable_endpoint",
        "delete_endpoint",
      ]),
    );
    const times = plan.faults.map((f) => f.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Math.max(...times)).toBeLessThan(plan.loadMs);
    const kills = plan.faults.filter((f) => f.action === "kill_worker");
    expect(kills.length).toBeGreaterThanOrEqual(3);
    expect(kills.length).toBeLessThanOrEqual(5);
    expect(plan.faults.filter((f) => f.action === "restart_postgres")).toHaveLength(2);
    expect(plan.faults.filter((f) => f.action === "kill_api")).toHaveLength(2);
  });

  it("keeps the toggled endpoint's disable before its enable", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const faults = makePlan({ seed }).faults;
      const disable = faults.find(
        (f) => f.action === "disable_endpoint" && f.endpoint === "c-toggled",
      );
      const enable = faults.find((f) => f.action === "enable_endpoint");
      expect(disable!.atMs).toBeLessThan(enable!.atMs);
    }
  });

  it("gives every event a unique key and logical id", () => {
    const { events } = makePlan({ seed: 9, events: 500 });
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(500);
    expect(new Set(events.map((e) => e.logicalId)).size).toBe(500);
    expect(events.filter((e) => e.resend).length).toBeGreaterThan(0);
  });

  it("keeps the production number of retries", () => {
    expect(makePlan({ seed: 1 }).retryScheduleMs).toHaveLength(8);
  });

  it("hash01 is fixed by its inputs and stays in range", () => {
    expect(hash01(1, "a", 2)).toBe(hash01(1, "a", 2));
    expect(hash01(1, "a", 2)).not.toBe(hash01(1, "a", 3));
    expect(hash01(1, "a", 2)).toBeLessThan(1);
  });
});

describe("receiver decisions", () => {
  const input = {
    seed: 1001,
    endpoint: "x",
    webhookId: "msg_1",
    arrival: 1,
    goneReached: false,
  };

  it("are fixed by the seed and the message, not by anything else", () => {
    for (const profile of ["flaky", "slow", "lost_ack"] as const) {
      for (let arrival = 1; arrival < 50; arrival++) {
        expect(decide({ ...input, profile, arrival })).toEqual(
          decide({ ...input, profile, arrival }),
        );
      }
    }
  });

  it("change with the seed", () => {
    const run = (seed: number) =>
      Array.from(
        { length: 200 },
        (_, i) => decide({ ...input, seed, profile: "flaky", arrival: i + 1 }).action,
      );
    expect(run(1)).not.toEqual(run(2));
  });

  it("never fault the control endpoint and always fault always_500", () => {
    for (let arrival = 1; arrival < 200; arrival++) {
      expect(decide({ ...input, profile: "control", arrival }).action).toBe("ok");
      expect(decide({ ...input, profile: "always_500", arrival }).action).toBe("fail_500");
    }
  });

  it("produce every action of each faulty profile", () => {
    const seen = (profile: "flaky" | "slow" | "lost_ack") =>
      new Set(
        Array.from({ length: 500 }, (_, i) => decide({ ...input, profile, arrival: i }).action),
      );
    expect(seen("flaky")).toEqual(new Set(["ok", "fail_500"]));
    expect(seen("slow")).toEqual(new Set(["ok", "slow", "hang"]));
    expect(seen("lost_ack")).toEqual(new Set(["ok", "process_then_500", "process_then_reset"]));
  });

  it("answer 410 on the gone endpoint only past its limit", () => {
    expect(decide({ ...input, profile: "gone" }).action).toBe("ok");
    expect(decide({ ...input, profile: "gone", goneReached: true }).action).toBe("gone_410");
  });

  it("keep hang above the worker's timeout, and classify effects", () => {
    expect(decide({ ...input, profile: "gone" }).delayMs).toBe(0);
    expect(isProcessed("process_then_500")).toBe(true);
    expect(isClean2xx("process_then_500")).toBe(false);
    expect(isProcessed("fail_500")).toBe(false);
    expect(isClean2xx("slow")).toBe(true);
    expect(isClean2xx("hang")).toBe(false);
  });
});
