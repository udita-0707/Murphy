"use client";

import { useState } from "react";
import type { RunReport } from "@/lib/types";

function save(html: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const currentTheme = () =>
  document.documentElement.dataset.theme === "platform" ? "platform" : "night";

/** The renderer and its embedded fonts load only when someone downloads. */
function Download({ label, build }: { label: string; build: () => Promise<[string, string]> }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const click = async () => {
    setState("busy");
    try {
      const [html, fileName] = await build();
      save(html, fileName);
      setState("idle");
    } catch (err) {
      console.error(err);
      setState("failed");
    }
  };
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={click}
        disabled={state === "busy"}
        aria-busy={state === "busy"}
      >
        {state === "busy" ? "Building file" : label}
      </button>
      {state === "failed" && (
        <p className="field__error" role="alert">
          The file could not be built.
        </p>
      )}
    </>
  );
}

export function DownloadRun({ report }: { report: RunReport }) {
  return (
    <Download
      label="Download report"
      build={async () => {
        const e = await import("@/export/render");
        return [e.renderRunExport(report, new Date(), currentTheme()), e.runFileName(report)];
      }}
    />
  );
}

export function DownloadComparison({
  naive,
  idempotent,
}: {
  naive: RunReport;
  idempotent: RunReport;
}) {
  return (
    <Download
      label="Download comparison"
      build={async () => {
        const e = await import("@/export/render");
        return [
          e.renderComparisonExport(naive, idempotent, new Date(), currentTheme()),
          e.comparisonFileName(naive),
        ];
      }}
    />
  );
}
