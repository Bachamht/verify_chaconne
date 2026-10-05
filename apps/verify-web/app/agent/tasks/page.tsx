import { Suspense } from "react";
import { TasksRoute } from "@/components/routes/TasksRoute";

export default function AgentTasksPage() {
  return <Suspense fallback={null}><TasksRoute /></Suspense>;
}
