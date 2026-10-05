/**
 * 卖出授权合约上限（v7 §2.4，D-092；运营者确认 2026-10-02 简化：可卖出全部持仓）：
 *   sellCapRaw = 委托时 owner 链上该股票余额（holdingsRaw，已有持仓）+ 预算在「价格腰斩」时能买到的份额（本任务最多可能买入的量）。
 * 股票代币最小单位，向上取整。下面是后一项（买入派生部分）：
 *
 *   budgetMicroUsd = budgetCapRaw × 10^(6 − stableDecimals)            （资金币种按 1 USD 计——宽松上界，不是估值）
 *   sellCapRaw     = ceil( budgetMicroUsd × 2 × 10^tokenDecimals / P6 )
 *   P6 = 建任务时该股票「100 USDG 档」可执行单价 × 1e6 取整；不可得 → failed{price_unavailable}
 *
 * 实现按整数分数一次算完（stableDecimals > 6 时不会先截断）：
 *   sellCapRaw = ceil( budgetCapRaw × 2 × 10^tokenDecimals × 10^6 / (P6 × 10^stableDecimals) )
 */
import type { DecimalString, RawAmount } from "../contracts";

export type SellCapResult = { ok: true; sellCapRaw: RawAmount; p6: string; boughtCapRaw: RawAmount; holdingsRaw: RawAmount } | { ok: false; code: "price_unavailable" | "invalid_input"; message: string };

/** holdingsRaw 缺省 0（旧调用方 = 只按买入派生）；服务端生成卖出草案时必须传链上余额 */
export function sellCapRaw(a: { budgetCapRaw: RawAmount; stableDecimals: number; tokenDecimals: number; p6: string | null | undefined; holdingsRaw?: RawAmount }): SellCapResult {
  if (a.p6 === null || a.p6 === undefined || !/^\d+$/.test(a.p6) || BigInt(a.p6) <= 0n) return { ok: false, code: "price_unavailable", message: "executable unit price (100 USDG tier) unavailable" };
  if (!/^\d+$/.test(a.budgetCapRaw) || !Number.isInteger(a.stableDecimals) || !Number.isInteger(a.tokenDecimals) || a.stableDecimals < 0 || a.tokenDecimals < 0 || a.stableDecimals > 36 || a.tokenDecimals > 36) return { ok: false, code: "invalid_input", message: "budgetCapRaw / decimals invalid" };
  const holdings = a.holdingsRaw ?? "0";
  if (!/^\d+$/.test(holdings)) return { ok: false, code: "invalid_input", message: "holdingsRaw invalid" };
  const num = BigInt(a.budgetCapRaw) * 2n * 10n ** BigInt(a.tokenDecimals) * 1_000_000n;
  const den = BigInt(a.p6) * 10n ** BigInt(a.stableDecimals);
  const q = num / den;
  const bought = num % den === 0n ? q : q + 1n;
  return { ok: true, sellCapRaw: (bought + BigInt(holdings)).toString(), p6: a.p6, boughtCapRaw: bought.toString(), holdingsRaw: holdings };
}

/** 十进制美元单价 → P6（×1e6 向下取整；≤ 0 或非法 → null） */
export function p6FromUsdPerShare(usd: DecimalString | null | undefined): string | null {
  if (typeof usd !== "string" || !/^\d+(\.\d+)?$/.test(usd)) return null;
  const [w, f = ""] = usd.split(".");
  const v = BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  return v > 0n ? v.toString() : null;
}
