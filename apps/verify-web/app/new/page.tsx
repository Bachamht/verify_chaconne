import { Suspense } from "react";
import { NewJobForm } from "@/components/NewJobForm";

export default function NewPage() {
  return (
    <Suspense fallback={null}>
      <NewJobForm />
    </Suspense>
  );
}
