import { EventView } from "@/components/log-views";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventView key={id} id={id} />;
}
