"use client";

import { useEffect, useState } from "react";
import { apiRequest, ApiRequestError } from "./api";
import type { SideState } from "./compare";
import type { LiveRun } from "./types";
import { watchRun } from "./watch";

export interface Watched {
  side: SideState;
  run: LiveRun | null;
}

/** Follows a run. With no id there is nothing to follow, so it stays as `idle` says. */
export function useRunWatch(id: string | null, idle: SideState = { phase: "loading" }): Watched {
  const [watched, setWatched] = useState<Watched>({ side: idle, run: null });
  useEffect(() => {
    if (!id) return;
    return watchRun(id, {
      getRun: (run) => apiRequest<LiveRun>(`/api/v1/runs/${run}`),
      getReport: (run) => apiRequest<unknown>(`/api/v1/runs/${run}/report`),
      cleanup: (run) => apiRequest(`/api/runs/${run}/cleanup`, { method: "POST" }),
      statusOf: (err) => (err instanceof ApiRequestError && err.status > 0 ? err.status : null),
      onChange: (side, run) => setWatched({ side, run }),
    });
  }, [id]);
  return watched;
}
