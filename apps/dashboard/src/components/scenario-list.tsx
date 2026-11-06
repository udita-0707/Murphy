"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, ApiRequestError } from "@/lib/api";
import { assertionName, faultName } from "@/lib/faults";
import {
  ciSnippet,
  compareUrl,
  distinctFaults,
  filtersActive,
  matchesFilters,
  NO_FILTERS,
  orderScenarios,
  survival,
  whatBreaks,
  type HandlerChoice,
  type PairResponse,
  type RunRow,
  type ScenarioFilters,
  type ScenarioRow,
} from "@/lib/scenarios";
import { MiniTimeline } from "./elements";
import { FaultChip } from "./fault-chip";
import { CheckGlyph, CrossGlyph } from "./glyphs";
import { CopyKey } from "./landing-parts";
import { Empty, ErrorState, Loading } from "./states";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; rows: ScenarioRow[] };

const HANDLERS: { id: HandlerChoice; label: string }[] = [
  { id: "both", label: "Both" },
  { id: "naive", label: "naive" },
  { id: "idempotent", label: "idempotent" },
];

const runLabel = (handler: HandlerChoice) =>
  handler === "both" ? "Run on both handlers" : `Run on ${handler} only`;

/** Starts a run on whichever handlers are chosen, and goes to it. */
function useRun(row: ScenarioRow, handler: HandlerChoice) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (handler === "both") {
        const pair = await apiRequest<PairResponse>("/api/compare", {
          method: "POST",
          body: JSON.stringify({ scenario_id: row.id }),
        });
        router.push(compareUrl(pair));
      } else {
        const started = await apiRequest<{ id: string }>("/api/runs", {
          method: "POST",
          body: JSON.stringify({ scenario_id: row.id, handler }),
        });
        router.push(`/runs/${started.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "The run did not start.");
      setBusy(false);
    }
  }, [handler, row.id, router]);
  return { run, busy, error };
}

function Card({
  row,
  handler,
  onOpen,
}: {
  row: ScenarioRow;
  handler: HandlerChoice;
  onOpen: (row: ScenarioRow) => void;
}) {
  const { run, busy, error } = useRun(row, handler);
  return (
    <li
      className="scenario"
      tabIndex={0}
      data-scenario-id={row.id}
      onClick={() => onOpen(row)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") onOpen(row);
        if ((event.key === "r" || event.key === "R") && !busy) {
          event.preventDefault();
          void run();
        }
      }}
    >
      <h2 className="scenario__name">{row.name}</h2>
      <p className="scenario__breaks">{whatBreaks(row)}</p>
      {row.detail && <MiniTimeline steps={row.detail.steps} />}
      <div className="scenario__chips">
        {distinctFaults(row).map((kind) => (
          <FaultChip key={kind} kind={kind} />
        ))}
        {row.summary && <span className="badge badge--muted">{row.summary.provider_label}</span>}
        <span className={`badge level level--${row.difficulty}`}>{row.difficulty}</span>
        {row.summary?.needs_target_cooperation && (
          <span className="badge badge--needs">needs your target</span>
        )}
      </div>
      <div className="scenario__foot">
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          aria-busy={busy}
          aria-label={runLabel(handler)}
          onClick={(event) => {
            event.stopPropagation();
            void run();
          }}
        >
          {busy ? "Starting" : "Run"}
        </button>
      </div>
    </li>
  );
}

function Drawer({
  row,
  handler,
  onClose,
}: {
  row: ScenarioRow | null;
  handler: HandlerChoice;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (row && !element.open) element.showModal();
    if (!row && element.open) element.close();
  }, [row]);
  return (
    <dialog
      ref={dialog}
      className="drawer"
      aria-label={row ? `About ${row.name}` : "About this scenario"}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {row && <DrawerBody key={row.id} row={row} handler={handler} onClose={onClose} />}
    </dialog>
  );
}

function DrawerBody({
  row,
  handler,
  onClose,
}: {
  row: ScenarioRow;
  handler: HandlerChoice;
  onClose: () => void;
}) {
  const { run, busy, error } = useRun(row, handler);
  return (
    <div className="drawer__body">
      <header className="drawer__head">
        <h2 className="section__head">{row.name}</h2>
        <button type="button" className="btn btn--small" onClick={onClose}>
          Close
        </button>
      </header>
      {row.summary?.description && <p>{row.summary.description}</p>}
      <dl className="facts">
        <div>
          <dt>Seed</dt>
          <dd>{row.detail?.seed ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{row.summary?.provider_label ?? "unknown"}</dd>
        </div>
      </dl>

      <h3 className="drawer__label">Steps, in the order they are sent</h3>
      <ol className="drawer__steps">
        {row.detail?.steps.map((step) => (
          <li key={step.id}>
            <span className="drawer__event">{step.event_type}</span>
            {step.faults.map((kind) => (
              <span key={kind} className="drawer__fault">
                {faultName(kind)}
              </span>
            ))}
          </li>
        ))}
      </ol>

      <h3 className="drawer__label">Assertions</h3>
      <ul className="plain-list">
        {row.detail?.assertions.map((assertion) => (
          <li key={`${assertion.kind}-${assertion.entity}`}>
            {assertionName(assertion.kind)} ({assertion.entity})
          </li>
        ))}
      </ul>

      <div className="drawer__ci">
        <h3 className="drawer__label">In CI</h3>
        <CopyKey text={ciSnippet(row)} label="Copy CI snippet" />
      </div>
      <pre className="code" tabIndex={0} aria-label="CI snippet">
        <code>{ciSnippet(row)}</code>
      </pre>

      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn btn--primary btn--wide"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void run()}
      >
        {busy ? "Starting" : runLabel(handler)}
      </button>
    </div>
  );
}

/** One choice from a few, as a tray of keys. */
function Tray<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="filter">
      <span className="filter__label">{label}</span>
      <div className="tray" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="tray__key"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const SURVIVAL_WORDS = {
  survived: "survived",
  failed: "failed",
  errored: "errored, proves nothing",
  running: "still running",
  not_run: "not run yet",
};

function Survival({
  scenarios,
  runs,
  handler,
}: {
  scenarios: ScenarioRow[];
  runs: RunRow[] | null;
  handler: HandlerChoice;
}) {
  if (!runs) return null;
  const cells = survival(scenarios, runs, handler);
  const survived = cells.filter((c) => c.state === "survived").length;
  const who = handler === "naive" ? "naive" : "idempotent";
  return (
    <section className="survival" aria-label="Survival by scenario">
      <p className="survival__count">
        Survived {survived}/{cells.length}
        <span className="survival__who">{who}, latest run of each</span>
      </p>
      <ul className="survival__grid">
        {cells.map(({ row, state }) => (
          <li
            key={row.id}
            className={`survival__cell survival__cell--${state}`}
            title={`${row.name}: ${SURVIVAL_WORDS[state]}`}
          >
            {state === "survived" && <CheckGlyph />}
            {state === "failed" && <CrossGlyph />}
            <span className="visually-hidden">
              {row.name}: {SURVIVAL_WORDS[state]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FAULT_LABELS = (kinds: string[]) => [
  { id: "all", label: "All" },
  ...kinds.map((kind) => ({ id: kind, label: faultName(kind) })),
];

export function ScenarioList() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [handler, setHandler] = useState<HandlerChoice>("both");
  const [filters, setFilters] = useState<ScenarioFilters>(NO_FILTERS);
  const [open, setOpen] = useState<ScenarioRow | null>(null);
  const search = useRef<HTMLInputElement>(null);

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
    // The grid is a bonus: if past results cannot load, the list still works without it.
    apiRequest<{ data: RunRow[] }>("/api/v1/runs?limit=200").then(
      ({ data }) => setRuns(data),
      () => setRuns(null),
    );
  }, []);
  useEffect(fetchRows, [fetchRows]);

  // "/" jumps to search, unless someone is already typing or a drawer is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || document.querySelector("dialog[open]")) {
        return;
      }
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = useMemo(() => (load.state === "ready" ? load.rows : []), [load]);
  const faultKinds = useMemo(() => [...new Set(rows.flatMap(distinctFaults))].sort(), [rows]);
  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) {
      if (row.summary) seen.set(row.summary.provider, row.summary.provider_label);
    }
    return [...seen].map(([id, label]) => ({ id, label }));
  }, [rows]);

  const set = <K extends keyof ScenarioFilters>(key: K, value: ScenarioFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const active = filtersActive(filters);
  const pinned = active ? [] : rows.filter((row) => row.difficulty === "beginner");
  const grid = active
    ? rows.filter((row) => matchesFilters(row, filters))
    : rows.filter((row) => row.difficulty !== "beginner");

  return (
    <section className="section">
      <header className="board__head">
        <h1 className="section__head board__heading">Pick something to break</h1>
        <div className="filter">
          <span className="filter__label">Every Run key uses</span>
          <div className="tray" role="group" aria-label="Handler for every Run key">
            {HANDLERS.map((option) => (
              <button
                key={option.id}
                type="button"
                className="tray__key"
                aria-pressed={handler === option.id}
                onClick={() => setHandler(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
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
      {load.state === "ready" && rows.length === 0 && (
        <Empty title="Nothing to break. Suspicious.">
          <p>
            Built-in scenarios load when the API starts. Restart it after `pnpm demo:reset`, or add
            your own with `pnpm -s murphy run`.
          </p>
        </Empty>
      )}

      {load.state === "ready" && rows.length > 0 && (
        <>
          <Survival scenarios={rows} runs={runs} handler={handler} />

          <div className="filters">
            <label className="filter filter--search">
              <span className="filter__label">Search (press /)</span>
              <input
                ref={search}
                className="input"
                type="search"
                placeholder="double booking, refund, UPI"
                value={filters.search}
                onChange={(event) => set("search", event.target.value)}
              />
            </label>
            <Tray
              label="Provider"
              value={filters.provider}
              options={[{ id: "all", label: "All" }, ...providers]}
              onChange={(next) => set("provider", next)}
            />
            <Tray
              label="Fault"
              value={filters.fault}
              options={FAULT_LABELS(faultKinds)}
              onChange={(next) => set("fault", next)}
            />
            <Tray
              label="Difficulty"
              value={filters.difficulty}
              options={[
                { id: "all", label: "All" },
                { id: "beginner", label: "Beginner" },
                { id: "intermediate", label: "Intermediate" },
                { id: "advanced", label: "Advanced" },
              ]}
              onChange={(next) => set("difficulty", next)}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={filters.noTargetNeeded}
                onChange={(event) => set("noTargetNeeded", event.target.checked)}
              />
              No target needed
            </label>
            {active && (
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setFilters(NO_FILTERS)}
              >
                Clear
              </button>
            )}
          </div>

          {pinned.length > 0 && (
            <>
              <h2 className="grid__head">Start here</h2>
              <ul className="scenarios scenarios--pinned">
                {pinned.map((row) => (
                  <Card key={row.id} row={row} handler={handler} onOpen={setOpen} />
                ))}
              </ul>
              <h2 className="grid__head">Everything else</h2>
            </>
          )}

          {grid.length === 0 ? (
            <Empty title="Nothing matches. Suspicious.">
              <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>
                Clear the filters
              </button>
            </Empty>
          ) : (
            <ul className="scenarios">
              {grid.map((row) => (
                <Card key={row.id} row={row} handler={handler} onOpen={setOpen} />
              ))}
            </ul>
          )}
          <p className="board__meta">
            Keys: / searches. Tab to a card, then R runs it and Enter opens it.
          </p>
        </>
      )}

      <Drawer row={open} handler={handler} onClose={() => setOpen(null)} />
    </section>
  );
}
