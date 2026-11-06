import { Suspense } from "react";
import { EndpointsView } from "@/components/log-views";
import { Loading } from "@/components/states";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ hide_simulated?: string }>;
}) {
  const { hide_simulated } = await searchParams;
  return (
    <Suspense fallback={<Loading label="Loading" />}>
      <EndpointsView hide={hide_simulated === "1"} />
    </Suspense>
  );
}
