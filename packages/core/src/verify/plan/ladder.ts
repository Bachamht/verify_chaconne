/**
 * 金额阶梯（确定性）：每腿 × 每资金币种 × ladderBps。
 * 预算按 inputAssetKeys[0] 的最小单位给出；其它资金币种按 decimals 差换算（稳定币按 1:1 面值近似，只用于报价探测；
 * 真实 USD 口径由证据 stablecoin_usd 决定）。
 */
import { keccak256Utf8 } from "../canonical";
import { DEFAULT_LADDER_BPS, PLAN_MAX_CANDIDATES, PLAN_MAX_QUOTES_PER_LEG, type AssetRegistry, type PlanGoal } from "../contracts";
import { findEntry } from "../registry";
import type { PlanCandidateSpec } from "./types";

export function candidateId(legIndex: number, ladderBps: number, inputAssetKey: string): string {
  return `cand_${legIndex}_${ladderBps}_${keccak256Utf8(inputAssetKey).slice(2, 10)}`;
}

/** amount × bps / 10000，向下取整 */
export function scaleBps(amountRaw: string, bps: number): string {
  if (!/^\d+$/.test(amountRaw)) throw new Error(`非法金额: ${amountRaw}`);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`非法 bps: ${bps}`);
  return ((BigInt(amountRaw) * BigInt(bps)) / 10_000n).toString();
}

function rescaleDecimals(amountRaw: string, fromDecimals: number, toDecimals: number): string {
  const v = BigInt(amountRaw);
  if (toDecimals >= fromDecimals) return (v * 10n ** BigInt(toDecimals - fromDecimals)).toString();
  return (v / 10n ** BigInt(fromDecimals - toDecimals)).toString();
}

export interface LadderOptions {
  maxCandidates?: number;
  maxQuotesPerLeg?: number;
}

/**
 * 生成候选清单。阶梯从大到小；先保证每腿 quote 数 ≤ maxQuotesPerLeg（截掉最小阶梯），
 * 再保证总候选 ≤ maxCandidates（逐轮去掉各腿最小阶梯）。零金额候选丢弃。
 */
export function buildLadder(goal: PlanGoal, registry: AssetRegistry, opts: LadderOptions = {}): PlanCandidateSpec[] {
  const maxCandidates = opts.maxCandidates ?? PLAN_MAX_CANDIDATES;
  const maxQuotesPerLeg = opts.maxQuotesPerLeg ?? PLAN_MAX_QUOTES_PER_LEG;
  const ladder = [...new Set(goal.ladderBps ?? [...DEFAULT_LADDER_BPS])].filter((b) => Number.isInteger(b) && b > 0 && b <= 10_000).sort((a, b) => b - a);
  if (ladder.length === 0) throw new Error("ladderBps 为空");
  if (goal.legs.length === 0) throw new Error("legs 为空");
  if (goal.budget.inputAssetKeys.length === 0) throw new Error("inputAssetKeys 为空");
  const totalWeight = goal.legs.reduce((n, l) => n + l.weightBps, 0);
  if (totalWeight !== 10_000) throw new Error(`legs.weightBps 之和必须为 10000，实际 ${totalWeight}`);
  const baseKey = goal.budget.inputAssetKeys[0]!;
  const baseEntry = findEntry(registry, baseKey);
  const baseDecimals = baseEntry?.tokenDecimals ?? null;

  // 每腿允许的阶梯长度：inputs × ladderLen ≤ maxQuotesPerLeg
  const inputs = goal.budget.inputAssetKeys;
  let perLegLadder = ladder.slice(0, Math.max(1, Math.floor(maxQuotesPerLeg / inputs.length)));
  // 总候选上限：legs × inputs × ladderLen ≤ maxCandidates
  while (perLegLadder.length > 1 && goal.legs.length * inputs.length * perLegLadder.length > maxCandidates) perLegLadder = perLegLadder.slice(0, -1);

  const specs: PlanCandidateSpec[] = [];
  goal.legs.forEach((leg, legIndex) => {
    const legBudget = scaleBps(goal.budget.amountInRaw, leg.weightBps);
    for (const inputAssetKey of inputs) {
      const entry = findEntry(registry, inputAssetKey);
      const legBudgetIn = entry && baseDecimals !== null ? rescaleDecimals(legBudget, baseDecimals, entry.tokenDecimals) : legBudget;
      for (const bps of perLegLadder) {
        const amountInRaw = scaleBps(legBudgetIn, bps);
        if (BigInt(amountInRaw) <= 0n) continue;
        specs.push({ candidateId: candidateId(legIndex, bps, inputAssetKey), legIndex, inputAssetKey, outputAssetKey: leg.outputAssetKey, amountInRaw, ladderBps: bps, weightBps: leg.weightBps });
      }
    }
  });
  return specs.slice(0, maxCandidates);
}

/**
 * 可选二分：在 [lo, hi] 内找"不利冲击 ≤ capBps 的最大金额"。probe 返回 null = 冲击未知（当作超限）。
 * 探测次数严格 ≤ maxProbes（默认 PLAN_MAX_QUOTES_PER_LEG）。返回 null = 连 lo 都不满足。
 */
export async function bisectMaxAmount(args: {
  lo: string;
  hi: string;
  capBps: number;
  probe: (amountRaw: string) => Promise<number | null>;
  maxProbes?: number;
}): Promise<{ amountRaw: string; adverseImpactBps: number; probes: number } | null> {
  const maxProbes = args.maxProbes ?? PLAN_MAX_QUOTES_PER_LEG;
  let lo = BigInt(args.lo);
  let hi = BigInt(args.hi);
  if (lo <= 0n || hi < lo) throw new Error("二分区间非法");
  let probes = 0;
  let best: { amountRaw: string; adverseImpactBps: number } | null = null;
  const ok = async (x: bigint) => {
    probes += 1;
    const bps = await args.probe(x.toString());
    return bps !== null && bps <= args.capBps ? bps : null;
  };
  // 先试 hi（最常见：整笔可行）
  const hiBps = await ok(hi);
  if (hiBps !== null) return { amountRaw: hi.toString(), adverseImpactBps: hiBps, probes };
  if (probes >= maxProbes) return null;
  const loBps = await ok(lo);
  if (loBps === null) return null;
  best = { amountRaw: lo.toString(), adverseImpactBps: loBps };
  while (probes < maxProbes && hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const bps = await ok(mid);
    if (bps !== null) {
      lo = mid;
      best = { amountRaw: mid.toString(), adverseImpactBps: bps };
    } else hi = mid;
  }
  return { ...best, probes };
}
