import { ExecuteClient } from "@/components/ExecuteClient";

export default async function ExecutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExecuteClient jobId={id} />;
}
