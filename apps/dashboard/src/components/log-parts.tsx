"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { apiRequest, ApiRequestError } from "@/lib/api";
import type { PagedList } from "@/lib/use-paged-list";
import { Empty, ErrorState, Loading } from "./states";

/** Words and shape for every delivery and endpoint status. Verdict colours stay on verdicts. */
export function StateBadge({ status }: { status: string }) {
  return <span className={`badge lifecycle lifecycle--${status}`}>{status.replace("_", " ")}</span>;
}

export function SimulatedTag({ simulated }: { simulated: boolean | undefined }) {
  return simulated ? <span className="badge badge--muted">simulated</span> : null;
}

/** The filter lives in the URL, so a refresh or a shared link keeps it. */
export function HideSimulated({ hide }: { hide: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toggle = (next: boolean) => {
    const query = new URLSearchParams(params.toString());
    if (next) query.set("hide_simulated", "1");
    else query.delete("hide_simulated");
    const text = query.toString();
    router.replace(text ? `${pathname}?${text}` : pathname);
  };
  return (
    <label className="check">
      <input type="checkbox" checked={hide} onChange={(e) => toggle(e.target.checked)} />
      Hide simulated traffic
    </label>
  );
}

const STATUSES = ["all", "succeeded", "pending", "in_flight", "failed", "dead"];

/** Filter by status, kept in the URL with the rest of the filters. */
export function StatusFilter({ status }: { status: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const choose = (next: string) => {
    const query = new URLSearchParams(params.toString());
    if (next === "all") query.delete("status");
    else query.set("status", next);
    const text = query.toString();
    router.replace(text ? `${pathname}?${text}` : pathname);
  };
  return (
    <div className="tray" role="group" aria-label="Filter by status">
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          className="tray__key"
          aria-pressed={(status ?? "all") === s}
          onClick={() => choose(s)}
        >
          {s.replace("_", " ")}
        </button>
      ))}
    </div>
  );
}

/** How many tries a delivery took, as marks beside the number. */
export function AttemptPips({ count }: { count: number }) {
  return (
    <span className="attempts">
      {count}
      <span className="attempts__pips" aria-hidden="true">
        {Array.from({ length: Math.min(count, 9) }, (_, i) => (
          <span key={i} className="attempts__pip" />
        ))}
      </span>
    </span>
  );
}

export function LogHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="board__head">
      <h1 className="board__title board__heading">{title}</h1>
      {children}
    </header>
  );
}

/** Loading, empty, error and full, for any list. */
export function ListRegion<T>({
  list,
  noun,
  empty,
  reload,
  loadMore,
  children,
}: {
  list: PagedList<T>;
  noun: string;
  empty: ReactNode;
  reload: () => void;
  loadMore?: () => void;
  children: (rows: T[]) => ReactNode;
}) {
  if (list.state === "loading") return <Loading label={`Loading ${noun}`} rows={5} />;
  if (list.state === "error") {
    return (
      <ErrorState title={`The ${noun} did not load.`}>
        <p>{list.message}</p>
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </ErrorState>
    );
  }
  if (list.rows.length === 0) return <>{empty}</>;
  return (
    <>
      <div className="table-wrap">{children(list.rows)}</div>
      {list.moreError && (
        <p className="field__error" role="alert">
          {list.moreError}
        </p>
      )}
      {list.nextCursor && loadMore && (
        <div>
          <button
            type="button"
            className="btn"
            disabled={list.loadingMore}
            aria-busy={list.loadingMore}
            onClick={loadMore}
          >
            {list.loadingMore ? "Loading" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}

export { Empty };

/** Sends the delivery again through the real worker. The API decides whether it may. */
export function ReplayButton({ id, onDone }: { id: string; onDone?: () => void }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const replay = async () => {
    setState("busy");
    setError(null);
    try {
      await apiRequest(`/api/v1/deliveries/${id}/replay`, { method: "POST" });
      setState("done");
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "The replay failed.");
      setState("idle");
    }
  };
  if (state === "done") return <span role="status">Queued</span>;
  return (
    <>
      <button
        type="button"
        className="btn btn--small"
        disabled={state === "busy"}
        aria-busy={state === "busy"}
        onClick={replay}
      >
        Replay
      </button>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
