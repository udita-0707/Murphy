import { runCli, startStack } from "../test/stack.js";

/**
 * Is the demo reliable? Runs the two demo scenarios repeatedly at real speed, through real processes,
 * against both handlers. A demo that works most of the time does not work.
 *
 *   pnpm --filter @murphy/cli reliability [--runs 20]
 */

const SCENARIOS = ["booking-duplicate-confirmation", "booking-cancel-before-confirm"];
const EXPECTED = { naive: 1, idempotent: 0 } as const;

const index = process.argv.indexOf("--runs");
const runs = index === -1 ? 20 : Number(process.argv[index + 1]);

const stack = await startStack();
let bad = 0;
try {
  for (const slug of SCENARIOS) {
    for (const target of ["naive", "idempotent"] as const) {
      let good = 0;
      let slowest = 0;
      for (let i = 1; i <= runs; i++) {
        const started = Date.now();
        const { code, output } = await runCli(stack, [
          "run",
          `packages/simulator/scenarios/${slug}.yaml`,
          "--target",
          target,
        ]);
        slowest = Math.max(slowest, Date.now() - started);
        if (code === EXPECTED[target]) {
          good += 1;
        } else {
          bad += 1;
          console.log(`  run ${i} of ${slug} on ${target}: exit ${code}\n${output}`);
        }
      }
      console.log(
        `${slug} on ${target}: ${good} of ${runs} as expected, slowest ${(slowest / 1000).toFixed(1)} s`,
      );
    }
  }
} finally {
  await stack.stop();
}
process.exit(bad === 0 ? 0 : 1);
