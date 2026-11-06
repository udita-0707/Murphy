"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiRequest, ApiRequestError } from "@/lib/api";
import {
  compareUrl,
  cooperationNote,
  DEMO_PICKS,
  distinctFaults,
  orderScenarios,
  type PairResponse,
  type ScenarioRow,
} from "@/lib/scenarios";
import { DifficultyPips } from "./elements";
import { FaultChip } from "./fault-chip";
import { Empty, ErrorState, Loading } from "./states";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: ScenarioRow[] };

function Row({ row, primary }: { row: ScenarioRow; primary: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (what: string, run: () => Promise<string>) => {
    setBusy(what);
    setError(null);
    try {
      router.push(await run());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "The run did not start.");
      setBusy(null);
    }
  };

  const both = () =>
    start("both", async () => {
      const pair = await apiRequest<PairResponse>("/api/compare", {
        method: "POST",
        body: JSON.stringify({ scenario_id: row.id }),
      });
      return compareUrl(pair);
    });
  const one = (handler: "naive" | "idempotent") =>
    start(handler, async () => {
      const run = await apiRequest<{ id: string }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ scenario_id: row.id, handler }),
      });
      return `/runs/${run.id}`;
    });

  const disabled = busy !== null;
  return (
    <li className={primary ? "scenario scenario--lead" : "scenario"}>
      <div className="scenario__main">
        <div className="scenario__top">
          <h2 className="scenario__name">{row.name}</h2>
          <DifficultyPips level={row.difficulty} />
        </div>
        <p className="scenario__meta">
          {[
            row.summary?.provider_label,
            row.difficulty,
            row.builtin ? "built-in" : "this project",
            DEMO_PICKS.includes(row.slug) ? "repeated at real speed" : null,
          ]
            .filter(Boolean)
            .join(". ")}
        </p>
        <div className="scenario__faults">
          {distinctFaults(row).map((kind) => (
            <FaultChip key={kind} kind={kind} />
          ))}
        </div>
        <p className="scenario__note">{cooperationNote(row)}</p>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="scenario__actions">
        <button
          type="button"
          className={primary ? "btn btn--primary" : "btn"}
          disabled={disabled}
          aria-busy={busy === "both"}
          onClick={both}
        >
          {busy === "both" ? "Starting both" : "Run on both handlers"}
        </button>
        <div className="scenario__single" role="group" aria-label="Run on one handler">
          {(["naive", "idempotent"] as const).map((handler) => (
            <button
              type="button"
              className="btn btn--small"
              key={handler}
              disabled={disabled}
              aria-busy={busy === handler}
              aria-label={`Run on ${handler} only`}
              onClick={() => one(handler)}
            >
              {handler}
            </button>
          ))}
        </div>
      </div>
    </li>
  );
}

const PROVIDERS = [
  { id: "all", label: "All" },
  { id: "booking", label: "Booking" },
  { id: "payments", label: "Payments" },
  { id: "upi", label: "UPI" },
];

export function ScenarioList() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [provider, setProvider] = useState("all");

  const fetchRows = useCallback(() => {
    setLoad({ state: "loading" });
    apiRequest<{ data: ScenarioRow[] }>("/api/v1/scenarios").then(
      ({ data }) => setLoad({ state: "ready", rows: orderScenarios(data) }),
      (err: unknown) =>
        setLoad({
          state: "error",
          message: err instanceof Error ? err.message : "The list did not load.",
        }),
    );
  }, []);
  useEffect(fetchRows, [fetchRows]);

  return (
    <section className="section">
      <header className="board__head">
        <h1 className="section__head board__heading">Pick something to break</h1>
        {load.state === "ready" && load.rows.length > 0 && (
          <div className="tray" role="group" aria-label="Filter by provider">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="tray__key"
                aria-pressed={provider === p.id}
                onClick={() => setProvider(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </header>
      {load.state === "loading" && <Loading label="Loading scenarios" rows={4} />}
      {load.state === "error" && (
        <ErrorState title="The scenarios did not load.">
          <p>{load.message}</p>
          <button type="button" className="btn" onClick={fetchRows}>
            Try again
          </button>
        </ErrorState>
      )}
      {load.state === "ready" && load.rows.length === 0 && (
        <Empty title="Nothing to break. Suspicious.">
          <p>
            Built-in scenarios load when the API starts. Restart it after `pnpm demo:reset`, or add
            your own with `pnpm -s murphy run`.
          </p>
        </Empty>
      )}
      {load.state === "ready" && load.rows.length > 0 && (
        <ul className="scenarios">
          {load.rows
            .filter((row) => provider === "all" || row.summary?.provider === provider)
            .map((row) => (
              <Row key={row.id} row={row} primary={row.id === load.rows[0]?.id} />
            ))}
        </ul>
      )}
    </section>
  );
}
