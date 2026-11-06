import { DeliveryView } from "@/components/log-views";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeliveryView key={id} id={id} />;
}
