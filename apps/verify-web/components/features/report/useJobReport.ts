"use client";
/**
 * 报告页取数（与 JobClient 同一组接口、同一 owner 规则）：job → report（402 = 未付款，按「尚未交付」处理）→ bill；资产表只为换算单位。
 * 已连接钱包就按它当调用方（?owner=，FIX-174）。各区块独立四态：报告失败不拖垮账单，账单失败不拖垮报告。
 */
import type { Bill } from "@chaconne/core/verify";
import { api, type AssetsResponse } from "@/lib/api";
import { jobsV2 } from "@/lib/api-v2";
import { useAccount } from "@/lib/useAccount";
import { useResource } from "@/lib/useResource";
import type { AssetLite, JobView, ReportResponse } from "./model";

export function useAssets() {
  return useResource<AssetLite[]>("v1/assets", async () => {
    const r = await api<AssetsResponse>("GET", "v1/assets");
    return { status: r.status, data: Array.isArray(r.data?.assets) ? r.data.assets : [] };
  });
}

export function useJobReport(jobId: string) {
  const account = useAccount();
  const ownerQ = account ? `?owner=${account.toLowerCase()}` : "";
  const job = useResource<JobView>(`job:${jobId}:${ownerQ}`, async () => {
    const r = await api<JobView>("GET", `v1/jobs/${jobId}${ownerQ}`);
    return { status: r.status, data: r.data };
  });
  const jobOk = job.state === "ok";
  const report = useResource<ReportResponse | null>(jobOk ? `report:${jobId}:${ownerQ}` : null, async () => {
    const r = await api<ReportResponse>("GET", `v1/jobs/${jobId}/report${ownerQ}`);
    return { status: r.status, data: r.status === 200 ? r.data : null };
  }, { ok: (s) => s === 200 || s === 402, isEmpty: (d) => d === null });
  const bill = useResource<Bill | null>(jobOk ? `bill:${jobId}:${account ?? ""}` : null, () => jobsV2.bill(jobId, account), { isEmpty: (d) => d === null });
  const assets = useAssets();
  return { account, job, report, bill, assets };
}
