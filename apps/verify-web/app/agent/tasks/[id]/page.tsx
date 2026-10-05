import { TaskPage } from "@/components/routes/TaskPage";

export default async function AgentTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskPage id={id} />;
}
