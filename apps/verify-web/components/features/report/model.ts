/**
 * 报告页数据形状与纯换算（不引 React）：账单行 → 人话 + 金额参数；资产精度查找。
 * 页面永不显示原始单位：金额一律交给 <Amount raw decimals symbol />，查不到精度就显示「—」并标未返回（V-37）。
 */
import type { Bill } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import type { Report } from "@/components/JobClient";

export type { JobView, Report, ExecutionReceipt } from "@/components/JobClient";

export interface EvidenceItem {
  evidenceId: string;
  provider: string;
  endpoint: string;
  mode: string;
  time: { requestedAt: string; receivedAt: string; sourcePublishedAt: string | null };
  rawHash: string;
  payload: { kind: string } & Record<string, unknown>;
}
export interface ReportResponse { report: Report; reportHash: string; evidence: EvidenceItem[] }

export interface AssetLite { assetKey: string; tokenAddress: string; tokenDecimals: number; displaySymbol: string; role: "stable_input" | "stock_output"; executionAllowed: boolean; underlyingId: string }
export interface UnitMeta { decimals: number | null; symbol: string | null }

/** assetKey（eip155:196:0x…）或代币地址 → 精度 + 符号；查不到给 null（不猜 6 / 18） */
export function unitOf(assets: AssetLite[] | null | undefined, keyOrAddress: string | null | undefined): UnitMeta {
  if (!assets || !keyOrAddress) return { decimals: null, symbol: null };
  const q = keyOrAddress.toLowerCase();
  const hit = assets.find((a) => a.assetKey.toLowerCase() === q || a.tokenAddress.toLowerCase() === q);
  return hit ? { decimals: hit.tokenDecimals, symbol: hit.displaySymbol } : { decimals: null, symbol: null };
}

/** 股票资产的底层代码：us-equity:AAPL → AAPL */
export function tickerOf(underlyingId: string | null | undefined): string {
  return underlyingId ? (underlyingId.split(":").pop() ?? underlyingId) : "";
}

export type BillGroup = "fees" | "principal" | "gas";
export interface BillRow {
  key: string;
  group: BillGroup;
  label: string;
  /** usd：已是美元十进制；token：原始单位 + 精度（可能未知）；units：gas 用量（整数，本来就是人类单位） */
  amount: { kind: "usd"; value: string } | { kind: "token"; raw: string; decimals: number | null; symbol: string | null } | { kind: "units"; value: string } | null;
  free: boolean;
  txHash: string | null;
}

/** 服务端账单标签（sku / "execution att_x spent"）→ 人话；原标签只进 title */
function billLabel(group: BillGroup, label: string, locale: Locale): string {
  const zh = locale === "zh";
  if (group === "fees") return /\(free\)\s*$/.test(label) ? (zh ? "核验服务费（本次免费）" : "Verification fee (free this time)") : zh ? "核验服务费" : "Verification fee";
  if (group === "gas") return zh ? "网络费用量" : "Network gas used";
  if (/refunded$/.test(label)) return zh ? "退回本金" : "Principal refunded";
  return zh ? "交易本金支出" : "Principal spent";
}

export function billRows(bill: Bill | null, assets: AssetLite[] | null, locale: Locale): BillRow[] {
  if (!bill) return [];
  const out: BillRow[] = [];
  const add = (group: BillGroup, lines: Bill["serviceFees"]) => lines.forEach((l, i) => {
    const free = /\(free\)\s*$/.test(l.label);
    let amount: BillRow["amount"] = null;
    if (group === "gas") amount = /^\d+$/.test(l.amountRaw) ? { kind: "units", value: l.amountRaw } : null;
    else if (l.amountUsd !== null && l.amountUsd !== undefined && l.amountUsd !== "") amount = { kind: "usd", value: l.amountUsd };
    else if (/^\d+$/.test(l.amountRaw)) {
      const u = unitOf(assets, l.asset);
      amount = { kind: "token", raw: l.amountRaw, decimals: u.decimals, symbol: u.symbol };
    }
    out.push({ key: `${group}:${i}:${l.label}`, group, label: billLabel(group, l.label, locale), amount, free, txHash: l.txHash });
  });
  add("fees", bill.serviceFees);
  add("principal", bill.principal);
  add("gas", bill.gas);
  return out;
}

export function billGroupTitle(group: BillGroup, locale: Locale): string {
  const zh = locale === "zh";
  return group === "fees" ? (zh ? "服务费" : "Service fees") : group === "principal" ? (zh ? "交易本金" : "Trade principal") : (zh ? "网络费" : "Network gas");
}
