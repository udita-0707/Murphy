import { Suspense } from "react";
import { DeliveriesView } from "@/components/log-views";
import { Loading } from "@/components/states";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ hide_simulated?: string; status?: string }>;
}) {
  const { hide_simulated, status } = await searchParams;
  return (
    <Suspense fallback={<Loading label="Loading" />}>
      <DeliveriesView hide={hide_simulated === "1"} status={status ?? null} />
    </Suspense>
  );
}
