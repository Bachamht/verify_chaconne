import { Suspense } from "react";
import { JournalSwitch } from "@/components/routes/JournalSwitch";

export default function AgentJournalPage() {
  return <Suspense fallback={null}><JournalSwitch /></Suspense>;
}
