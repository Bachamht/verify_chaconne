import { TaskDetail } from "@/components/agent/tasks/TaskDetail";

export default async function AgentTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskDetail id={id} />;
}
