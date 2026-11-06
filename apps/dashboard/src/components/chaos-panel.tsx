"use client";

import { useEffect, useRef, useState } from "react";
import { apiRequest, ApiRequestError } from "@/lib/api";
import {
  deliveryNote,
  MAX_FAIL_SECONDS,
  parseSeconds,
  proofLine,
  refusedLine,
  workerLine,
  type ChaosStatus,
} from "@/lib/chaos";
import { formatTime, lastResult, type DeliveryRow } from "@/lib/log";
import { StateBadge } from "./log-parts";
import { ErrorState, Loading } from "./states";

const POLL_MS = 1_000;

/** Polls one request at a time. A failure is reported and the polling carries on. */
function usePoll<T>(path: string) {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await apiRequest<T>(path);
        if (stopped) return;
        setValue(next);
        setFailed(null);
      } catch (err) {
        if (stopped) return;
        setFailed(err instanceof Error ? err.message : "It did not answer.");
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [path]);
  return { value, failed };
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: "lost" }) {
  return (
    <div className={tone ? `counter counter--${tone}` : "counter"}>
      <span className="counter__value">{value}</span>
      <span className="counter__label">{label}</span>
    </div>
  );
}

export function ChaosPanel() {
  const status = usePoll<ChaosStatus>("/api/chaos/status");
  const deliveries = usePoll<{ data: DeliveryRow[] }>("/api/v1/deliveries?limit=8");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState("15");
  const firstSeen = useRef(new Map<string, number>());

  const act = async (name: string, body?: object) => {
    setBusy(name);
    setError(null);
    try {
      await apiRequest(`/api/chaos/${name}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "That action failed.");
    } finally {
      setBusy(null);
    }
  };

  if (!status.value && status.failed) {
    return (
      <ErrorState title="The control service did not answer.">
        <p>{status.failed}</p>
        <p>Start everything with pnpm demo:stack.</p>
      </ErrorState>
    );
  }
  if (!status.value) return <Loading label="Connecting to the control service" rows={4} />;

  const { workers, target, traffic, postgres_restarting: restarting, log } = status.value;
  const proof = proofLine(traffic);
  const running = traffic?.state === "running";
  const parsedSeconds = parseSeconds(seconds);
  const now = Date.now();
  for (const d of deliveries.value?.data ?? []) {
    if (d.status === "in_flight") {
      if (!firstSeen.current.has(d.id)) firstSeen.current.set(d.id, now);
    } else {
      firstSeen.current.delete(d.id);
    }
  }

  return (
    <section className="section">
      <header className="board__head">
        <div className="board__heading">
          <h1 className="board__title">Break it on purpose</h1>
          <p className="board__meta">
            Retries are shortened on this machine so recovery fits on a stage. Production retries
            start at 5 s, then 30 s.
          </p>
        </div>
        <button
          type="button"
          className={running ? "btn" : "btn btn--primary"}
          disabled={busy !== null}
          aria-busy={busy === "traffic-start" || busy === "traffic-stop"}
          onClick={() => void act(running ? "traffic-stop" : "traffic-start")}
        >
          {running ? "Stop traffic" : "Start traffic"}
        </button>
      </header>

      <div className="counters" data-testid="counters">
        <Counter label="Accepted" value={traffic?.accepted ?? 0} />
        <Counter label="Delivered" value={traffic?.delivered ?? 0} />
        <Counter label="Retrying" value={traffic?.retrying ?? 0} />
        <Counter label="Dead letters" value={traffic?.dead ?? 0} />
        <Counter label="Lost" value={traffic?.lost ?? 0} tone="lost" />
      </div>
      <p className={`proof proof--${proof.tone}`} data-testid="proof" role="status">
        {proof.text}
      </p>
      {traffic && traffic.refused > 0 && (
        <p className="board__meta">{refusedLine(traffic.refused)}</p>
      )}

      {traffic && traffic.accepted > 0 && (
        <div className="flow" aria-hidden="true">
          {(
            [
              ["delivered", traffic.delivered],
              ["retrying", traffic.retrying],
              ["dead", traffic.dead],
              ["lost", traffic.lost],
            ] as const
          ).map(([name, value]) => (
            <span
              key={name}
              className={`flow__part flow__part--${name}`}
              style={{ flexGrow: value }}
            />
          ))}
        </div>
      )}

      <div className="chaos">
        <button
          type="button"
          className="btn btn--big btn--danger"
          disabled={busy !== null || workers.every((w) => w.state !== "running")}
          onClick={() => void act("kill-worker")}
        >
          Kill a worker
        </button>
        <button
          type="button"
          className="btn btn--big btn--danger"
          disabled={busy !== null || restarting}
          aria-busy={restarting}
          onClick={() => void act("restart-postgres")}
        >
          {restarting ? "Postgres restarting" : "Restart Postgres"}
        </button>
        <div className="chaos__fail">
          <label className="field">
            <span className="field__label">Seconds, up to {MAX_FAIL_SECONDS}</span>
            <input
              className="input chaos__seconds"
              inputMode="numeric"
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
              aria-invalid={parsedSeconds === null}
            />
          </label>
          <button
            type="button"
            className="btn btn--big btn--danger"
            disabled={busy !== null || parsedSeconds === null}
            onClick={() => void act("target-fail", { seconds: parsedSeconds })}
          >
            Target answers 500
          </button>
        </div>
      </div>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      <div className="cards">
        <div className="card">
          <h2 className="card__head">Processes</h2>
          <ul className="plain-list">
            {workers.map((w) => (
              <li key={w.name} className="light-row">
                <span className={`light light--${w.state}`} aria-hidden="true" />
                <span className={w.state === "crashed" ? "field__error" : undefined}>
                  {workerLine(w)}
                </span>
              </li>
            ))}
            <li className="light-row">
              <span
                className={`light light--${restarting ? "restarting" : "running"}`}
                aria-hidden="true"
              />
              Postgres: {restarting ? "restarting" : "not being restarted"}
            </li>
            <li className="light-row">
              <span
                className={`light light--${!target ? "crashed" : target.failing ? "restarting" : "running"}`}
                aria-hidden="true"
              />
              Demo target:{" "}
              {!target
                ? "not answering"
                : target.failing
                  ? "answering 500 on purpose"
                  : `healthy, ${target.received} distinct events received`}
            </li>
          </ul>
        </div>
        <div className="card">
          <h2 className="card__head">What you did</h2>
          {log.length === 0 ? (
            <p className="card__body">Nothing has gone wrong yet. Give it a minute.</p>
          ) : (
            <ul className="plain-list">
              {log.slice(0, 5).map((entry) => (
                <li key={`${entry.at}-${entry.action}-${entry.outcome}`}>
                  {entry.at.slice(11, 19)} {entry.action}: {entry.outcome}
                  {entry.detail ? `, ${entry.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h2 className="section__head">Latest deliveries</h2>
      {deliveries.failed && (
        <p className="board__meta" role="status">
          The API is reconnecting, so this list is paused. {deliveries.failed}
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last result</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {(deliveries.value?.data ?? []).map((d) => {
              const note = deliveryNote(d.status, firstSeen.current.get(d.id), now);
              return (
                <tr key={d.id}>
                  <td>{d.event_type ?? d.id}</td>
                  <td>
                    <StateBadge status={d.status} />
                    {note && <span className="table__sub">{note}</span>}
                  </td>
                  <td>{d.attempt_count}</td>
                  <td>{lastResult(d)}</td>
                  <td>{formatTime(d.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
