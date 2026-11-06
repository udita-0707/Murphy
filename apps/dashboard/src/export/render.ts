import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompareBoard } from "@/components/compare-board";
import { ReportView } from "@/components/report-view";
import type { RunReport } from "@/lib/types";
import { EXPORT_CSS } from "./generated/assets";

export type ExportTheme = "night" | "platform";

/** The file blocks anything external itself, so it stays one self-contained file by rule, not by luck. */
const FILE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: ReactElement, generatedAt: Date, theme: ExportTheme): string {
  const content = renderToStaticMarkup(body);
  return `<!doctype html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${FILE_POLICY}">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS.replace(/<\/style/gi, "<\\/style")}</style>
</head>
<body>
<main class="container export">
${content}
<footer class="export__foot">Murphy report, generated ${generatedAt.toISOString()}.</footer>
</main>
</body>
</html>
`;
}

export function renderRunExport(
  report: RunReport,
  generatedAt: Date,
  theme: ExportTheme = "night",
): string {
  return page(
    `Murphy: ${report.scenario.name}`,
    createElement(ReportView, { report }),
    generatedAt,
    theme,
  );
}

export function renderComparisonExport(
  naive: RunReport,
  idempotent: RunReport,
  generatedAt: Date,
  theme: ExportTheme = "night",
): string {
  const seed = naive.run.seed === idempotent.run.seed ? naive.run.seed : null;
  return page(
    `Murphy comparison: ${naive.scenario.name}`,
    createElement(CompareBoard, {
      title: naive.scenario.name,
      provider: naive.scenario.provider_label,
      seed,
      naive: { phase: "done", report: naive },
      idempotent: { phase: "done", report: idempotent },
    }),
    generatedAt,
    theme,
  );
}

const safeName = (text: string) => text.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();

export function runFileName(report: RunReport): string {
  const handler = report.target.handler ?? "run";
  return `murphy-${safeName(report.scenario.slug)}-${safeName(handler)}-${report.run.status}.html`;
}

export function comparisonFileName(report: RunReport): string {
  return `murphy-${safeName(report.scenario.slug)}-comparison.html`;
}
