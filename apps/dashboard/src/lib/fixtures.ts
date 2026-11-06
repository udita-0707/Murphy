import type { LiveRun, RunReport } from "./types";
import duplicateIdempotent from "../../test/fixtures/duplicate-idempotent.json";
import duplicateNaive from "../../test/fixtures/duplicate-naive.json";
import errored from "../../test/fixtures/errored.json";
import liveRunning from "../../test/fixtures/live-running.json";
import reorderIdempotent from "../../test/fixtures/reorder-idempotent.json";
import reorderNaive from "../../test/fixtures/reorder-naive.json";
import retryIdempotent from "../../test/fixtures/retry-idempotent.json";
import retryNaive from "../../test/fixtures/retry-naive.json";

/** Reports from real runs (`scripts/make-fixtures.ts`), for tests and the design preview. */
export const fixtures = {
  duplicateNaive: duplicateNaive as unknown as RunReport,
  duplicateIdempotent: duplicateIdempotent as unknown as RunReport,
  reorderNaive: reorderNaive as unknown as RunReport,
  reorderIdempotent: reorderIdempotent as unknown as RunReport,
  retryNaive: retryNaive as unknown as RunReport,
  retryIdempotent: retryIdempotent as unknown as RunReport,
  errored: errored as unknown as RunReport,
  liveRunning: liveRunning as unknown as LiveRun,
};
