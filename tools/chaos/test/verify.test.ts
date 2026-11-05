import { describe, expect, it } from "vitest";
import { makePlan } from "../src/plan.js";
import type {
  ChaosPlan,
  ClientRecord,
  DbDelivery,
  ReceiverAction,
  ReceiverRecord,
  RunData,
} from "../src/types.js";
import { percentiles, verifyRun } from "../src/verify.js";

/**
 * A small, fully consistent run, built by hand. It passes every invariant, and each test below
 * damages one source in one way, so every invariant is shown to be able to fail.
 */
function world(): RunData {
  const plan: ChaosPlan = {
    ...makePlan({ seed: 1, events: 1 }),
    endpoints: [
      { key: "ok", projectKey: "p", profile: "control", filter: [] },
      { key: "dead", projectKey: "p", profile: "always_500", filter: [] },
      { key: "dup", projectKey: "p", profile: "lost_ack", filter: [] },
      { key: "parked", projectKey: "p", profile: "parked", filter: [] },
      { key: "gone", projectKey: "p", profile: "deleted", filter: [] },
      { key: "other-type", projectKey: "p", profile: "flaky", filter: ["never.sent"] },
    ],
    projects: ["p"],
    faults: [
      { atMs: 1, action: "restart_postgres" },
      { atMs: 2, action: "kill_worker", worker: 0, respawnMs: 1 },
    ],
  };
  const eventId = "e1";
  const webhookId = `msg_${eventId}`;
  const client: ClientRecord[] = [
    {
      kind: "send",
      t: 100,
      key: "k1",
      logicalId: "l1",
      projectKey: "p",
      type: "t",
      payloadHash: "hash",
      try: 1,
      deliberateResend: false,
    },
    { kind: "error", t: 110, key: "k1", detail: "connection reset" },
    { kind: "ack", t: 120, key: "k1", eventId, deliveries: 5, replayed: false },
    {
      kind: "send",
      t: 130,
      key: "k1",
      logicalId: "l1",
      projectKey: "p",
      type: "t",
      payloadHash: "hash",
      try: 2,
      deliberateResend: true,
    },
    { kind: "ack", t: 140, key: "k1", eventId, deliveries: 5, replayed: true },
  ];
  const receipt = (
    t: number,
    endpoint: string,
    action: ReceiverAction,
    processed: boolean,
    idempotentApplied: boolean,
  ): ReceiverRecord => ({
    t,
    endpoint,
    webhookId,
    arrival: 1,
    signatureValid: true,
    payloadHash: "hash",
    logicalId: "l1",
    projectKey: "p",
    eventType: "t",
    action,
    processed,
    idempotentApplied,
  });
  const receiver: ReceiverRecord[] = [
    receipt(200, "ok", "ok", true, true),
    receipt(210, "dead", "fail_500", false, false),
    receipt(220, "dup", "process_then_500", true, true),
    receipt(230, "dup", "ok", true, false),
    // Rare actions exist so the "did the faults do anything" checks pass on this tiny run.
    receipt(240, "dead", "slow", false, false),
    receipt(241, "dead", "hang", false, false),
    receipt(242, "dead", "process_then_reset", false, false),
    receipt(243, "dead", "gone_410", false, false),
  ];
  const delivery = (id: string, endpointId: string, status: string): DbDelivery => ({
    id,
    eventId,
    endpointId,
    projectId: "pid",
    status,
    attemptCount: 1,
    reapCount: 0,
    lockedBy: null,
    lockedUntil: null,
    claimToken: null,
  });
  return {
    plan,
    projectIds: { p: "pid" },
    endpointIds: {
      ok: "eok",
      dead: "edead",
      dup: "edup",
      parked: "eparked",
      gone: "egone",
      "other-type": "eother",
    },
    client,
    control: [
      { t: 40, action: "kill_worker", phase: "start", target: "w0.0" },
      { t: 50, action: "disable_endpoint", phase: "start", target: "parked" },
      { t: 51, action: "disable_endpoint", phase: "done", target: "parked" },
      { t: 60, action: "delete_endpoint", phase: "start", target: "gone" },
      { t: 61, action: "delete_endpoint", phase: "done", target: "gone" },
    ],
    receiver,
    db: {
      events: [
        { id: eventId, projectId: "pid", idempotencyKey: "k1", type: "t", payloadHash: "hash" },
      ],
      deliveries: [
        delivery("d1", "eok", "succeeded"),
        delivery("d2", "edead", "dead"),
        delivery("d3", "edup", "succeeded"),
        delivery("d4", "eparked", "pending"),
        delivery("d5", "egone", "cancelled"),
      ],
      endpoints: [
        { id: "eok", status: "active", deleted: false },
        { id: "edead", status: "active", deleted: false },
        { id: "edup", status: "active", deleted: false },
        { id: "eparked", status: "disabled", deleted: false },
        { id: "egone", status: "active", deleted: true },
        { id: "eother", status: "active", deleted: false },
      ],
      attemptRows: 6,
      leaseExpiredByWorker: { "w0.0": 1 },
    },
    audit: { total: 0, rowsChecked: 20, examples: [] },
    unexpectedExits: [],
    drainTimedOut: false,
    postmasterStarts: ["a", "b"],
  };
}

