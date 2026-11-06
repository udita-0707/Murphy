import { formatAt, rowDetail, type BoardRow, type Cell } from "@/lib/board";
import { FaultChip } from "./fault-chip";

function replyOf(cell: Cell): string {
  if (cell.kind === "sent") {
    return cell.status === null ? (cell.error ?? "no reply") : String(cell.status);
  }
  return cell.kind === "due" ? "not sent yet" : "";
}

function atOf(cell: Cell): string {
  if (cell.kind === "sent") return formatAt(cell.at_ms);
  return cell.kind === "due" ? `due ${formatAt(cell.at_ms)}` : "";
}

/** One run's attempts, in the order they really started. */
export function TimelineTable({ rows }: { rows: readonly BoardRow[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">At</th>
            <th scope="col">Event</th>
            <th scope="col">Reply</th>
            <th scope="col">Faults</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cell = row.cells[0];
            const detail = rowDetail(row);
            return (
              <tr key={row.key} className={cell.kind === "due" ? "table__due" : undefined}>
                <td key={cell.kind} className={cell.kind === "sent" ? "cell--sent" : undefined}>
                  {atOf(cell)}
                </td>
                <td>
                  {row.eventType}
                  {detail && <span className="table__sub">{detail}</span>}
                </td>
                <td>{replyOf(cell)}</td>
                <td>
                  <span className="table__chips">
                    {row.faults.map((kind) => (
                      <FaultChip key={kind} kind={kind} />
                    ))}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
