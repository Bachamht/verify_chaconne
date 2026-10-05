import type { Metadata } from "next";
import { PublicReportRoute } from "@/components/routes/PublicReportRoute";

export async function generateMetadata({ params }: { params: Promise<{ shareId: string }> }): Promise<Metadata> {
  const { shareId } = await params;
  return { title: `Chaconne Agent · report ${shareId}`, openGraph: { images: [`/r/${shareId}/opengraph-image`] } };
}

export default async function SharePage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  return <PublicReportRoute shareId={shareId} />;
}
