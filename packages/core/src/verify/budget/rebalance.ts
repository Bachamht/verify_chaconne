/**
 * 调仓编排（C3 第五个模板 `portfolio_rebalance`，Y-07）：
 *   当前持仓（含未知成本 / 未知价格）+ 目标权重 + 现金下限 → 各腿（**先卖后买**）、顺序、预计部分完成情形。
 * 纯函数、不签任何东西。买入腿金额只是**预估**：卖出腿链上确认后，服务侧按真实现金余额重算买力再出买入腿授权草案。
 * 美元用 8 位定点（USD8）；资金币按 1 USD 计（稳定币，登记表 usdPegSource 已核验）。
 */
import type { RawAmount } from "../contracts";
import { decimalToFixed, fixedToDecimal, parseRaw } from "../amounts";

const USD_SCALE = 8;

export interface RebalanceHolding {
  assetKey: string;
  balanceRaw: RawAmount;
  decimals: number;
  /** 每代币美元价（十进制串）；未知 null → 该资产不能规划，列入 unknownPriceAssets */
  priceUsd: string | null;
  /** 成本覆盖率 bps（组合视图给出）；null = 未知。只影响说明，不影响腿 */
  costCoverageBps: number | null;
}

export interface RebalanceCash {
  assetKey: string;
  balanceRaw: RawAmount;
  decimals: number;
}

export interface RebalanceTarget {
  assetKey: string;
  weightBps: number;
}

export interface RebalanceInput {
  holdings: RebalanceHolding[];
  cash: RebalanceCash;
  cashFloorRaw: RawAmount;
  targets: RebalanceTarget[];
  /** 小于此美元额的腿忽略（默认 1 USD） */
  minLegUsd?: string;
}

export interface RebalanceLeg {
  legIndex: number;
  side: "sell" | "buy";
  assetKey: string;
  /** 卖出：股票代币最小单位；买入：资金币最小单位（预估，确认卖出后重算） */
  amountRaw: RawAmount;
  estUsd: string;
  /** 执行顺序：全部卖出腿在前 */
  order: number;
  currentUsd: string;
  targetUsd: string;
  note: string | null;
}

export interface RebalancePreview {
  legs: RebalanceLeg[];
  totalUsd: string;
  /** 可投资 = 总值 − 现金下限（含现有股票市值） */
  investableUsd: string;
  cashUsd: string;
  cashFloorUsd: string;
  /** 卖出全部确认后预计现金（用于买入腿预估）；真实买力以链上余额为准 */
  projectedCashAfterSellsUsd: string;
  /** 买入腿是否因预计现金不足而被等比缩减 */
  buysScaled: boolean;
  unknownPriceAssets: string[];
  /** 预计部分完成情形（文案只描述规则，不预测涨跌） */
  partialOutcomes: string[];
}

function usdOf(raw: bigint, decimals: number, priceUsd: string): bigint {
  const p = decimalToFixed(priceUsd, USD_SCALE);
  return (raw * p) / 10n ** BigInt(decimals);
}
function rawOfUsd(usd8: bigint, decimals: number, priceUsd: string): bigint {
  const p = decimalToFixed(priceUsd, USD_SCALE);
  if (p <= 0n) return 0n;
  return (usd8 * 10n ** BigInt(decimals)) / p;
}
const dec = (v: bigint) => fixedToDecimal(v, USD_SCALE);

