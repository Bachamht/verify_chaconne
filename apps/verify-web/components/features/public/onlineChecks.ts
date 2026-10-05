/**
 * 联网检查（可选）：按证据包里的交易哈希拉链上回执，解码 Guard / PlanGuard 事件，核对 evidenceHash 属于包内报告。
 * 逻辑与 v7 BundleVerifier.fetchOnline 一致；viem 与 ABI 在调用时才加载。
 * 每条结果带结构化 info（页面据此出中英人话与 <Amount>），detail 只保留英文原文给开发者（title / 技术细节）。
 */
import type { EvidenceBundle, TaskEvidenceBundle } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";

/** 链上最小单位数量 + 登记表里的精度 / 符号；精度未知（null）时页面不换算金额 */
export interface RawPart { raw: string; decimals: number | null; symbol: string | null }
export type OnlineInfo =
  | { kind: "receipt"; block: string; success: boolean }
  | { kind: "event"; event: string; known: boolean; spent: RawPart | null; received: RawPart | null }
  | { kind: "missing_event" }
  | { kind: "rpc_error" }
  | { kind: "no_executions" };
export interface OnlineCheck { id: string; ok: boolean; detail: string; info: OnlineInfo }

export function bundleTxHashes(bundle: EvidenceBundle): string[] {
  const hashes = new Set<string>();
  for (const e of bundle.executions ?? []) if (e.txHash) hashes.add(e.txHash);
  for (const s of bundle.mandate?.steps ?? []) if (s.txHash) hashes.add(s.txHash);
  for (const m of (bundle as TaskEvidenceBundle).mandates ?? []) for (const s of m.steps) if (s.txHash) hashes.add(s.txHash);
  return [...hashes];
}

type Unit = { decimals: number | null; symbol: string | null };
const NO_UNIT: Unit = { decimals: null, symbol: null };

/** 事件里 spent / received 的单位：只认登记表（job 的资产键或 outputToken 地址），查不到就不猜精度 */
export function eventUnits(bundle: Pick<EvidenceBundle, "registry" | "job">, outputToken: string | null): { spent: Unit; received: Unit } {
  const reg = bundle.registry ?? [];
  const byKey = (k: string | undefined) => reg.find((r) => r.assetKey.toLowerCase() === (k ?? "").toLowerCase());
  const unit = (r: (typeof reg)[number] | undefined): Unit => (r ? { decimals: r.tokenDecimals, symbol: r.displaySymbol } : NO_UNIT);
  if (bundle.job) return { spent: unit(byKey(bundle.job.inputAssetKey)), received: unit(byKey(bundle.job.outputAssetKey)) };
  const out = outputToken ? reg.find((r) => r.tokenAddress.toLowerCase() === outputToken.toLowerCase()) : undefined;
  const stables = reg.filter((r) => r.role === "stable_input");
  // 买入步骤（输出是股票）且登记表只有一种稳定币时，支出单位才确定
  const spent = out?.role === "stock_output" && stables.length === 1 ? unit(stables[0]) : NO_UNIT;
  return { spent, received: unit(out) };
}

/** 联网检查的说明文字（金额由页面用 <Amount> 另行渲染） */
export function onlineDetailText(info: OnlineInfo, locale: Locale): string {
  const zh = locale === "zh";
  switch (info.kind) {
    case "receipt": return zh ? `区块 ${info.block}，交易${info.success ? "执行成功" : "已回滚"}` : `Block ${info.block}, transaction ${info.success ? "succeeded" : "reverted"}`;
    case "event": return info.known
      ? (zh ? "事件里的证据哈希对应包内一份报告" : "The event's evidence hash matches a bundled report")
      : (zh ? "事件里的证据哈希不在这个证据包里" : "The event's evidence hash is not in this bundle");
    case "missing_event": return zh ? "回执里没有 Guard / PlanGuard 事件" : "No Guard / PlanGuard event in the receipt";
    case "rpc_error": return zh ? "读不到这笔交易的回执：检查 RPC 地址或稍后重试" : "Could not read this transaction's receipt: check the RPC URL or retry later";
    case "no_executions": return zh ? "证据包里没有链上执行" : "The bundle has no on-chain executions";
  }
}

export async function onlineChecks(text: string, rpc: string): Promise<OnlineCheck[] | null> {
  let bundle: EvidenceBundle;
  try {
    bundle = JSON.parse(text) as EvidenceBundle;
  } catch {
    return null;
  }
  const [{ createPublicClient, decodeEventLog, http }, { GUARD_ABI }, { PLAN_GUARD_ABI }] = await Promise.all([import("viem"), import("@/lib/guardAbi"), import("@/lib/planGuardAbi")]);
  const client = createPublicClient({ transport: http(rpc) });
  const out: OnlineCheck[] = [];
  const hashes = bundleTxHashes(bundle);
  for (const h of hashes) {
    try {
      const rcpt = await client.getTransactionReceipt({ hash: h as `0x${string}` });
      out.push({ id: `receipt_${h.slice(0, 10)}_status`, ok: rcpt.status === "success", detail: `block ${rcpt.blockNumber} status ${rcpt.status}`, info: { kind: "receipt", block: String(rcpt.blockNumber), success: rcpt.status === "success" } });
      let matched = 0;
      for (const l of rcpt.logs) {
        for (const abi of [GUARD_ABI, PLAN_GUARD_ABI] as const) {
          try {
            const d = decodeEventLog({ abi, data: l.data, topics: l.topics });
            if (d.eventName === "GuardedExecution" || d.eventName === "MandateStep") {
              const args = d.args as Record<string, unknown>;
              const ev = String(args["evidenceHash"] ?? "").toLowerCase();
              const known = bundle.reports.some((r) => r.evidenceHash.toLowerCase() === ev);
              const u = eventUnits(bundle, typeof args["outputToken"] === "string" ? (args["outputToken"] as string) : null);
              const part = (k: string, unit: Unit): RawPart | null => (args[k] === undefined || args[k] === null ? null : { raw: String(args[k]), ...unit });
              out.push({
                id: `event_${h.slice(0, 10)}_${d.eventName}`,
                ok: known,
                detail: known ? `${d.eventName} evidenceHash ∈ bundle reports · spent ${String(args["spent"])} received ${String(args["received"])}` : `${d.eventName} evidenceHash ${ev.slice(0, 12)}… not in bundle`,
                info: { kind: "event", event: d.eventName, known, spent: part("spent", u.spent), received: part("received", u.received) },
              });
              matched += 1;
            }
          } catch {
            /* not ours */
          }
        }
      }
      if (matched === 0) out.push({ id: `event_${h.slice(0, 10)}_missing`, ok: false, detail: "no Guard/PlanGuard event in receipt", info: { kind: "missing_event" } });
    } catch (e) {
      out.push({ id: `receipt_${h.slice(0, 10)}`, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e), info: { kind: "rpc_error" } });
    }
  }
  if (hashes.length === 0) out.push({ id: "no_executions", ok: true, detail: "bundle has no on-chain executions", info: { kind: "no_executions" } });
  return out;
}
