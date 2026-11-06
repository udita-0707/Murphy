/**
 * Runs both demo scenarios as simultaneous pairs at real speed, on the real stack: the risk phase 4's
 * sequential runs did not cover. Prints each surprise, and exits 1 if there was any.
 *
 *   pnpm --filter @murphy/dashboard exec tsx scripts/pair-reliability.ts --pairs 20
 */
import { MurphyApiClient, startPair } from "@murphy/client";
import { startStack } from "../../../packages/cli/test/stack.js";

const at = process.argv.indexOf("--pairs");
const PAIRS = at >= 0 ? Number(process.argv[at + 1]) : 20;
const SLUGS = ["booking-duplicate-confirmation", "booking-cancel-before-confirm"];

interface Report {
  run: { status: string; reason: string | null; duration_ms: number; started_at: string };
}

const stack = await startStack();
let surprises = 0;
const gaps: number[] = [];
let slowest = 0;
try {
  const api = new MurphyApiClient({ apiUrl: stack.apiUrl, token: stack.apiKey });
  const { data } = await api.request<{ data: { id: string; slug: string }[] }>(
    "GET",
    "/v1/scenarios",
  );
  const finish = async (id: string): Promise<Report> => {
    for (;;) {
      const run = await api.request<{ report_ready: boolean }>("GET", `/v1/runs/${id}`);
      if (run.report_ready) return api.request<Report>("GET", `/v1/runs/${id}/report`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  for (const slug of SLUGS) {
    const scenario = data.find((s) => s.slug === slug);
    if (!scenario) throw new Error(`no scenario ${slug}`);
    let expected = 0;
    for (let i = 0; i < PAIRS; i++) {
      const pair = await startPair(
        api,
        { targetUrl: stack.targetUrl },
        { scenarioId: scenario.id },
      );
      if (pair.naive.outcome !== "started" || pair.idempotent.outcome !== "started") {
        surprises += 1;
        console.log(`${slug} #${i}: did not start`, pair);
        continue;
      }
      const [naive, idempotent] = await Promise.all([
        finish(pair.naive.runId),
        finish(pair.idempotent.runId),
      ]);
      gaps.push(Math.abs(Date.parse(naive.run.started_at) - Date.parse(idempotent.run.started_at)));
      slowest = Math.max(slowest, naive.run.duration_ms, idempotent.run.duration_ms);
      if (naive.run.status === "failed" && idempotent.run.status === "passed") expected += 1;
      else {
        surprises += 1;
        console.log(
          `${slug} #${i}: naive ${naive.run.status} (${naive.run.reason}), idempotent ${idempotent.run.status} (${idempotent.run.reason})`,
        );
      }
    }
    console.log(`${slug}: ${expected} of ${PAIRS} pairs as expected`);
  }
} finally {
  await stack.stop();
}
gaps.sort((a, b) => a - b);
console.log(
  `start gap: median ${gaps[Math.floor(gaps.length / 2)]} ms, largest ${gaps.at(-1)} ms. Slowest run ${slowest} ms. Surprises: ${surprises}.`,
);
process.exit(surprises > 0 ? 1 : 0);
