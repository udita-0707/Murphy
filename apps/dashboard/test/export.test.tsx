import { describe, expect, it } from "vitest";
import {
  comparisonFileName,
  renderComparisonExport,
  renderRunExport,
  runFileName,
} from "@/export/render";
import { EXPORT_CSS } from "@/export/generated/assets";
import { fixtures as f } from "@/lib/fixtures";
import { buildExportCss } from "../scripts/export-assets";

const at = new Date("2026-11-12T10:00:00.000Z");

/** Everything that could make a browser fetch something. */
function expectSelfContained(html: string) {
  expect(html).not.toMatch(/<script|<link|<iframe|<img|<object|<embed/i);
  expect(html).not.toMatch(/\bsrc=|\bhref=/i);
  expect(html).not.toMatch(/@import/);
  const urls = [...html.matchAll(/url\(\s*["']?([^"')]*)/g)].map((m) => m[1]!);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect(url.startsWith("data:font/woff2;base64,")).toBe(true);
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).toContain("default-src 'none'");
}

describe("the run report export", () => {
  it.each([
    ["failed", f.duplicateNaive, "FAIL"],
    ["passed", f.duplicateIdempotent, "PASS"],
    ["errored", f.errored, "ERRORED"],
  ] as const)("%s: self-contained, with its verdict and limits", (_name, report, word) => {
    const html = renderRunExport(report, at);
    expectSelfContained(html);
    expect(html).toContain(word);
    expect(html).toContain("What this does not prove");
    expect(html).toContain("2026-11-12T10:00:00.000Z");
  });

  it("errored keeps its wording, and is not drawn as a failure", () => {
    const html = renderRunExport(f.errored, at);
    expect(html).toContain("Not a fair test, proves nothing");
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toContain("verdict--errored");
    expect(body).not.toContain("verdict--failed");
  });

  it("carries no request headers, signatures or secrets", () => {
    const html = renderRunExport(f.duplicateNaive, at);
    expect(html).not.toMatch(/whsec_|mk_|webhook-signature/i);
  });

  it("escapes what comes from a scenario", () => {
    const report = structuredClone(f.duplicateNaive);
    report.scenario.name = `<script>alert("x")</script>`;
    const html = renderRunExport(report, at);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the comparison export", () => {
  it("is self-contained, with both verdicts and the real figure", () => {
    const html = renderComparisonExport(f.duplicateNaive, f.duplicateIdempotent, at);
    expectSelfContained(html);
    expect(html).toContain("verdict--failed");
    expect(html).toContain("verdict--passed");
    expect(html).toContain("Booking effect");
    expect(html).toContain("2 vs 1, expected 1");
  });

  it("does not animate, because it is not live", () => {
    expect(renderComparisonExport(f.duplicateNaive, f.duplicateIdempotent, at)).toContain(
      'data-live="false"',
    );
  });

  it("shows no comparison when a side errored", () => {
    const html = renderComparisonExport(f.errored, f.duplicateIdempotent, at);
    expectSelfContained(html);
    expect(html).toContain("No comparison: one side was not a fair test, proves nothing.");
    expect(html).not.toContain("Booking effect");
  });

  it("can follow the light room", () => {
    expect(
      renderComparisonExport(f.duplicateNaive, f.duplicateIdempotent, at, "platform"),
    ).toContain('data-theme="platform"');
  });
});

describe("export design", () => {
  it("uses the same tokens and report styles as the app: the generated file has not drifted", () => {
    expect(EXPORT_CSS).toBe(buildExportCss());
  });

  it("has safe, readable file names", () => {
    expect(runFileName(f.duplicateNaive)).toBe(
      "murphy-booking-duplicate-confirmation-naive-failed.html",
    );
    expect(comparisonFileName(f.duplicateNaive)).toBe(
      "murphy-booking-duplicate-confirmation-comparison.html",
    );
    const odd = structuredClone(f.duplicateNaive);
    odd.target.handler = "../../etc";
    expect(runFileName(odd)).not.toContain("/");
  });
});
