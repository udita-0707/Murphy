import type { ReactNode } from "react";
import type { Verdict as VerdictStatus } from "@/lib/types";
import { CheckGlyph, CrossGlyph } from "./glyphs";

const WORDS: Record<VerdictStatus, string> = { passed: "PASS", failed: "FAIL", errored: "ERRORED" };

export const PASS_LINE = "Survived these faults, in this run";
export const ERRORED_LINE = "Not a fair test, proves nothing";

/** The large verdict. FAIL is solid, PASS is hollow, errored is dashed and striped with no mark. */
export function VerdictPlate({ status, reason }: { status: VerdictStatus; reason: string | null }) {
  return (
    <div className={`verdict verdict--${status}`} data-verdict={status}>
      <div className="verdict__plate verdict__plate--landed">
        {status === "failed" && <CrossGlyph />}
        {status === "passed" && <CheckGlyph />}
        {WORDS[status]}
      </div>
      {status === "failed" && <p className="verdict__line">{reason}</p>}
      {status === "passed" && <p className="verdict__line">{PASS_LINE}</p>}
      {status === "errored" && (
        <>
          <p className="verdict__line">{ERRORED_LINE}</p>
          {reason && <p className="verdict__why">{reason}</p>}
        </>
      )}
    </div>
  );
}

/** A side with no verdict yet, or none coming. It must never be mistaken for one. */
export function PendingPlate({
  variant,
  title,
  children,
}: {
  variant: "pending" | "none";
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={`verdict verdict--${variant}`} data-verdict={variant}>
      <div className="verdict__plate">{title}</div>
      {children && <p className="verdict__why">{children}</p>}
    </div>
  );
}

export function StatusBadge({ status }: { status: VerdictStatus | "running" }) {
  if (status === "running") return <span className="badge badge--running">Running</span>;
  return (
    <span className={`badge badge--${status}`}>
      {status === "failed" && <CrossGlyph />}
      {status === "passed" && <CheckGlyph />}
      {WORDS[status]}
    </span>
  );
}
