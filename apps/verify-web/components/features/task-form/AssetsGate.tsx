"use client";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import type { TradableAssets } from "./useTradableAssets";

/** 表单的四态外壳：登记表加载中（等形骨架）/ 拿不到（修法 + 重试）/ 没有可交易股票（原因 + 重试）/ 正常 */
export function AssetsGate({ assets, children }: { assets: TradableAssets; children: ReactNode }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (assets.state === "loading" || assets.state === "idle") return <LoadingBlock shape={<FormSkeleton />} onRetry={assets.reload} label={zh ? "正在获取可交易资产" : "Loading tradable assets"} />;
  if (assets.state === "error") {
    return <Panel><ErrorState status={assets.status ?? 0} title={zh ? "暂时拿不到可交易资产" : "Tradable assets are unavailable"} description={zh ? "资产登记表没有回应，本机也没有缓存。稍后重试。" : "The asset registry did not answer and nothing is cached on this device. Retry shortly."} onRetry={assets.reload} /></Panel>;
  }
  if (assets.state === "empty") {
    return <Panel><EmptyState title={zh ? "现在没有可交易的股票" : "No tradable stocks right now"} description={zh ? "登记表里暂时没有开放交易的股票或资金币种。" : "The registry currently lists no tradable stocks or funding currencies."} action={<Button size="sm" variant="outline" onClick={assets.reload}>{zh ? "重新加载" : "Reload"}</Button>} /></Panel>;
  }
  return <>{children}</>;
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <Skeleton className="h-4 w-40" />
          <div className="grid gap-2 sm:grid-cols-2">{[0, 1, 2, 3].map((j) => <Skeleton key={j} className="h-16" />)}</div>
          <Skeleton className="h-20" />
        </div>
      ))}
    </div>
  );
}
