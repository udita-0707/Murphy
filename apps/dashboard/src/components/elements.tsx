import type { BoardRow, Cell } from "@/lib/board";
import { faultOrigin } from "@/lib/faults";
import { CheckGlyph, CrossGlyph } from "./glyphs";

/** One small drawn mark per fault kind, so a fault reads at a glance. Always beside its word. */
export function FaultGlyph({ kind }: { kind: string }) {
  const common = {
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    focusable: false,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "glyph",
  };
  switch (kind) {
    case "duplicate":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="11" height="11" rx="2.5" />
          <path d="M9 19.5h8.5a2 2 0 0 0 2-2V9" />
        </svg>
      );
    case "delay":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7v5.5l3.5 2" />
        </svg>
      );
    case "reorder":
      return (
        <svg {...common}>
          <path d="M7 4v15M7 19l-3.5-3.5M7 19l3.5-3.5" />
          <path d="M17 20V5M17 5l-3.5 3.5M17 5l3.5 3.5" />
        </svg>
      );
    case "drop_then_redeliver":
      return (
        <svg {...common}>
          <path d="M3 12h6M15 12h6" />
          <path d="M11 8l2 8" />
          <path d="M17.5 8.5 21 12l-3.5 3.5" />
        </svg>
      );
    case "respond_with":
      return (
        <svg {...common}>
          <path d="M20 12a8 8 0 1 1-2.5-5.8" />
          <path d="M20 3.5V8h-4.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
        </svg>
      );
  }
}

/** A count drawn as tokens, so "2 vs 1" is visible as two things and one thing. */
export function EffectTokens({ value }: { value: string }) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) return null;
  return (
    <span className="tokens" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span className="token" key={i} />
      ))}
    </span>
  );
}

export function DifficultyPips({ level }: { level: string }) {
  const filled = { beginner: 1, intermediate: 2, advanced: 3 }[level] ?? 0;
  return (
    <span className="pips" aria-hidden="true">
      {[1, 2, 3].map((n) => (
        <span key={n} className={n <= filled ? "pip pip--on" : "pip"} />
      ))}
    </span>
  );
}

/** Each assertion at a glance: a filled tile with a cross, a ring with a check, or a dashed blank. */
export function AssertionMeter({ statuses }: { statuses: readonly string[] }) {
  return (
    <span className="meter" aria-hidden="true">
      {statuses.map((status, i) => (
        <span key={i} className={`meter__cell meter__cell--${status}`}>
          {status === "pass" && <CheckGlyph />}
          {status === "fail" && <CrossGlyph />}
        </span>
      ))}
    </span>
  );
}

function sentAt(cell: Cell): number | null {
  return cell.kind === "sent" ? cell.at_ms : null;
}

function Lane({
  label,
  rows,
  side,
  span,
}: {
  label?: string;
  rows: readonly BoardRow[];
  side: 0 | 1;
  span: number;
}) {
  return (
    <div className="lane">
      {label && <span className="lane__label">{label}</span>}
      <div className="lane__track">
        {rows.map((row) => {
          const cell = row.cells[side];
          if (cell.kind === "absent") return null;
          const faulted = row.faults.some((kind) => faultOrigin(kind));
          const failed =
            cell.kind === "sent" &&
            !(cell.status !== null && cell.status >= 200 && cell.status < 300);
          const cls = [
            "lane__mark",
            cell.kind === "due" ? "lane__mark--due" : "",
            faulted ? "lane__mark--fault" : "",
            failed ? "lane__mark--bad" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <span
              key={row.key}
              className={cls}
              style={{ left: `${Math.min(100, (cell.at_ms / span) * 100)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The attempts drawn on a clock. The table below is the record, and says all of this in words, so this is
 * hidden from screen readers. Diamonds carry a fault, hollow marks got no 2xx, faint ones are not sent yet.
 */
export function SwimLanes({
  rows,
  labels,
}: {
  rows: readonly BoardRow[];
  labels?: readonly [string, string];
}) {
  if (rows.length === 0) return null;
  const times = rows.flatMap((row) =>
    row.cells.flatMap((cell) => (cell.kind === "absent" ? [] : [cell.at_ms])),
  );
  const sent = rows.flatMap((row) => row.cells.flatMap((cell) => sentAt(cell) ?? []));
  const longest = Math.max(1, ...times, ...sent);
  const span = longest * 1.04;
  return (
    <div className="lanes" aria-hidden="true">
      <Lane label={labels?.[0]} rows={rows} side={0} span={span} />
      {labels && <Lane label={labels[1]} rows={rows} side={1} span={span} />}
      <div className={labels ? "lanes__axis lanes__axis--labelled" : "lanes__axis"}>
        <span>0 s</span>
        <span>{(span / 1000).toFixed(1)} s</span>
      </div>
    </div>
  );
}
