import { CompareView } from "@/components/compare-view";

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

export default async function Compare({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const naive = one(params.naive);
  const idempotent = one(params.idempotent);
  return (
    <CompareView
      key={`${naive}:${idempotent}`}
      naive={naive}
      idempotent={idempotent}
      naiveError={one(params.naive_error)}
      idempotentError={one(params.idempotent_error)}
    />
  );
}
