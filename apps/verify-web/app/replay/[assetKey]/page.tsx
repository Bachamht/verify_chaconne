import { ReplayClient } from "@/components/ReplayClient";

export default async function ReplayPage({ params }: { params: Promise<{ assetKey: string }> }) {
  const { assetKey } = await params;
  return <ReplayClient assetKey={decodeURIComponent(assetKey)} />;
}
