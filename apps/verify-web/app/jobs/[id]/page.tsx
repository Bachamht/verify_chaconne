import { JobClient } from "@/components/JobClient";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobClient jobId={id} />;
}
