import { Suspense } from "react";
import { DeliveriesView } from "@/components/log-views";
import { Loading } from "@/components/states";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ hide_simulated?: string }>;
}) {
  const { hide_simulated } = await searchParams;
  return (
    <Suspense fallback={<Loading label="Loading" />}>
      <DeliveriesView hide={hide_simulated === "1"} />
    </Suspense>
  );
}
