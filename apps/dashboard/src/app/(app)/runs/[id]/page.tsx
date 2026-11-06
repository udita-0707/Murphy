import { RunView } from "@/components/run-view";

export default async function Run({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunView key={id} id={id} />;
}
