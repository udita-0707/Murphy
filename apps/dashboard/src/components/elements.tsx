import type { BoardRow } from "@/lib/board";
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

/** A short name for a mark: the part after the last dot, and whether it is a repeat. */
function shortLabel(row: BoardRow): string {
  const name = row.eventType.split(".").pop() ?? row.eventType;
  if (row.copy > 1) return `${name} again`;
  if (row.attemptNo > 1) return `${name} retry`;
  return name;
}

function Lane({
  label,
  rows,
  side,
  span,
  named,
  headAt,
  hideDue,
}: {
  label?: string;
  rows: readonly BoardRow[];
  side: 0 | 1;
  span: number;
  named: boolean;
  headAt: number | null;
  hideDue: boolean;
}) {
  const marks = rows.flatMap((row) => {
    const cell = row.cells[side];
    if (cell.kind === "absent" || (hideDue && cell.kind === "due")) return [];
    return [{ row, cell, at: Math.min(100, (cell.at_ms / span) * 100) }];
  });
  marks.sort((x, y) => x.at - y.at);
  // Close neighbours take turns above and below the line, so their names cannot collide.
  let tier = 0;
  return (
    <div className={named ? "lane lane--named" : "lane"}>
      {label && <span className="lane__label">{label}</span>}
      <div className="lane__track">
        {marks.map(({ row, cell, at }, i) => {
          tier = i > 0 && at - marks[i - 1]!.at < 18 ? 1 - tier : 0;
          const failed =
            cell.kind === "sent" &&
            !(cell.status !== null && cell.status >= 200 && cell.status < 300);
          const cls = [
            "lane__mark",
            cell.kind === "due" ? "lane__mark--due" : "",
            row.faults.length > 0 ? "lane__mark--fault" : "",
            failed ? "lane__mark--bad" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const align = at > 86 ? "end" : at < 8 ? "start" : "mid";
          return (
            <span key={row.key} className="lane__point" style={{ left: `${at}%` }}>
              <span className={cls} />
              {named && (
                <span className={`lane__name lane__name--${tier} lane__name--${align}`}>
                  {shortLabel(row)}
                </span>
              )}
            </span>
          );
        })}
        {headAt !== null && (
          <span
            className="lane__head"
            style={{ transform: `translateX(${Math.min(100, (headAt / span) * 100)}%)` }}
          >
            <span className="lane__ball" />
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The attempts drawn on a clock. Diamonds carry a fault, hollow marks got no 2xx, faint ones are not sent yet.
 * Next to a table it is hidden from screen readers, since the table says the same. Without one (`named`) its words count.
 */
export function SwimLanes({
  rows,
  labels,
  named = false,
  headAt = null,
  hideDue = false,
  fixedSpan,
}: {
  rows: readonly BoardRow[];
  labels?: readonly [string, string];
  /** Print each event's name beside its mark. */
  named?: boolean;
  /** Where a moving ball is, in ms, while a run plays. */
  headAt?: number | null;
  hideDue?: boolean;
  /** Keeps the scale still while a run plays. */
  fixedSpan?: number;
}) {
  const times = rows.flatMap((row) =>
    row.cells.flatMap((cell) => (cell.kind === "absent" ? [] : [cell.at_ms])),
  );
  if (times.length === 0 && fixedSpan === undefined) return null;
  const span = fixedSpan ?? Math.max(1, ...times) * 1.04;
  const common = { rows, span, named, headAt, hideDue };
  return (
    <div className="lanes" aria-hidden={named ? undefined : true}>
      <Lane {...common} label={labels?.[0]} side={0} />
      {labels && <Lane {...common} label={labels[1]} side={1} />}
      <div className={labels ? "lanes__axis lanes__axis--labelled" : "lanes__axis"}>
        <span>0 s</span>
        <span>{(span / 1000).toFixed(1)} s</span>
      </div>
    </div>
  );
}

/** A scenario's steps at a glance, in the order they are sent. Diamonds carry a fault, and a duplicate is drawn twice. */
export function MiniTimeline({
  steps,
}: {
  steps: readonly { id: string; event_type: string; faults: readonly string[] }[];
}) {
  return (
    <span className="mini" aria-hidden="true">
      {steps.flatMap((step) => {
        const hot = step.faults.length > 0;
        const one = (
          <span
            key={step.id}
            className={hot ? "mini__mark mini__mark--fault" : "mini__mark"}
            title={step.event_type}
          />
        );
        if (!step.faults.includes("duplicate")) return [one];
        return [
          <span key={`${step.id}-first`} className="mini__mark" title={step.event_type} />,
          one,
        ];
      })}
    </span>
  );
}
