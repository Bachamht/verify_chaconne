/**
 * 组合成本口径（C4，Q-02 / Q-04）：成本只覆盖平台可追溯的数量；外部转入/转出的部分明确未知；
 * 发行商乘数（rebasing 份额记账）调整用登记表 / 链上 ratio 证据换算并标注。纯函数。
 */
import type { RawAmount } from "../contracts";
import { decimalToFixed, parseRaw } from "../amounts";

export interface CostCoverage {
  balanceRaw: RawAmount;
  /** 平台可追溯的数量（已按乘数换算后） */
  tracedQtyRaw: RawAmount;
  /** 覆盖率 = min(traced, balance) / balance，bps；余额 0 → null */
  coverageBps: number | null;
  /** 余额中无法追溯成本的部分（外部转入等） */
  unknownQtyRaw: RawAmount;
  /** 追溯量超过余额的部分（外部转出 / 未经平台的卖出），成本按余额比例保留 */
  externalOutflowRaw: RawAmount;
}

export function costCoverage(balanceRaw: RawAmount, tracedQtyRaw: RawAmount): CostCoverage {
  const balance = parseRaw(balanceRaw);
  const traced = parseRaw(tracedQtyRaw);
  const covered = traced < balance ? traced : balance;
  const coverageBps = balance === 0n ? null : Number((covered * 10_000n) / balance);
  return { balanceRaw, tracedQtyRaw, coverageBps, unknownQtyRaw: (balance - covered).toString(), externalOutflowRaw: (traced > balance ? traced - balance : 0n).toString() };
}

export interface RatioAdjustment {
  qtyRaw: RawAmount;
  adjustedQtyRaw: RawAmount;
  ratioAtFill: string;
  ratioNow: string;
  changed: boolean;
}

/**
 * 乘数调整（Q-04）：成交时记录的数量按当时乘数是「余额口径」；乘数变化后，同样的份额对应的余额 = qty × ratioNow / ratioAtFill。
 * 两个乘数任一缺失 → 不调整（调用方须标注 ratio_unknown）。
 */
export function adjustForRatio(qtyRaw: RawAmount, ratioAtFill: string | null, ratioNow: string | null, scale = 18): RatioAdjustment | null {
  if (!ratioAtFill || !ratioNow) return null;
  const a = decimalToFixed(ratioAtFill, scale);
  const b = decimalToFixed(ratioNow, scale);
  if (a <= 0n || b <= 0n) return null;
  const adjusted = (parseRaw(qtyRaw) * b) / a;
  return { qtyRaw, adjustedQtyRaw: adjusted.toString(), ratioAtFill, ratioNow, changed: a !== b };
}

export interface TracedFill {
  /** 平台成交：买入 qty 为正、卖出为负 */
  qtyRaw: RawAmount;
  /** 对应付出（买入）或收到（卖出）的资金币最小单位 */
  inputRaw: RawAmount;
  side: "buy" | "sell";
}

/** 按成交序列汇总：净持有量与净成本（卖出按平均成本减少） */
export function aggregateFills(fills: readonly TracedFill[]): { tracedQtyRaw: RawAmount; costRaw: RawAmount } {
  let qty = 0n;
  let cost = 0n;
  for (const f of fills) {
    const q = parseRaw(f.qtyRaw);
    const v = parseRaw(f.inputRaw);
    if (f.side === "buy") {
      qty += q;
      cost += v;
    } else {
      // 卖出：按平均成本冲减；卖超（外部转入后再卖）只减到 0
      const sellQty = q > qty ? qty : q;
      const avgCost = qty > 0n ? (cost * sellQty) / qty : 0n;
      qty -= sellQty;
      cost -= avgCost;
    }
  }
  return { tracedQtyRaw: qty.toString(), costRaw: cost.toString() };
}
