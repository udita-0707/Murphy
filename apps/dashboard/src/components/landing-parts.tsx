"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FAULTS, sideAt } from "@/lib/landing";
import type { RunReport } from "@/lib/types";
import { CompareBoard } from "./compare-board";
import { FaultGlyph } from "./elements";
import { FaultChip } from "./fault-chip";

const TICK_MS = 80;

/** A real recorded run, replayed at real speed. Press the key and it happens again. */
export function ReplayBoard({ naive, idempotent }: { naive: RunReport; idempotent: RunReport }) {
  const latest = Math.max(
    ...naive.timeline.map((t) => t.at_ms),
    ...idempotent.timeline.map((t) => t.at_ms),
  );
  const [atMs, setAtMs] = useState(-1);
  const [running, setRunning] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = undefined;
  }, []);

  const play = useCallback(() => {
    stop();
    const started = Date.now();
    setRunning(true);
    setAtMs(0);
    timer.current = setInterval(() => {
      const now = Date.now() - started;
      setAtMs(now);
      if (now > latest + 500) {
        stop();
        setAtMs(latest + 1);
        setRunning(false);
      }
    }, TICK_MS);
  }, [latest, stop]);

  useEffect(() => {
    // Someone who asked for less motion sees the finished result, and can press to replay.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      const id = window.setTimeout(() => setAtMs(latest + 1), 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(play, 500);
    return () => {
      window.clearTimeout(id);
      stop();
    };
  }, [latest, play, stop]);

  return (
    <div className="screen">
      <CompareBoard
        title={naive.scenario.name}
        provider="A real run, replayed at real speed"
        seed={naive.run.seed}
        naive={sideAt(naive, atMs)}
        idempotent={sideAt(idempotent, atMs)}
        live
      />
      <button
        type="button"
        className="btn btn--primary btn--wide"
        onClick={play}
        aria-busy={running}
        disabled={running}
      >
        {running ? "Breaking it" : "Press to break it again"}
      </button>
    </div>
  );
}

/** The faults as a row of keys. Pressing one shows what it does to the events. */
export function FaultKeyboard() {
  const [chosen, setChosen] = useState(FAULTS[0]!.kind);
  const fault = FAULTS.find((f) => f.kind === chosen) ?? FAULTS[0]!;
  return (
    <div className="keyboard">
      <div className="keyboard__tray" role="group" aria-label="Choose a fault">
        {FAULTS.map((f) => (
          <button
            key={f.kind}
            type="button"
            className="btn fkey"
            aria-pressed={f.kind === chosen}
            onClick={() => setChosen(f.kind)}
          >
            <FaultGlyph kind={f.kind} />
            {f.name}
          </button>
        ))}
      </div>
      <div className="keyboard__panel" aria-live="polite">
        <div className="keyboard__text">
          <FaultChip kind={fault.kind} />
          <p className="keyboard__does">{fault.does}</p>
          <p className="keyboard__breaks">In a handler that was not ready: {fault.breaks}</p>
        </div>
        <ol className="arrivals" aria-label="The events, as they really arrive">
          {fault.arrives.map((event, i) => (
            <li
              key={`${fault.kind}-${i}`}
              className={event.hot ? "arrival arrival--hot" : "arrival"}
            >
              {event.label && <span className="arrival__label">{event.label}</span>}
              {event.note && <span className="arrival__note">{event.note}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** A command that copies itself. */
export function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="copyline">
      <code className="copyline__code">{command}</code>
      <button type="button" className="btn btn--small" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
