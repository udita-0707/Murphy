import { generateSigningSecret, signHeaders } from "@murphy/core";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoTarget, type DemoTarget } from "../src/app.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function start(target: DemoTarget = createDemoTarget()): Promise<string> {
  await new Promise<void>((resolve) => {
    server = target.app.listen(0, "127.0.0.1", () => resolve());
  });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const body = JSON.stringify({
  id: "evt_1",
  type: "reservation.confirmed",
  data: { reservation: { id: "res_1", total_minor: 100 } },
  _murphy: {
    simulated: true,
    version: 1,
    run_id: "r1",
    scenario: "s",
    step: "confirmed",
    event: "reservation.confirmed",
    entity_id: "res_1",
  },
});

function post(url: string, secret: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      ...signHeaders({
        id: "msg_1",
        timestamp: Math.floor(Date.now() / 1000),
        body,
        secrets: [secret],
      }),
      "webhook-event-type": "reservation.confirmed",
    },
    body,
  });
}

describe("demo target", () => {
  it("the same duplicate books twice on naive and once on idempotent", async () => {
    const secret = generateSigningSecret();
    const url = await start(createDemoTarget({ secrets: [secret] }));
    for (const handler of ["naive", "idempotent"]) {
      expect((await post(`${url}/${handler}`, secret)).status).toBe(200);
      expect((await post(`${url}/${handler}`, secret)).status).toBe(200);
    }
    const booking = async (handler: string) => {
      const res = await fetch(`${url}/${handler}/state?run_id=r1`);
      const state = (await res.json()) as {
        entities: Record<string, { effects: { booking: number } }>;
      };
      return state.entities.res_1!.effects.booking;
    };
    expect(await booking("naive")).toBe(2);
    expect(await booking("idempotent")).toBe(1);
  });

  it("verifies signatures, with secrets added at runtime", async () => {
    const url = await start();
    const secret = generateSigningSecret();
    expect((await post(`${url}/naive`, secret)).status).toBe(401);
    const added = await fetch(`${url}/_secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    expect(added.status).toBe(204);
    expect((await post(`${url}/naive`, secret)).status).toBe(200);
  });

  it("refuses something that is not a secret", async () => {
    const url = await start();
    const res = await fetch(`${url}/_secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "password" }),
    });
    expect(res.status).toBe(400);
  });

  it("records arrivals itself", async () => {
    const secret = generateSigningSecret();
    const target = createDemoTarget({ secrets: [secret] });
    const url = await start(target);
    await post(`${url}/naive`, secret);
    expect(target.arrivals).toMatchObject([
      { handler: "naive", webhookId: "msg_1", runId: "r1", step: "confirmed", arrival: 1 },
    ]);
  });
});
