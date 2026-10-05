/**
 * v7 任务持仓（开发计划 §0.5 勘误 #3、§2.4、§3.2 X7.4）：不建表，按需计算。
 * 口径与 PortfolioService.tracedFills 一致：本任务全部授权的 CONFIRMED 步骤，买入 +received、卖出 −spent（股票单位）；
 * sellableRaw = 链上余额（D-092 运营者确认 2026-10-02 简化：卖出上限 = 全部持仓，已有 + 本任务买入），< POSITION_DUST_RAW 视为 0；
 * netRaw（本任务买入 − 卖出）照旧给出，仅供参考（完成规则仍按它判断本任务买到的是否已卖完）。
 */
import { inArray, and, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyMandateSteps, verifyMandates } from "@chaconne/db";
import { findEntry, isRawAmount, type AssetRegistry, type EvmAddress } from "@chaconne/core/verify";
import type { MandateJson } from "../mandates/service";
import type { ServiceChain } from "../execution/chain";

export interface TaskPosition {
  assetKey: string;
  symbol: string;
  decimals: number;
  boughtRaw: string;
  soldRaw: string;
  netRaw: string;
  onchainRaw: string | null;
  sellableRaw: string;
  /** 买入成交的平均成本（资金币种 / 股），十进制串；无买入 = null */
  avgCostUsd: string | null;
  /** traced = 全部来自平台可追溯成交；onchain_unknown = 链上余额读不到 */
  coverage: "traced" | "onchain_unknown";
  fills: number;
}

function decimalDiv(num: bigint, den: bigint, scale = 6): string {
  if (den === 0n) return "0";
  const q = (num * 10n ** BigInt(scale)) / den;
  const s = q.toString().padStart(scale + 1, "0");
  const w = s.slice(0, -scale);
  const f = s.slice(-scale).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

export async function taskPositions(d: { db: Db; registry: AssetRegistry; chain: ServiceChain | null; dustRaw: bigint }, task: { ownerAddress: string; mandateIds: string[]; scopeJson: unknown }): Promise<TaskPosition[]> {
  const scope = task.scopeJson as { outputAssetKeys?: string[] } | null;
  const keys = new Set((scope?.outputAssetKeys ?? []).map((k) => k.toLowerCase()));
  const acc = new Map<string, { bought: bigint; sold: bigint; cost: bigint; costDecimals: number; fills: number }>();
  for (const k of keys) acc.set(k, { bought: 0n, sold: 0n, cost: 0n, costDecimals: 6, fills: 0 });
  if (task.mandateIds.length) {
    const mandates = await d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, task.mandateIds));
    const steps = await d.db.select().from(verifyMandateSteps).where(and(inArray(verifyMandateSteps.mandateId, task.mandateIds), eq(verifyMandateSteps.state, "CONFIRMED")));
    for (const s of steps) {
      const m = mandates.find((x) => x.id === s.mandateId);
      if (!m) continue;
      const mj = m.mandateJson as MandateJson;
      const ev = (s.receiptJson as { event?: { spent?: string; received?: string; outputToken?: string } } | null)?.event;
      if (!ev || !isRawAmount(ev.spent) || !isRawAmount(ev.received)) continue;
      const stockKey = mj.side === "sell" ? mj.legs[0]!.outputAssetKey : d.registry.entries.find((e) => e.tokenAddress.toLowerCase() === (s.stepJson as { step: { outputToken: string } }).step.outputToken.toLowerCase())?.assetKey;
      if (!stockKey) continue;
      const k = stockKey.toLowerCase();
      const a = acc.get(k) ?? { bought: 0n, sold: 0n, cost: 0n, costDecimals: 6, fills: 0 };
      const stable = findEntry(d.registry, mj.inputAssetKey);
      if (mj.side === "sell") a.sold += BigInt(ev.spent);
      else {
        a.bought += BigInt(ev.received);
        a.cost += BigInt(ev.spent);
        a.costDecimals = stable?.tokenDecimals ?? 6;
      }
      a.fills += 1;
      acc.set(k, a);
    }
  }
  const out: TaskPosition[] = [];
  for (const [k, a] of acc) {
    const e = findEntry(d.registry, k);
    if (!e) continue;
    const net = a.bought - a.sold > 0n ? a.bought - a.sold : 0n;
    let onchain: bigint | null = null;
    if (d.chain) onchain = await d.chain.balanceOf(e.tokenAddress as EvmAddress, task.ownerAddress as EvmAddress).catch(() => null);
    let sellable = onchain === null ? 0n : onchain;
    if (sellable < d.dustRaw) sellable = 0n;
    const avg = a.bought > 0n ? decimalDiv(a.cost * 10n ** BigInt(e.tokenDecimals), a.bought * 10n ** BigInt(a.costDecimals)) : null;
    out.push({ assetKey: k, symbol: e.displaySymbol, decimals: e.tokenDecimals, boughtRaw: a.bought.toString(), soldRaw: a.sold.toString(), netRaw: (net < d.dustRaw ? 0n : net).toString(), onchainRaw: onchain?.toString() ?? null, sellableRaw: sellable.toString(), avgCostUsd: avg, coverage: onchain === null ? "onchain_unknown" : "traced", fills: a.fills });
  }
  return out;
}
