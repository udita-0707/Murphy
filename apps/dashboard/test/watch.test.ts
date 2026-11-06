import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SideState } from "@/lib/compare";
import { fixtures as f } from "@/lib/fixtures";
import type { LiveRun } from "@/lib/types";
import { watchRun, type WatchDeps } from "@/lib/watch";

const live = f.liveRunning;
const ready: LiveRun = { ...live, report_ready: true };

function setup(over: Partial<WatchDeps> = {}) {
  const states: SideState[] = [];
  const deps: WatchDeps = {
    getRun: vi.fn(async () => live),
    getReport: vi.fn(async () => f.duplicateNaive),
    cleanup: vi.fn(async () => null),
    statusOf: (err) => (err as { status?: number }).status ?? null,
    onChange: (state) => states.push(state),
    ...over,
  };
  return { deps, states, phases: () => states.map((s) => s.phase) };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("watchRun", () => {
  it("polls every second, and only once the last poll has answered", async () => {
    let answer: (run: LiveRun) => void = () => undefined;
    const getRun = vi.fn(() => new Promise<LiveRun>((resolve) => (answer = resolve)));
    const { deps } = setup({ getRun });
    const stop = watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getRun).toHaveBeenCalledTimes(1);
    answer(live);
    await vi.advanceTimersByTimeAsync(999);
    expect(getRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getRun).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ends with the report, stops polling, and only then cleans up", async () => {
    const getRun = vi
      .fn<() => Promise<LiveRun>>()
      .mockResolvedValueOnce(live)
      .mockResolvedValue(ready);
    const { deps, phases } = setup({ getRun });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(phases()).toEqual(["running", "done"]);
    expect(deps.cleanup).toHaveBeenCalledWith("r");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it("a failed poll says lost contact, and recovers without a verdict changing", async () => {
    const getRun = vi
      .fn<() => Promise<LiveRun>>()
      .mockResolvedValueOnce(live)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(live)
      .mockResolvedValue(ready);
    const { deps, states } = setup({ getRun });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(3_001);
    const lost = states.map((s) => (s.phase === "running" ? s.lostContact : s.phase));
    expect(lost).toEqual([false, true, false, "done"]);
  });

  it("a failed report fetch retries instead of inventing a result", async () => {
    const getReport = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(f.duplicateNaive);
    const { deps, phases } = setup({ getRun: vi.fn(async () => ready), getReport });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(phases()).toEqual(["running", "done"]);
  });

  it("says a run is not in this project on a 404, and stops", async () => {
    const getRun = vi.fn(async () => {
      throw Object.assign(new Error("gone"), { status: 404 });
    });
    const { deps, phases } = setup({ getRun });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(phases()).toEqual(["unreadable"]);
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("stops quietly on a 401, and leaves the sign-in redirect to the shell", async () => {
    const getRun = vi.fn(async () => {
      throw Object.assign(new Error("no"), { status: 401 });
    });
    const { deps, states } = setup({ getRun });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(states).toEqual([]);
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("refuses a report version it cannot read, and does not guess", async () => {
    const { deps, phases } = setup({
      getRun: vi.fn(async () => ready),
      getReport: vi.fn(async () => ({ schema_version: 2 })),
    });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(1);
    expect(phases()).toEqual(["unreadable"]);
    expect(deps.cleanup).not.toHaveBeenCalled();
  });

  it("gives up watching after the limit, without a verdict", async () => {
    const { deps, phases } = setup({ limitMs: 3_000 });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(phases().at(-1)).toBe("gave_up");
    const count = (deps.getRun as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((deps.getRun as ReturnType<typeof vi.fn>).mock.calls.length).toBe(count);
  });

  it("does nothing further after it is stopped", async () => {
    const { deps, states } = setup();
    const stop = watchRun("r", deps);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(states).toEqual([]);
  });

  it("a cleanup failure does not change what is shown", async () => {
    const { deps, phases } = setup({
      getRun: vi.fn(async () => ready),
      cleanup: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    watchRun("r", deps);
    await vi.advanceTimersByTimeAsync(1);
    expect(phases()).toEqual(["done"]);
  });
});
