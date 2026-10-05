import { MandateRoute } from "@/components/routes/MandateRoute";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MandateRoute id={id} />;
}
