import { notFound } from "next/navigation";
import { ReportView } from "@/components/report-view";
import { fixtures as f } from "@/lib/fixtures";

const CASES = {
  failed: f.duplicateNaive,
  passed: f.duplicateIdempotent,
  errored: f.errored,
  retry: f.retryNaive,
};

export default async function Preview({
  searchParams,
}: {
  searchParams: Promise<{ case?: keyof typeof CASES }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const report = CASES[params.case ?? "failed"];
  if (!report) notFound();
  return (
    <main className="container page">
      <ReportView report={report} />
    </main>
  );
}