export function planRebalance(input: RebalanceInput): RebalancePreview {
  const weightSum = input.targets.reduce((s, t) => s + t.weightBps, 0);
  if (weightSum > 10_000) throw new Error("目标权重合计不得超过 10000 bps");
  for (const t of input.targets) if (!Number.isInteger(t.weightBps) || t.weightBps < 0) throw new Error(`非法权重 ${t.assetKey}`);
  const minLeg = decimalToFixed(input.minLegUsd ?? "1", USD_SCALE);
  const cashRaw = parseRaw(input.cash.balanceRaw);
  const cashUsd = (cashRaw * 10n ** BigInt(USD_SCALE)) / 10n ** BigInt(input.cash.decimals);
  const floorUsd = (parseRaw(input.cashFloorRaw) * 10n ** BigInt(USD_SCALE)) / 10n ** BigInt(input.cash.decimals);

  const unknownPriceAssets: string[] = [];
  const priced = new Map<string, { h: RebalanceHolding; usd: bigint }>();
  for (const h of input.holdings) {
    if (h.priceUsd === null) {
      unknownPriceAssets.push(h.assetKey);
      continue;
    }
    priced.set(h.assetKey, { h, usd: usdOf(parseRaw(h.balanceRaw), h.decimals, h.priceUsd) });
  }
  const targetsMissingPrice = input.targets.filter((t) => t.weightBps > 0 && !priced.has(t.assetKey) && !input.holdings.some((h) => h.assetKey === t.assetKey));
  // 目标里出现但没持仓且没给价格 → 无法规划买入
  for (const t of targetsMissingPrice) unknownPriceAssets.push(t.assetKey);

  let total = cashUsd;
  for (const { usd } of priced.values()) total += usd;
  const investable = total - floorUsd > 0n ? total - floorUsd : 0n;

  const sells: RebalanceLeg[] = [];
  const buys: Array<Omit<RebalanceLeg, "legIndex" | "order">> = [];
  const targetOf = new Map(input.targets.map((t) => [t.assetKey, t.weightBps] as const));
  // 卖出：当前 > 目标（目标不含 → 0）
  for (const [assetKey, { h, usd }] of priced) {
    const targetUsd = (investable * BigInt(targetOf.get(assetKey) ?? 0)) / 10_000n;
    if (usd > targetUsd && usd - targetUsd >= minLeg) {
      const diff = usd - targetUsd;
      const amount = targetUsd === 0n ? parseRaw(h.balanceRaw) : rawOfUsd(diff, h.decimals, h.priceUsd!);
      sells.push({ legIndex: 0, order: 0, side: "sell", assetKey, amountRaw: amount.toString(), estUsd: dec(diff), currentUsd: dec(usd), targetUsd: dec(targetUsd), note: h.costCoverageBps !== null && h.costCoverageBps < 10_000 ? `cost_coverage_${h.costCoverageBps}bps` : null });
    }
  }
  const sellProceeds = sells.reduce((s, l) => s + decimalToFixed(l.estUsd, USD_SCALE), 0n);
  const projectedCash = cashUsd + sellProceeds;
  // 买入：目标 > 当前
  for (const t of input.targets) {
    if (t.weightBps === 0 || unknownPriceAssets.includes(t.assetKey)) continue;
    const cur = priced.get(t.assetKey)?.usd ?? 0n;
    const targetUsd = (investable * BigInt(t.weightBps)) / 10_000n;
    if (targetUsd > cur && targetUsd - cur >= minLeg) {
      const diff = targetUsd - cur;
      buys.push({ side: "buy", assetKey: t.assetKey, amountRaw: "0", estUsd: dec(diff), currentUsd: dec(cur), targetUsd: dec(targetUsd), note: null });
    }
  }
  // 买力：预计现金 − 下限；不足则等比缩减（真实买力在卖出确认后重算）
  const buyingPower = projectedCash - floorUsd > 0n ? projectedCash - floorUsd : 0n;
  const wanted = buys.reduce((s, b) => s + decimalToFixed(b.estUsd, USD_SCALE), 0n);
  const buysScaled = wanted > buyingPower;
  const legs: RebalanceLeg[] = [];
  sells.sort((a, b) => (a.assetKey < b.assetKey ? -1 : 1)).forEach((l, i) => legs.push({ ...l, legIndex: i, order: i }));
  let idx = legs.length;
  for (const b of buys) {
    let usd = decimalToFixed(b.estUsd, USD_SCALE);
    if (buysScaled) usd = wanted === 0n ? 0n : (usd * buyingPower) / wanted;
    if (usd < minLeg) continue;
    const amountRaw = (usd * 10n ** BigInt(input.cash.decimals)) / 10n ** BigInt(USD_SCALE);
    legs.push({ ...b, legIndex: idx, order: idx, estUsd: dec(usd), amountRaw: amountRaw.toString(), note: buysScaled ? "scaled_to_projected_buying_power" : null });
    idx += 1;
  }

  const partialOutcomes: string[] = [];
  if (sells.length > 0) partialOutcomes.push("Sell legs execute first; each is a separate authorization and can fail independently. A failed sell leg leaves that holding unchanged and marks the plan PARTIAL.");
  if (legs.some((l) => l.side === "buy")) partialOutcomes.push("Buy legs are re-sized from the real on-chain cash balance after sell legs are confirmed; if cash is lower than projected they are scaled down, never funded from estimated proceeds.");
  if (buysScaled) partialOutcomes.push("Projected cash after sells is below the total of buy legs; buys are scaled proportionally so the cash floor is kept.");
  if (unknownPriceAssets.length > 0) partialOutcomes.push(`No price for ${unknownPriceAssets.join(", ")}: those assets are left untouched and not counted in the total.`);
  if (input.holdings.some((h) => h.costCoverageBps !== null && h.costCoverageBps < 10_000)) partialOutcomes.push("Some holdings have unknown cost for part of the balance; rebalance uses balances, not cost.");
  partialOutcomes.push("The plan does not promise an atomic return to the target weights.");

  return { legs, totalUsd: dec(total), investableUsd: dec(investable), cashUsd: dec(cashUsd), cashFloorUsd: dec(floorUsd), projectedCashAfterSellsUsd: dec(projectedCash), buysScaled, unknownPriceAssets: [...new Set(unknownPriceAssets)], partialOutcomes };
}

/** 卖出确认后的买力重算：真实现金余额 − 下限；按各买入腿原预估等比分配（不拿预估收入启动买入） */
export function recomputeBuys(buyLegs: readonly Pick<RebalanceLeg, "legIndex" | "estUsd">[], cashBalanceRaw: RawAmount, cashDecimals: number, cashFloorRaw: RawAmount): Array<{ legIndex: number; amountRaw: RawAmount; estUsd: string; scaled: boolean }> {
  const power = parseRaw(cashBalanceRaw) - parseRaw(cashFloorRaw);
  const available = power > 0n ? power : 0n;
  const wantedUsd = buyLegs.reduce((s, b) => s + decimalToFixed(b.estUsd, USD_SCALE), 0n);
  const wantedRaw = (wantedUsd * 10n ** BigInt(cashDecimals)) / 10n ** BigInt(USD_SCALE);
  const scaled = wantedRaw > available;
  return buyLegs.map((b) => {
    const usd = decimalToFixed(b.estUsd, USD_SCALE);
    const raw0 = (usd * 10n ** BigInt(cashDecimals)) / 10n ** BigInt(USD_SCALE);
    const raw = scaled ? (wantedRaw === 0n ? 0n : (raw0 * available) / wantedRaw) : raw0;
    return { legIndex: b.legIndex, amountRaw: raw.toString(), estUsd: dec((raw * 10n ** BigInt(USD_SCALE)) / 10n ** BigInt(cashDecimals)), scaled };
  });
}
