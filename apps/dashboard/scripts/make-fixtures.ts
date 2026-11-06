/**
 * Writes the report fixtures from real runs: real Postgres, API, worker and demo target. Run it again if the
 * report schema changes. Nothing in these files is written by hand.
 *
 *   pnpm --filter @murphy/dashboard exec tsx scripts/make-fixtures.ts
 */
import { MurphyApiClient, prepareDemoTarget, startPair, startRun } from "@murphy/client";
import { writeFileSync } from "node:fs";
import { startStack } from "../../../packages/cli/test/stack.js";

const OUT = new URL("../test/fixtures/", import.meta.url);
const write = (name: string, value: unknown) =>
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify(value, null, 2)}\n`);

const stack = await startStack();
try {
  const api = new MurphyApiClient({ apiUrl: stack.apiUrl, token: stack.apiKey });
  const target = { targetUrl: stack.targetUrl };
  const { data } = await api.request<{ data: { id: string; slug: string }[] }>(
    "GET",
    "/v1/scenarios",
  );
  const scenario = (slug: string) => {
    const found = data.find((s) => s.slug === slug);
    if (!found) throw new Error(`no scenario ${slug}`);
    return found.id;
  };

  const finish = async (id: string) => {
    for (;;) {
      const run = await api.request<{ report_ready: boolean }>("GET", `/v1/runs/${id}`);
      if (run.report_ready) return api.request<unknown>("GET", `/v1/runs/${id}/report`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const pair = async (slug: string, prefix: string) => {
    const started = await startPair(api, target, { scenarioId: scenario(slug) });
    if (started.naive.outcome !== "started" || started.idempotent.outcome !== "started") {
      throw new Error(`${slug} did not start`);
    }
    const naiveId = started.naive.runId;
    // A snapshot from while the run is going, for the live view.
    if (prefix === "duplicate") {
      for (;;) {
        const live = await api.request<{ deliveries: { attempts: unknown[] }[] }>(
          "GET",
          `/v1/runs/${naiveId}`,
        );
        if (live.deliveries.some((d) => d.attempts.length > 0)) {
          write("live-running", live);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    write(`${prefix}-naive`, await finish(naiveId));
    write(`${prefix}-idempotent`, await finish(started.idempotent.runId));
  };

  await pair("booking-duplicate-confirmation", "duplicate");
  await pair("booking-cancel-before-confirm", "reorder");
  await pair("payment-delayed-failure-retry", "retry");

  // A real errored run: the worker cannot read this state URL, so the run proves nothing.
  const endpoint = await prepareDemoTarget(api, target, "naive");
  const errored = await startRun(api, {
    scenarioId: scenario("booking-duplicate-confirmation"),
    endpointId: endpoint.endpointId,
    stateUrl: `${stack.targetUrl}/no-such-state`,
    label: "naive",
  });
  write("errored", await finish(errored.id));
} finally {
  await stack.stop();
}
console.log("fixtures written");
