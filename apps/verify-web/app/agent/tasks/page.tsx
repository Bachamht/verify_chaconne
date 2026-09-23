import { Suspense } from "react";
import { TasksList } from "@/components/agent/tasks/TasksList";

export default function AgentTasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksList />
    </Suspense>
  );
}
