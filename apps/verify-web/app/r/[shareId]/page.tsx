import type { Metadata } from "next";
import { PublicReportClient } from "@/components/PublicReportClient";

export async function generateMetadata({ params }: { params: Promise<{ shareId: string }> }): Promise<Metadata> {
  const { shareId } = await params;
  return { title: `Chaconne Verify · report ${shareId}`, openGraph: { images: [`/r/${shareId}/opengraph-image`] } };
}

export default async function SharePage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  return <PublicReportClient shareId={shareId} />;
}
