import type { ReactNode } from "react";
import {
  alignSides,
  formatAt,
  rowDetail,
  sideFromReport,
  startGapMs,
  type BoardRow,
  type Cell,
  type SideInput,
} from "@/lib/board";
import {
  compareSides,
  type Comparison,
  type Difference,
  type HandlerName,
  type SideState,
} from "@/lib/compare";
import { EffectTokens, SwimLanes } from "./elements";
import { FaultChip } from "./fault-chip";
import { PendingPlate, VerdictPlate } from "./verdict";

export function inputOf(side: SideState): SideInput | null {
  if (side.phase === "done") return sideFromReport(side.report);
  if (side.phase === "running" || side.phase === "gave_up") return side.input;
  return null;
}

export function SidePlate({ side }: { side: SideState }) {
  switch (side.phase) {
    case "done":
      return <VerdictPlate status={side.report.run.status} reason={side.report.run.reason} />;
    case "loading":
      return <PendingPlate variant="pending" title="Starting" />;
    case "running":
      return (
        <PendingPlate variant="pending" title="Running">
          {side.lostContact ? "Lost contact, retrying. The run itself is unaffected." : null}
        </PendingPlate>
      );
    case "did_not_start":
      return (
        <PendingPlate variant="none" title="Did not start">
          {side.reason}
        </PendingPlate>
      );
    case "gave_up":
      return (
        <PendingPlate variant="none" title="Gave up watching">
          The run may still finish.
        </PendingPlate>
      );
    case "unreadable":
      return (
        <PendingPlate variant="none" title="Report unreadable">
          {side.reason}
        </PendingPlate>
      );
  }
}

function CellView({ cell }: { cell: Cell }) {
  switch (cell.kind) {
    case "absent":
      return <span className="cell cell--absent">no such attempt</span>;
    case "due":
      return <span className="cell cell--due">due {formatAt(cell.at_ms)}</span>;
    case "sent": {
      const ok = cell.status !== null && cell.status >= 200 && cell.status < 300;
      return (
        <span className="cell cell--sent">
          <span className="cell__at">{formatAt(cell.at_ms)}</span>
          <span className={ok ? "cell__reply" : "cell__reply cell__reply--bad"}>
            {cell.status ?? "no reply"}
          </span>
        </span>
      );
    }
  }
}

/** The rows, side by side. On a phone each row stacks: the event, then naive, then idempotent. */
export function AttemptsTable({ rows }: { rows: readonly BoardRow[] }) {
  return (
    <table className="spine">
      <colgroup>
        <col style={{ width: "30%" }} />
        <col style={{ width: "40%" }} />
        <col style={{ width: "30%" }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">naive</th>
          <th scope="col" className="spine__mid">
            Event, in real attempt order
          </th>
          <th scope="col">idempotent</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const detail = rowDetail(row);
          return (
            <tr key={row.key}>
              <td key={`naive-${row.cells[0].kind}`} data-label="naive" className="spine__side">
                <CellView cell={row.cells[0]} />
              </td>
              <td className="spine__mid">
                <span className="spine__event">{row.eventType}</span>
                {detail && <span className="spine__sub">{detail}</span>}
                {row.faults.length > 0 && (
                  <span className="spine__chips">
                    {row.faults.map((kind) => (
                      <FaultChip key={kind} kind={kind} />
                    ))}
                  </span>
                )}
              </td>
              <td
                key={`idempotent-${row.cells[1].kind}`}
                data-label="idempotent"
                className="spine__side"
              >
                <CellView cell={row.cells[1]} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Figure({
  difference,
  more,
  shown,
}: {
  difference: Difference;
  more: number;
  /** What the two numbers read right now, while they count up. */
  shown?: readonly [string, string];
}) {
  const valueClass = difference.numeric ? "figure__value" : "figure__value figure__value--text";
  const naive = shown?.[0] ?? difference.naive;
  const idempotent = shown?.[1] ?? difference.idempotent;
  return (
    <div className="figure" data-testid="figure">
      <div className="figure__side" data-label="naive">
        <div className={valueClass}>{naive}</div>
        <EffectTokens value={naive} />
      </div>
      <div className="figure__label">
        <span className="figure__name">{difference.name}</span>
        <span className="figure__expected">
          {difference.naive} vs {difference.idempotent}, expected {difference.expected}
        </span>
        {more > 0 && (
          <span className="figure__more">
            and {more} more {more === 1 ? "difference" : "differences"} in the final state
          </span>
        )}
      </div>
      <div className="figure__side" data-label="idempotent">
        <div className={valueClass}>{idempotent}</div>
        <EffectTokens value={idempotent} />
      </div>
    </div>
  );
}

export function ComparisonRow({
  comparison,
  shown,
}: {
  comparison: Comparison;
  shown?: readonly [string, string];
}) {
  switch (comparison.kind) {
    case "diverged": {
      const [first, ...rest] = comparison.differences;
      return <Figure difference={first!} more={rest.length} shown={shown} />;
    }
    case "no_comparison":
      return (
        <p className="figure__statement figure__statement--void" data-testid="figure">
          {comparison.text}
        </p>
      );
    case "not_separated":
      return (
        <p className="figure__statement figure__statement--plain" data-testid="figure">
          {comparison.text}
        </p>
      );
    case "waiting":
      return (
        <p className="figure__statement figure__statement--wait" data-testid="figure">
          {comparison.text}
        </p>
      );
  }
}

const startedAtOf = (side: SideState) =>
  side.phase === "done"
    ? side.report.run.started_at
    : side.phase === "running"
      ? side.startedAt
      : null;

export function CompareBoard({
  title,
  provider,
  seed,
  naive,
  idempotent,
  live = false,
  actions,
}: {
  title: string;
  provider?: string | null;
  seed?: number | null;
  naive: SideState;
  idempotent: SideState;
  /** Motion only runs on a live board, never in an export. */
  live?: boolean;
  actions?: ReactNode;
}) {
  const { rows, orderDiffers } = alignSides(inputOf(naive), inputOf(idempotent));
  const comparison = compareSides(naive, idempotent);
  const gap = startGapMs(startedAtOf(naive), startedAtOf(idempotent));
  const handlers: [HandlerName, SideState][] = [
    ["naive", naive],
    ["idempotent", idempotent],
  ];
  const meta = [
    provider,
    seed != null ? `Same seed: ${seed}` : null,
    gap != null ? `Started ${gap} ms apart` : null,
  ].filter(Boolean);

  return (
    <section className="board" data-live={live} aria-label={`Comparison: ${title}`}>
      <header className="board__head">
        <div className="board__heading">
          <h1 className="board__title">{title}</h1>
          {meta.length > 0 && <p className="board__meta">{meta.join(". ")}</p>}
        </div>
        {actions}
      </header>

      <div className="board__sides">
        {handlers.map(([name, side]) => (
          <div className="board__side" key={name} data-side={name}>
            <p className="board__handler">{name}</p>
            <SidePlate side={side} />
          </div>
        ))}
      </div>

      <SwimLanes rows={rows} labels={["naive", "idempotent"]} />

      <AttemptsTable rows={rows} />

      {orderDiffers && (
        <p className="board__meta">The two sides did not see these attempts in the same order.</p>
      )}

      <ComparisonRow comparison={comparison} />
    </section>
  );
}
