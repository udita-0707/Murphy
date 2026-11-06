import { generateSigningSecret, signHeaders } from "@murphy/core";
import { murphyTarget, type EntityState } from "@murphy/sdk";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli, startStack, type Stack } from "./stack.js";

const scenario = (slug: string) => `packages/simulator/scenarios/${slug}.yaml`;

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

/**
 * The definition of done for phase 4: real API, worker and demo target processes, real Postgres,
 * real retry schedule, and `murphy` as a real process.
 */
describe("murphy run, end to end", () => {
  describe.each(["booking-duplicate-confirmation", "booking-cancel-before-confirm"])(
    "%s",
    (slug) => {
      it("FAILS on the naive handler, with exit code 1", async () => {
        const { code, output } = await runCli(stack, ["run", scenario(slug), "--target", "naive"]);
        expect(output).toMatch(/^FAIL {2}/m);
        expect(code, output).toBe(1);
        expect(output).toMatch(/reservation\.created/);
        expect(output).toMatch(/\(real engine\)/);
      });

      it("PASSES on the idempotent handler, with exit code 0", async () => {
        const { code, output } = await runCli(stack, [
          "run",
          scenario(slug),
          "--target",
          "idempotent",
        ]);
        expect(output).toMatch(/^PASS {2}/m);
        expect(code, output).toBe(0);
      });
    },
  );

  it("saves a readable report, and removes the endpoint only after the report is stored", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "murphy-report-"));
    const out = path.join(dir, "report.md");
    try {
      const { code, output } = await runCli(stack, [
        "run",
        scenario("booking-cancel-before-confirm"),
        "--target",
        "naive",
        "--report",
        out,
      ]);
      expect(code, output).toBe(1);
      const text = readFileSync(out, "utf8");
      expect(text).toMatch(/^# FAILED: Cancel event arrives before the confirmation/);
      expect(text).toMatch(/\| Handler \| naive \|/);
      expect(text).toMatch(/\| cancelled \| reorder \| Engine \|/);
      expect(text).toMatch(/Ended in "confirmed", expected "cancelled"/);
      expect(text).toMatch(/## What this does not prove/);

      const runId = /^run\s+(\S+)/m.exec(output)![1]!;
      const run = await stack.prisma.scenarioRun.findUniqueOrThrow({
        where: { id: runId },
        include: { endpoint: true },
      });
      expect(run.report).not.toBeNull();
      expect(run.endpoint.deletedAt).not.toBeNull();
      expect(run.finishedAt!.getTime()).toBeLessThanOrEqual(run.endpoint.deletedAt!.getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same seed sends the same payloads on a new run", async () => {
    const payloads = async () => {
      const { output } = await runCli(stack, [
        "run",
        scenario("booking-duplicate-confirmation"),
        "--target",
        "idempotent",
        "--seed",
        "99",
      ]);
      const runId = /^run\s+(\S+)/m.exec(output)![1]!;
      const events = await stack.prisma.event.findMany({
        where: { scenarioRunId: runId },
        orderBy: { type: "asc" },
      });
      return events.map((e) => {
        const { _murphy, ...provider } = e.payload as Record<string, unknown>;
        expect((_murphy as { simulated: boolean }).simulated).toBe(true);
        return provider;
      });
    };
    expect(await payloads()).toEqual(await payloads());
  });

  it("explains a missing scenario file, with exit code 3", async () => {
    const { code, output } = await runCli(stack, [
      "run",
      "packages/cli/test/does-not-exist.yaml",
      "--target",
      "naive",
    ]);
    expect(code).toBe(3);
    expect(output).toMatch(/cannot read/);
  });

  it("explains a demo target that is not running, and leaves no endpoint behind", async () => {
    const before = await stack.prisma.endpoint.count({ where: { deletedAt: null } });
    const { code, output } = await runCli(
      stack,
      ["run", scenario("booking-duplicate-confirmation"), "--target", "naive"],
      { MURPHY_TARGET_URL: "http://127.0.0.1:9" },
    );
    expect(code).toBe(3);
    expect(output).toMatch(/pnpm demo:target/);
    expect(await stack.prisma.endpoint.count({ where: { deletedAt: null } })).toBe(before);
  });

  it("explains a wrong API key, with exit code 3", async () => {
    const { code, output } = await runCli(
      stack,
      ["run", scenario("booking-duplicate-confirmation"), "--target", "naive"],
      { MURPHY_API_KEY: "mk_wrong" },
    );
    expect(code).toBe(3);
    expect(output).toMatch(/401/);
    expect(output).not.toMatch(/mk_wrong/);
  });

  it("the API installs the built-in library at startup, and a run can use it directly", async () => {
    const headers = {
      authorization: `Bearer ${stack.apiKey}`,
      "content-type": "application/json",
    };
    const listed = await fetch(`${stack.apiUrl}/v1/scenarios`, { headers });
    const { data } = (await listed.json()) as {
      data: { id: string; slug: string; builtin: boolean }[];
    };
    const builtins = data.filter((s) => s.builtin);
    expect(builtins).toHaveLength(8);

    const created = await fetch(`${stack.apiUrl}/v1/endpoints`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: `${stack.targetUrl}/idempotent` }),
    });
    const endpoint = (await created.json()) as { id: string };
    const started = await fetch(`${stack.apiUrl}/v1/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        scenario_id: builtins.find((s) => s.slug === "payment-duplicate-captured")!.id,
        endpoint_id: endpoint.id,
        state_url: `${stack.targetUrl}/idempotent/state`,
      }),
    });
    expect(started.status).toBe(202);
    await fetch(`${stack.apiUrl}/v1/endpoints/${endpoint.id}`, { method: "DELETE", headers });
  });

  describe("your own handler, as the README shows it", () => {
    /** A small handler of the reader's own, mounted with murphyTarget(). */
    async function ownHandler(dedupe: boolean) {
      const created = await fetch(`${stack.apiUrl}/v1/endpoints`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${stack.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "http://127.0.0.1:1/replaced-below",
          event_filter: ["__murphy_simulation__"],
        }),
      });
      const endpoint = (await created.json()) as { id: string; secret: string };

      const seen = new Set<string>();
      const entities: Record<string, EntityState> = {};
      const app = express();
      app.use(
        "/webhooks/murphy",
        murphyTarget({
          secret: endpoint.secret,
          onEvent(event) {
            if (dedupe && seen.has(event.webhookId)) return;
            seen.add(event.webhookId);
            const id = event.murphy!.entity_id;
            const booking = entities[id]?.effects.booking ?? 0;
            entities[id] = {
              state: event.type.replace("reservation.", ""),
              effects: { booking: event.type === "reservation.confirmed" ? booking + 1 : booking },
              balance_minor: 0,
            };
          },
          state: () => ({ entities }),
        }),
      );
      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/murphy`;
      const patched = await fetch(`${stack.apiUrl}/v1/endpoints/${endpoint.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${stack.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: base }),
      });
      expect(patched.status).toBe(200);
      return { id: endpoint.id, base, server };
    }

    const run = (own: { id: string; base: string }) =>
      runCli(stack, [
        "run",
        scenario("booking-duplicate-confirmation"),
        "--endpoint",
        own.id,
        "--state-url",
        `${own.base}/state`,
        "--label",
        "my-app",
      ]);

    it("a handler that dedupes passes, and its endpoint is left alone", async () => {
      const own = await ownHandler(true);
      try {
        const { code, output } = await run(own);
        expect(code, output).toBe(0);
        expect(output).toMatch(/against my-app/);
        const row = await stack.prisma.endpoint.findUniqueOrThrow({ where: { id: own.id } });
        expect(row.deletedAt).toBeNull();
      } finally {
        await new Promise((resolve) => own.server.close(resolve));
      }
    });

    it("a handler that does not dedupe fails", async () => {
      const own = await ownHandler(false);
      try {
        const { code, output } = await run(own);
        expect(code, output).toBe(1);
        expect(output).toMatch(/Holds 2 bookings, expected 1/);
      } finally {
        await new Promise((resolve) => own.server.close(resolve));
      }
    });

    it("a response fault works through murphyTarget(), on a handler it does not know", async () => {
      const own = await ownHandler(true);
      try {
        const { code, output } = await runCli(stack, [
          "run",
          scenario("booking-cancel-after-payment"),
          "--endpoint",
          own.id,
          "--state-url",
          `${own.base}/state`,
        ]);
        // This small handler does not track refunds, so it should fail on the result...
        expect(code, output).toBe(1);
        // ...but the fault itself must have happened through the helper, not been skipped.
        expect(output).toMatch(/drop_then_redeliver on refunded: happened \(target cooperated\)/);
      } finally {
        await new Promise((resolve) => own.server.close(resolve));
      }
    });
  });

  it("the demo target itself refuses an unsigned webhook", async () => {
    const res = await fetch(`${stack.targetUrl}/naive`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const signed = signHeaders({
      id: "msg_1",
      timestamp: Math.floor(Date.now() / 1000),
      body: "{}",
      secrets: [generateSigningSecret()],
    });
    const wrong = await fetch(`${stack.targetUrl}/naive`, {
      method: "POST",
      headers: signed,
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });
});
