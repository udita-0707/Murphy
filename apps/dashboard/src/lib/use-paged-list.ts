"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "./api";

export type PagedList<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      rows: T[];
      nextCursor: string | null;
      loadingMore: boolean;
      moreError: string | null;
    };

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "It did not load.");

/** One list from the API, a page at a time. A changed path starts again from the first page. */
export function usePagedList<T>(path: string) {
  const [list, setList] = useState<PagedList<T>>({ state: "loading" });
  const generation = useRef(0);

  const url = useCallback(
    (cursor: string | null) =>
      cursor
        ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`
        : path,
    [path],
  );

  const reload = useCallback(() => {
    const mine = ++generation.current;
    setList({ state: "loading" });
    apiRequest<{ data: T[]; next_cursor?: string | null }>(url(null)).then(
      (page) => {
        if (mine !== generation.current) return;
        setList({
          state: "ready",
          rows: page.data,
          nextCursor: page.next_cursor ?? null,
          loadingMore: false,
          moreError: null,
        });
      },
      (err: unknown) => {
        if (mine === generation.current) setList({ state: "error", message: messageOf(err) });
      },
    );
  }, [url]);

  useEffect(reload, [reload]);

  const loadMore = useCallback(() => {
    if (list.state !== "ready" || !list.nextCursor || list.loadingMore) return;
    const mine = generation.current;
    const cursor = list.nextCursor;
    setList({ ...list, loadingMore: true, moreError: null });
    apiRequest<{ data: T[]; next_cursor?: string | null }>(url(cursor)).then(
      (page) => {
        if (mine !== generation.current) return;
        setList((current) =>
          current.state === "ready"
            ? {
                ...current,
                rows: [...current.rows, ...page.data],
                nextCursor: page.next_cursor ?? null,
                loadingMore: false,
              }
            : current,
        );
      },
      (err: unknown) => {
        if (mine !== generation.current) return;
        setList((current) =>
          current.state === "ready"
            ? { ...current, loadingMore: false, moreError: messageOf(err) }
            : current,
        );
      },
    );
  }, [list, url]);

  return { list, reload, loadMore };
}