function failing(data: RunData): string[] {
  return verifyRun(data)
    .invariants.filter((i) => i.status === "fail")
    .map((i) => i.id);
}

const row = (data: RunData, id: string) => data.db.deliveries.find((d) => d.id === id)!;

describe("verifyRun", () => {
  it("passes a consistent run", () => {
    const result = verifyRun(world());
    expect(result.invariants.filter((i) => i.status === "fail")).toEqual([]);
    expect(result.effects.filter((e) => !e.ok)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.counts).toMatchObject({ eventsAcked: 1, deliveries: 5, replayedAcks: 1 });
  });

  describe("I1: a 202 is durable", () => {
    it("fails when an acknowledged event is missing from the database", () => {
      const data = world();
      data.db.events = [];
      expect(failing(data)).toContain("I1");
    });
    it("fails when the stored payload differs from what was sent", () => {
      const data = world();
      data.db.events[0]!.payloadHash = "tampered";
      expect(failing(data)).toContain("I1");
    });
  });

  describe("I2: idempotency", () => {
    it("fails when retries of a key were given different ids", () => {
      const data = world();
      data.client.push({
        kind: "ack",
        t: 150,
        key: "k1",
        eventId: "e2",
        deliveries: 5,
        replayed: true,
      });
      expect(failing(data)).toContain("I2");
    });
    it("fails when the database holds an event the client never sent", () => {
      const data = world();
      data.db.events.push({
        id: "x",
        projectId: "pid",
        idempotencyKey: "invented",
        type: "t",
        payloadHash: "hash",
      });
      expect(failing(data)).toContain("I2");
    });
  });

  it("I3 fails when the delivery rows differ from the 202", () => {
    const data = world();
    data.db.deliveries.pop();
    expect(failing(data)).toContain("I3");
  });

  describe("I4: no loss", () => {
    it("fails when a stable endpoint has no delivery row", () => {
      const data = world();
      data.db.deliveries = data.db.deliveries.filter((d) => d.id !== "d1");
      expect(failing(data)).toContain("I4");
    });
    it("allows no row when the endpoint was out of service at the time", () => {
      const data = world();
      data.db.deliveries = data.db.deliveries.filter((d) => d.id !== "d4");
      data.client = data.client.map((c) => (c.kind === "ack" ? { ...c, deliveries: 4 } : c));
      expect(failing(data)).toEqual([]);
      expect(verifyRun(data).counts.noDeliveryByDesign).toBe(1);
    });
    it("fails when an endpoint in service before the event has no row", () => {
      const data = world();
      data.db.deliveries = data.db.deliveries.filter((d) => d.id !== "d4");
      data.control = data.control.filter((c) => c.target !== "parked");
      expect(failing(data)).toContain("I4");
    });
    it("fails when a delivery went dead without the receiver ever seeing it", () => {
      const data = world();
      data.receiver = data.receiver.filter((r) => r.endpoint !== "dead");
      expect(failing(data)).toContain("I4");
    });
    it("fails when the control endpoint, which never faults, went dead", () => {
      const data = world();
      row(data, "d1").status = "dead";
      expect(failing(data)).toContain("I4");
    });
    it("fails when a delivery went to an endpoint whose filter excludes it", () => {
      const data = world();
      data.db.deliveries.push({ ...row(data, "d1"), id: "d6", endpointId: "eother" });
      expect(failing(data)).toContain("I4");
    });
  });

  it("I5 fails when a delivery is marked succeeded with no 2xx at the receiver", () => {
    const data = world();
    row(data, "d2").status = "succeeded";
    // The fixture's "slow" receipt on this endpoint counts as a 2xx, so take it away.
    data.receiver = data.receiver.filter((r) => !(r.endpoint === "dead" && r.action === "slow"));
    expect(failing(data)).toContain("I5");
  });

  describe("I6: receipts are genuine", () => {
    const damage = (patch: Partial<ReceiverRecord>) => {
      const data = world();
      Object.assign(data.receiver[0]!, patch);
      return failing(data);
    };
    it("fails on an invalid signature", () => {
      expect(damage({ signatureValid: false })).toContain("I6");
    });
    it("fails on a message that was never sent", () => {
      expect(damage({ logicalId: "phantom" })).toContain("I6");
    });
    it("fails on a changed payload", () => {
      expect(damage({ payloadHash: "tampered" })).toContain("I6");
    });
    it("fails on a message reaching another tenant's endpoint", () => {
      const data = world();
      data.plan.endpoints[0]!.projectKey = "someone-else";
      expect(failing(data)).toContain("I6");
    });
    it("fails on the wrong event type header", () => {
      expect(damage({ eventType: "other" })).toContain("I6");
    });
    it("fails when the webhook-id does not match the 202", () => {
      expect(damage({ webhookId: "msg_other" })).toContain("I6");
    });
  });

  describe("I7: nothing stuck", () => {
    it("fails on a delivery pending on an active endpoint", () => {
      const data = world();
      row(data, "d1").status = "pending";
      expect(failing(data)).toContain("I7");
    });
    it("fails on a delivery pending on a deleted endpoint (bug A in ADR 009)", () => {
      const data = world();
      row(data, "d5").status = "pending";
      expect(failing(data)).toContain("I7");
    });
    it("fails on a cancelled delivery when nothing was deleted", () => {
      const data = world();
      row(data, "d1").status = "cancelled";
      expect(failing(data)).toContain("I7");
    });
  });

  describe("I8: no leases", () => {
    it("fails on a delivery still in flight", () => {
      const data = world();
      row(data, "d1").status = "in_flight";
      expect(failing(data)).toContain("I8");
    });
    it("fails on a lease left behind", () => {
      const data = world();
      row(data, "d1").claimToken = "token";
      expect(failing(data)).toContain("I8");
    });
  });

  describe("I9: history", () => {
    it("fails on a recorded violation", () => {
      const data = world();
      data.audit = {
        total: 1,
        rowsChecked: 20,
        examples: [
          { rule: "illegal_transition", deliveryId: "d1", detail: "pending -> succeeded" },
        ],
      };
      expect(failing(data)).toContain("I9");
    });
    it("fails when the history is empty, since nothing was checked", () => {
      const data = world();
      data.audit = { total: 0, rowsChecked: 0, examples: [] };
      expect(failing(data)).toContain("I9");
    });
  });

  describe("I10: exactly once", () => {
    it("fails when a logical message arrives under two webhook-ids", () => {
      const data = world();
      data.receiver[3]!.webhookId = "msg_changed_on_retry";
      expect(failing(data)).toContain("I10");
    });
    it("fails when the idempotent handler applied a message twice", () => {
      const data = world();
      data.receiver[3]!.idempotentApplied = true;
      expect(failing(data)).toContain("I10");
    });
  });

  it("I11 reports naive duplicates by cause, without failing", () => {
    const result = verifyRun(world());
    expect(result.duplicates.total).toBe(1);
    expect(result.duplicates.byCause).toEqual({
      "receiver processed it, then answered 500": 1,
    });
    expect(result.invariants.find((i) => i.id === "I11")!.status).toBe("info");
  });

  describe("overall verdict", () => {
    it("marks the run vacuous and failed when a fault had no effect", () => {
      const data = world();
      data.db.leaseExpiredByWorker = {};
      const result = verifyRun(data);
      expect(result.vacuous).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.invariants.filter((i) => i.status === "fail")).toEqual([]);
    });
    it("does not credit worker kills with leases from workers that were never killed", () => {
      const data = world();
      data.db.leaseExpiredByWorker = { "survivor.0": 10 };
      const effect = verifyRun(data).effects.find((e) => e.name.startsWith("Worker kills"));
      expect(effect!.ok).toBe(false);
    });
    it("fails when Postgres never really restarted", () => {
      const data = world();
      data.postmasterStarts = ["a", "a"];
      expect(verifyRun(data).vacuous).toBe(true);
    });
    it("fails on an unexpected process exit", () => {
      const data = world();
      data.unexpectedExits = ["worker w1.0 exited with code 1"];
      expect(verifyRun(data).passed).toBe(false);
    });
    it("fails when the drain timed out", () => {
      const data = world();
      data.drainTimedOut = true;
      expect(verifyRun(data).passed).toBe(false);
    });
    it("fails when the client gave up on an event", () => {
      const data = world();
      data.client.push({ kind: "gave_up", t: 500, key: "k1" });
      expect(verifyRun(data).passed).toBe(false);
    });
  });
});

describe("percentiles", () => {
  it("handles no values", () => {
    expect(percentiles([])).toEqual({ count: 0, p50: null, p95: null });
  });
  it("reads p50 and p95 from sorted values", () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentiles(values)).toEqual({ count: 100, p50: 51, p95: 96 });
  });
});
