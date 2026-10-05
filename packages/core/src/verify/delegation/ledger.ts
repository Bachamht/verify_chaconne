/**
 * 额度账本（v7 §2.3，D-091）：同一 (owner, token, spender = PlanGuard)。permit 是「设置」不是累加，所以 value 必须覆盖
 * 该 owner 在这个代币上所有未终结授权的剩余额度 + 本任务尚未登记的草案。
 *
 *   requiredRaw = Σ_{m ∈ 未终结授权（DRAFT / ACTIVE / PAUSED）, m.token = token} max(0, budgetCap_m − spent_m)
 *               + Σ_{d ∈ 本任务未登记草案, d.token = token} budgetCap_d
 *   permitValue = requiredRaw + ceil(requiredRaw × 50 / 10_000)        （+0.5%：吸收退款与 rebasing 舍入）
 *   链上额度 ≥ requiredRaw → 该 permit 项 not_needed
 *
 * token = PlanGuard 实际拉取的代币（买入 = 资金币种；卖出 = 股票），卖出授权因此按股票单位独立记账。
 */
import { PERMIT_HEADROOM_BPS, type EvmAddress, type MandateState, type RawAmount } from "../contracts";

export const UNFINISHED_MANDATE_STATES: readonly MandateState[] = ["DRAFT", "ACTIVE", "PAUSED"];

export interface LedgerMandate {
  mandateId: string;
  /** = PlanGuard 拉取的代币（verify_mandates.asset_key 对应的代币地址） */
  token: EvmAddress;
  state: MandateState | string;
  budgetCap: RawAmount;
  /** 链上 mandateState 镜像 */
  spent: RawAmount;
}
export interface LedgerDraft {
  id: string;
  token: EvmAddress;
  budgetCap: RawAmount;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function requiredAllowance(mandates: readonly LedgerMandate[], drafts: readonly LedgerDraft[], token: EvmAddress): RawAmount {
  let sum = 0n;
  for (const m of mandates) {
    if (!same(m.token, token) || !UNFINISHED_MANDATE_STATES.includes(m.state as MandateState)) continue;
    const left = BigInt(m.budgetCap) - BigInt(m.spent);
    if (left > 0n) sum += left;
  }
  for (const d of drafts) if (same(d.token, token)) sum += BigInt(d.budgetCap);
  return sum.toString();
}

/** permitValue = required + ceil(required × 50 / 10_000) */
export function permitValue(required: RawAmount): RawAmount {
  const r = BigInt(required);
  if (r < 0n) throw new Error("required 不能为负");
  const headroom = (r * BigInt(PERMIT_HEADROOM_BPS) + 9_999n) / 10_000n;
  return (r + headroom).toString();
}

/** 链上额度已 ≥ required → 不需要 permit（required = 0 时也不需要） */
export function permitNeeded(onchainRaw: RawAmount, required: RawAmount): boolean {
  return BigInt(onchainRaw) < BigInt(required);
}

/** 收回额度（purpose = reclaim）：value = 其余未终结授权的需要量；有需要量时 + 0.5%，没有则为 0 */
export function reclaimValue(requiredOthers: RawAmount): RawAmount {
  return BigInt(requiredOthers) > 0n ? permitValue(requiredOthers) : "0";
}

/** 任务终结后是否提示「收回多余额度」（非阻塞）：链上额度 > 需要量 + 0.5% */
export function reclaimSuggested(onchainRaw: RawAmount, required: RawAmount): boolean {
  return BigInt(onchainRaw) > BigInt(permitValue(required));
}
