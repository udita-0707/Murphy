"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { alignSides } from "@/lib/board";
import { compareSides } from "@/lib/compare";
import { FAULTS, lastAttemptAt, sideAt, tickToward } from "@/lib/landing";
import type { RunReport } from "@/lib/types";
import { AttemptsTable, ComparisonRow, inputOf, SidePlate } from "./compare-board";
import { FaultGlyph, SwimLanes } from "./elements";
import { FaultChip } from "./fault-chip";

const TICK_MS = 60;
/** After the last dot: the stamp lands, then each count ticks up, then it rests before looping. */
const STAMP_AFTER_MS = 350;
const COUNT_AFTER_MS = 500;
const COUNT_STEP_MS = 320;
const REST_MS = 6_000;

export type Recordings = Record<string, { naive: RunReport; idempotent: RunReport }>;

/**
 * The hero: real recorded runs, played at real speed. Dots run along both timelines, the stamps land, and the counts
 * tick up, then it rests and goes again. It only moves while on screen, and not at all if motion is reduced.
 */
export function HeroSim({ recordings }: { recordings: Recordings }) {
  const [kind, setKind] = useState(FAULTS[0]!.kind);
  const [atMs, setAtMs] = useState(0);
  const [played, setPlayed] = useState(0);
  const [showAttempts, setShowAttempts] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const onScreen = useRef(true);
  const fault = FAULTS.find((f) => f.kind === kind) ?? FAULTS[0]!;
  const { naive, idempotent } = recordings[kind]!;
  const latest = Math.max(lastAttemptAt(naive), lastAttemptAt(idempotent));
  const end = latest + COUNT_AFTER_MS + COUNT_STEP_MS * 4;

  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      onScreen.current = entry?.isIntersecting ?? true;
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = window.setTimeout(() => setAtMs(end), 0);
      return () => window.clearTimeout(id);
    }
    const started = Date.now();
    let rest: number | undefined;
    const clock = window.setInterval(() => {
      const now = Date.now() - started;
      setAtMs(now);
      if (now < end) return;
      window.clearInterval(clock);
      const again = () => {
        // Off screen or in a background tab, it waits instead of playing to nobody.
        if (onScreen.current && !document.hidden) setPlayed((n) => n + 1);
        else rest = window.setTimeout(again, 1_000);
      };
      rest = window.setTimeout(again, REST_MS);
    }, TICK_MS);
    return () => {
      window.clearInterval(clock);
      if (rest) window.clearTimeout(rest);
    };
  }, [kind, played, end]);

  const breakIt = useCallback(() => setPlayed((n) => n + 1), []);
  const choose = (next: string) => {
    setAtMs(0);
    setKind(next);
  };

  // Both stamps land together, once the last dot on either side has landed.
  const stampAt = latest + STAMP_AFTER_MS;
  const left = sideAt(naive, atMs, stampAt);
  const right = sideAt(idempotent, atMs, stampAt);
  const finished = left.phase === "done";
  const ticks = Math.max(0, Math.floor((atMs - latest - COUNT_AFTER_MS) / COUNT_STEP_MS) + 1);
  const comparison = compareSides(left, right);
  const firstDifference = comparison.kind === "diverged" ? comparison.differences[0] : undefined;
  const { rows } = alignSides(inputOf(left), inputOf(right));
  const moving = !finished;

  return (
    <div className="sim" ref={root}>
      <div className="sim__keys" role="group" aria-label="Choose a fault">
        {FAULTS.map((f) => (
          <button
            key={f.kind}
            type="button"
            className="sim__key"
            aria-pressed={f.kind === kind}
            onClick={() => choose(f.kind)}
          >
            <FaultGlyph kind={f.kind} />
            {f.name}
          </button>
        ))}
      </div>

      <div className="screen">
        <div className="board" data-live="true">
          <div className="sim__head">
            <p className="board__title">{naive.scenario.name}</p>
            <FaultChip kind={fault.kind} />
          </div>
          <p className="board__meta">
            {naive.scenario.provider_label}. A real run, replayed at real speed.
          </p>

          <div className="board__sides">
            <div className="board__side" data-side="naive">
              <p className="board__handler">naive</p>
              <SidePlate side={left} />
            </div>
            <div className="board__side" data-side="idempotent">
              <p className="board__handler">idempotent</p>
              <SidePlate side={right} />
            </div>
          </div>

          <SwimLanes
            rows={rows}
            labels={["naive", "idempotent"]}
            named
            hideDue
            headAt={moving ? atMs : null}
            fixedSpan={latest * 1.06}
          />

          {finished ? (
            <ComparisonRow
              comparison={comparison}
              shown={
                firstDifference && [
                  tickToward(firstDifference.naive, ticks),
                  tickToward(firstDifference.idempotent, ticks),
                ]
              }
            />
          ) : (
            <p className="figure__statement figure__statement--wait">Delivering, in real time.</p>
          )}

          <button
            type="button"
            className="sim__toggle"
            aria-expanded={showAttempts}
            onClick={() => setShowAttempts((open) => !open)}
          >
            {showAttempts ? "Hide attempts" : "Show attempts"}
          </button>
          {showAttempts && <AttemptsTable rows={rows} />}
        </div>

        <button type="button" className="btn btn--primary btn--wide" onClick={breakIt}>
          Press to break it again
        </button>
      </div>
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

/** Copies its text, and says so. */
export function CopyKey({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  };
  return (
    <button type="button" className="btn btn--small" onClick={copy}>
      {state === "copied" ? "Copied" : state === "failed" ? "Press Ctrl+C" : label}
    </button>
  );
}

/** A command that copies itself. */
export function CopyLine({ command }: { command: string }) {
  return (
    <div className="copyline">
      <code className="copyline__code">{command}</code>
      <CopyKey text={command} />
    </div>
  );
}
