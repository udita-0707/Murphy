"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiRequest, ApiRequestError } from "@/lib/api";
import {
  canReplay,
  formatTime,
  isSimulatedEndpoint,
  lastResult,
  withSimulatedFilter,
  type DeliveryDetail,
  type DeliveryRow,
  type EndpointRow,
  type EventDetail,
  type EventRow,
} from "@/lib/log";
import { usePagedList } from "@/lib/use-paged-list";
import {
  AttemptPips,
  Empty,
  HideSimulated,
  ListRegion,
  LogHead,
  ReplayButton,
  SimulatedTag,
  StateBadge,
  StatusFilter,
} from "./log-parts";
import { CodeBlock, ErrorState, Loading } from "./states";

export function EndpointsView({ hide }: { hide: boolean }) {
  const { list, reload } = usePagedList<EndpointRow>("/api/v1/endpoints");
  const visible =
    list.state === "ready" && hide
      ? { ...list, rows: list.rows.filter((e) => !isSimulatedEndpoint(e)) }
      : list;
  return (
    <section className="section">
      <LogHead title="Endpoints">
        <HideSimulated hide={hide} />
      </LogHead>
      <ListRegion
        list={visible}
        noun="endpoints"
        reload={reload}
        empty={
          <Empty title="No endpoints. Nothing can fail. Yet.">
            <p>Create one with POST /v1/endpoints, or run a scenario, which makes its own.</p>
          </Empty>
        }
      >
        {(rows) => (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">URL</th>
                <th scope="col">Status</th>
                <th scope="col">Receives</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.url}
                    {e.description && <span className="table__sub">{e.description}</span>}
                  </td>
                  <td>
                    <StateBadge status={e.status} />
                  </td>
                  <td>
                    {isSimulatedEndpoint(e) ? (
                      <SimulatedTag simulated />
                    ) : e.event_filter.length === 0 ? (
                      "all events"
                    ) : (
                      e.event_filter.join(", ")
                    )}
                  </td>
                  <td>{formatTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ListRegion>
    </section>
  );
}

export function EventsView({ hide }: { hide: boolean }) {
  const { list, reload, loadMore } = usePagedList<EventRow>(
    withSimulatedFilter("/api/v1/events", hide),
  );
  return (
    <section className="section">
      <LogHead title="Events">
        <HideSimulated hide={hide} />
      </LogHead>
      <ListRegion
        list={list}
        noun="events"
        reload={reload}
        loadMore={loadMore}
        empty={
          <Empty title="Nothing has failed yet. Give it a minute.">
            <Link className="btn" href="/scenarios">
              Run a scenario
            </Link>
          </Empty>
        }
      >
        {(rows) => (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Deliveries</th>
                <th scope="col">Traffic</th>
                <th scope="col">Accepted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link href={`/events/${e.id}`}>{e.type}</Link>
                  </td>
                  <td>{e.deliveries}</td>
                  <td>{e.simulated ? <SimulatedTag simulated /> : "real"}</td>
                  <td>{formatTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ListRegion>
    </section>
  );
}

function DeliveriesTable({
  rows,
  replay,
  onReplayed,
}: {
  rows: DeliveryRow[];
  replay?: boolean;
  onReplayed?: () => void;
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Event</th>
          <th scope="col">Status</th>
          <th scope="col">Attempts</th>
          <th scope="col">Last result</th>
          <th scope="col">Created</th>
          {replay && <th scope="col">Action</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id}>
            <td>
              <Link href={`/deliveries/${d.id}`}>{d.event_type ?? d.id}</Link>
              {d.simulated && (
                <span className="table__sub">
                  <SimulatedTag simulated />
                </span>
              )}
            </td>
            <td>
              <StateBadge status={d.status} />
            </td>
            <td>
              <AttemptPips count={d.attempt_count} />
            </td>
            <td>{lastResult(d)}</td>
            <td>{formatTime(d.created_at)}</td>
            {replay && (
              <td>{canReplay(d.status) && <ReplayButton id={d.id} onDone={onReplayed} />}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DeliveriesView({ hide, status = null }: { hide: boolean; status?: string | null }) {
  const base = status
    ? `/api/v1/deliveries?status=${encodeURIComponent(status)}`
    : "/api/v1/deliveries";
  const { list, reload, loadMore } = usePagedList<DeliveryRow>(withSimulatedFilter(base, hide));
  return (
    <section className="section">
      <LogHead title="Deliveries">
        <HideSimulated hide={hide} />
      </LogHead>
      <StatusFilter status={status} />
      <ListRegion
        list={list}
        noun="deliveries"
        reload={reload}
        loadMore={loadMore}
        empty={<Empty title="Nothing has failed yet. Give it a minute." />}
      >
        {(rows) => <DeliveriesTable rows={rows} />}
      </ListRegion>
    </section>
  );
}

/** The dead-letter queue. Replaying everything shown takes two clicks, and never touches hidden rows. */
export function DlqView({ hide }: { hide: boolean }) {
  const { list, reload, loadMore } = usePagedList<DeliveryRow>(
    withSimulatedFilter("/api/v1/dlq", hide),
  );
  const [confirming, setConfirming] = useState(false);
  const [bulk, setBulk] = useState<{ busy: boolean; result: string | null }>({
    busy: false,
    result: null,
  });
  const shown = list.state === "ready" ? list.rows : [];

  const replayShown = async () => {
    setConfirming(false);
    setBulk({ busy: true, result: null });
    const outcomes = await Promise.allSettled(
      shown.map((d) => apiRequest(`/api/v1/deliveries/${d.id}/replay`, { method: "POST" })),
    );
    const failed = outcomes.filter((o) => o.status === "rejected").length;
    setBulk({
      busy: false,
      result:
        failed === 0
          ? `${outcomes.length} queued.`
          : `${outcomes.length - failed} queued. ${failed} refused, which usually means their endpoint was deleted.`,
    });
    reload();
  };

  return (
    <section className="section">
      <LogHead title="Dead letters">
        <HideSimulated hide={hide} />
      </LogHead>
      {shown.length > 0 && (
        <div className="actions">
          {confirming ? (
            <>
              <button type="button" className="btn btn--primary" onClick={replayShown}>
                Send {shown.length} again
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={bulk.busy}
              aria-busy={bulk.busy}
              onClick={() => setConfirming(true)}
            >
              Replay all shown
            </button>
          )}
        </div>
      )}
      {bulk.result && <p role="status">{bulk.result}</p>}
      <ListRegion
        list={list}
        noun="dead letters"
        reload={reload}
        loadMore={loadMore}
        empty={<Empty title="Nothing dead. Suspicious." />}
      >
        {(rows) => <DeliveriesTable rows={rows} replay />}
      </ListRegion>
    </section>
  );
}

type Loaded<T> =
  | { state: "loading" }
  | { state: "error"; message: string; status: number }
  | { state: "ready"; value: T };

function useOne<T>(path: string) {
  const [load, setLoad] = useState<Loaded<T>>({ state: "loading" });
  const reload = useCallback(() => {
    apiRequest<T>(path).then(
      (value) => setLoad({ state: "ready", value }),
      (err: unknown) =>
        setLoad({
          state: "error",
          message: err instanceof Error ? err.message : "It did not load.",
          status: err instanceof ApiRequestError ? err.status : 0,
        }),
    );
  }, [path]);
  useEffect(reload, [reload]);
  return { load, reload };
}

export function DeliveryView({ id }: { id: string }) {
  const { load, reload } = useOne<DeliveryDetail>(`/api/v1/deliveries/${id}`);
  if (load.state === "loading") return <Loading label="Loading the delivery" rows={4} />;
  if (load.state === "error") {
    return (
      <ErrorState
        title={
          load.status === 404 ? "No such delivery in your project." : "The delivery did not load."
        }
      >
        <p>{load.message}</p>
      </ErrorState>
    );
  }
  const d = load.value;
  return (
    <section className="section">
      <LogHead title={`Delivery ${d.id}`}>
        {canReplay(d.status) && <ReplayButton id={d.id} onDone={reload} />}
      </LogHead>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>
            <StateBadge status={d.status} />
          </dd>
        </div>
        <div>
          <dt>Event</dt>
          <dd>
            <Link href={`/events/${d.event_id}`}>{d.event_id}</Link>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatTime(d.created_at)}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{formatTime(d.completed_at) || "not yet"}</dd>
        </div>
      </dl>
      <h2 className="section__head">Attempts</h2>
      {d.attempts.length === 0 ? (
        <p>No attempts yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Attempt</th>
                <th scope="col">Started</th>
                <th scope="col">Took</th>
                <th scope="col">Reply</th>
                <th scope="col">Error or response</th>
              </tr>
            </thead>
            <tbody>
              {d.attempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.attempt_no}</td>
                  <td>{formatTime(a.started_at)}</td>
                  <td>{a.duration_ms === null ? "" : `${a.duration_ms} ms`}</td>
                  <td>{a.response_status ?? "no reply"}</td>
                  <td>{a.error ?? a.response_body_snippet ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function EventView({ id }: { id: string }) {
  const { load } = useOne<EventDetail>(`/api/v1/events/${id}`);
  if (load.state === "loading") return <Loading label="Loading the event" rows={4} />;
  if (load.state === "error") {
    return (
      <ErrorState
        title={load.status === 404 ? "No such event in your project." : "The event did not load."}
      >
        <p>{load.message}</p>
      </ErrorState>
    );
  }
  const e = load.value;
  return (
    <section className="section">
      <LogHead title={e.type} />
      <dl className="facts">
        <div>
          <dt>Traffic</dt>
          <dd>{e.simulated ? <SimulatedTag simulated /> : "real"}</dd>
        </div>
        <div>
          <dt>Accepted</dt>
          <dd>{formatTime(e.created_at)}</dd>
        </div>
        <div>
          <dt>Idempotency key</dt>
          <dd>{e.idempotency_key}</dd>
        </div>
        {e.scenario_run_id && (
          <div>
            <dt>Run</dt>
            <dd>
              <Link href={`/runs/${e.scenario_run_id}`}>{e.scenario_run_id}</Link>
            </dd>
          </div>
        )}
      </dl>
      <h2 className="section__head">Deliveries</h2>
      {e.deliveries.length === 0 ? (
        <p>This event matched no endpoint.</p>
      ) : (
        <div className="table-wrap">
          <DeliveriesTable rows={e.deliveries} />
        </div>
      )}
      <h2 className="section__head">Payload</h2>
      <CodeBlock label="Event payload" code={JSON.stringify(e.payload, null, 2)} />
    </section>
  );
}
