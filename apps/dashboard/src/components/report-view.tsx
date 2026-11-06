import type { ReactNode } from "react";
import { sideFromReport, singleSide } from "@/lib/board";
import { assertionName } from "@/lib/faults";
import type { RunReport } from "@/lib/types";
import { FaultChip } from "./fault-chip";
import { CheckGlyph, CrossGlyph } from "./glyphs";
import { TimelineTable } from "./timeline-table";
import { VerdictPlate } from "./verdict";

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2 className="section__head">{title}</h2>
      {note && <p className="section__note">{note}</p>}
      {children}
    </section>
  );
}

function AssertionBadge({ status }: { status: RunReport["assertions"][number]["status"] }) {
  if (status === "pass") {
    return (
      <span className="badge badge--passed">
        <CheckGlyph />
        PASS
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="badge badge--failed">
        <CrossGlyph />
        FAIL
      </span>
    );
  }
  return <span className="badge badge--errored">Not evaluated</span>;
}

type Entity = RunReport["entities"][number];
type EntityFigures = NonNullable<Entity["actual"]>;

function EntityRow({
  entity,
  label,
  values,
}: {
  entity: Entity;
  label: string;
  values: EntityFigures | null;
}) {
  if (!values) {
    return (
      <tr>
        <td>{entity.id}</td>
        <td>{label}</td>
        <td colSpan={6}>Not reported</td>
      </tr>
    );
  }
  const expected = entity.expected;
  const cls = (differs: boolean) =>
    label !== "Expected" && differs ? "table__differs" : undefined;
  return (
    <tr>
      <td>{entity.id}</td>
      <td>{label}</td>
      <td className={cls(values.state !== expected.state)}>{values.state}</td>
      <td className={cls(values.balance_minor !== expected.balance_minor)}>
        {values.balance_minor}
      </td>
      <td className={cls(values.effects.credit !== expected.effects.credit)}>
        {values.effects.credit}
      </td>
      <td className={cls(values.effects.booking !== expected.effects.booking)}>
        {values.effects.booking}
      </td>
      <td className={cls(values.effects.refund !== expected.effects.refund)}>
        {values.effects.refund}
      </td>
      <td className={cls(values.effects.hold !== expected.effects.hold)}>{values.effects.hold}</td>
    </tr>
  );
}

/** A finished run. Pure, so the same component draws the page and the standalone export. */
export function ReportView({ report, actions }: { report: RunReport; actions?: ReactNode }) {
  const { run, scenario, target, summary } = report;
  const rows = singleSide(sideFromReport(report));
  return (
    <article className="report" data-report-status={run.status}>
      <header className="board__head">
        <div className="board__heading">
          <h1 className="board__title">{scenario.name}</h1>
          <p className="board__meta">
            {scenario.provider_label}. Payloads resemble this shape, they are not exact copies.
          </p>
        </div>
        {actions}
      </header>

      <VerdictPlate status={run.status} reason={run.reason} />

      <dl className="facts">
        <div>
          <dt>Handler</dt>
          <dd>{target.handler ?? target.endpoint_id}</dd>
        </div>
        <div>
          <dt>Difficulty</dt>
          <dd>{scenario.difficulty}</dd>
        </div>
        <div>
          <dt>Seed</dt>
          <dd>{run.seed}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{(run.duration_ms / 1000).toFixed(1)} s</dd>
        </div>
        <div>
          <dt>Traffic</dt>
          <dd>
            {summary.deliveries} deliveries, {summary.attempts} attempts
          </dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>{run.id}</dd>
        </div>
      </dl>

      <Section title="Assertions">
        <div className="cards">
          {report.assertions.map((a) => (
            <div
              className={`card card--${a.status === "fail" ? "failed" : a.status}`}
              key={`${a.kind}-${a.entity}`}
            >
              <div className="card__head">
                <span>
                  {assertionName(a.kind)} ({a.entity})
                </span>
                <AssertionBadge status={a.status} />
              </div>
              <p className="card__body">{a.reason}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Faults injected"
        note="Engine faults came from Murphy's real delivery worker alone. Target faults happened only because the target obeyed the signed block."
      >
        {report.faults.length === 0 ? (
          <p>This scenario injects no faults.</p>
        ) : (
          <div className="cards">
            {report.faults.map((f) => (
              <div
                className={`card ${f.realised ? "" : "card--not_evaluated"}`}
                key={`${f.step}-${f.kind}`}
              >
                <div className="card__head">
                  <FaultChip kind={f.kind} />
                  <span>{f.realised ? "Happened" : "Did not happen"}</span>
                </div>
                <p className="card__body">
                  On {f.step}: {f.detail}
                </p>
                <p className="card__evidence">Evidence: {f.evidence}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Timeline" note="Every attempt, in the order it really started.">
        <TimelineTable rows={rows} />
      </Section>

      <Section title="Final state" note="Expected against what the target itself reported.">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Entity</th>
                <th scope="col">Source</th>
                <th scope="col">State</th>
                <th scope="col">Balance</th>
                <th scope="col">Credit</th>
                <th scope="col">Booking</th>
                <th scope="col">Refund</th>
                <th scope="col">Hold</th>
              </tr>
            </thead>
            <tbody>
              {report.entities.flatMap((e) => [
                <EntityRow key={`${e.id}-e`} entity={e} label="Expected" values={e.expected} />,
                <EntityRow key={`${e.id}-a`} entity={e} label="Reported" values={e.actual} />,
              ])}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="What this does not prove">
        <ul className="limits">
          {report.limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </Section>
    </article>
  );
}
