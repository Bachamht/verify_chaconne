/**
 * 委托清单每一项的人话说明（v7 §3.5 P2 示例口径）：这次签名允许什么、不允许什么（金额、合约、期限、能否撤回）。
 * 只描述签名本身的约束；不承诺收益、不夸大（PlanGuard 只约束经它的交易）。
 */
import { formatUnits } from "../amounts";
import type { EvmAddress, IsoUtc, RawAmount } from "../contracts";
import type { ChecklistText } from "./checklist";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const day = (iso: IsoUtc) => iso.slice(0, 10);

export function explainBuyMandate(a: { stableSymbol: string; stableDecimals: number; budgetCapRaw: RawAmount; perStepCapRaw: RawAmount; maxSteps: number; stockSymbols: string[]; deadline: IsoUtc; planGuard: EvmAddress }): ChecklistText {
  const budget = formatUnits(a.budgetCapRaw, a.stableDecimals);
  const per = formatUnits(a.perStepCapRaw, a.stableDecimals);
  const stocks = a.stockSymbols.join(" / ");
  return {
    title: { zh: "买入授权", en: "Buy authorization" },
    explain: {
      zh: `允许在 ${day(a.deadline)} 前用最多 ${budget} ${a.stableSymbol}、每笔最多 ${per} ${a.stableSymbol}、最多 ${a.maxSteps} 笔买入 ${stocks}；只经 PlanGuard 合约 ${short(a.planGuard)}；买到的股票只进你的钱包；可随时链上撤销。这是签名，不是交易。`,
      en: `Allows buying ${stocks} with at most ${budget} ${a.stableSymbol} in total, at most ${per} ${a.stableSymbol} per trade and at most ${a.maxSteps} trades, until ${day(a.deadline)}; only through the PlanGuard contract ${short(a.planGuard)}; bought shares go to your wallet only; revocable on-chain at any time. This is a signature, not a transaction.`,
    },
  };
}

export function explainSellMandate(a: { stockSymbol: string; stockDecimals: number; stableSymbol: string; sellCapRaw: RawAmount | null; deadline: IsoUtc; planGuard: EvmAddress }): ChecklistText {
  const cap = a.sellCapRaw ? formatUnits(a.sellCapRaw, a.stockDecimals) : "?";
  return {
    title: { zh: `卖出授权 · ${a.stockSymbol}`, en: `Sell authorization · ${a.stockSymbol}` },
    explain: {
      zh: `允许在到期前按策略把 ${a.stockSymbol} 换回 ${a.stableSymbol}，最多可卖出你的全部持仓；换回的 ${a.stableSymbol} 只进你的钱包。到期 ${day(a.deadline)}；合约上限 ${cap} 股（你签的，= 你现有持仓 + 本任务最多可能买入的量）；只经 PlanGuard 合约 ${short(a.planGuard)}；可随时链上撤销。`,
      en: `Allows converting ${a.stockSymbol} back to ${a.stableSymbol} before the deadline as the strategy says, up to your full holdings; the ${a.stableSymbol} goes to your wallet only. Deadline ${day(a.deadline)}; contract cap ${cap} shares (what you sign = your current holdings + the most this task could buy); only through PlanGuard ${short(a.planGuard)}; revocable on-chain at any time.`,
    },
  };
}

export function explainPermit(a: { symbol: string; decimals: number; valueRaw: RawAmount | null; requiredRaw: RawAmount; planGuard: EvmAddress }): ChecklistText {
  const v = formatUnits(a.valueRaw ?? a.requiredRaw, a.decimals);
  return {
    title: { zh: `额度签名 · ${a.symbol}`, en: `Allowance signature · ${a.symbol}` },
    explain: {
      zh: `允许 PlanGuard（${short(a.planGuard)}）最多动用 ${v} ${a.symbol}（含 0.5% 舍入余量）。这是签名，不是交易，不花 gas；由平台执行身份代付上链。PlanGuard 只能在你签过的授权范围内使用这笔额度；可随时收回。`,
      en: `Allows PlanGuard (${short(a.planGuard)}) to use up to ${v} ${a.symbol} (includes a 0.5% rounding margin). This is a signature, not a transaction, and costs no gas; the platform's executor submits it. PlanGuard can only use it inside the authorizations you signed; you can reclaim it at any time.`,
    },
  };
}
