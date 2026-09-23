/**
 * 条件求值的输入形态（interfaces §11.4）。类型本身在 contracts.ts（冻结）；这里只定义**求值输入**。
 * 所有输入都是显式数据：没有网络、没有时钟、没有 DB——同输入同结果（K-01）。
 */
import type { CtxStatus, DecimalString, IsoUtc, MarketContext, MarketEvent, RawAmount, ReferenceKind, ThesisStatus } from "../contracts";

export interface ConditionContextInput {
  /** 已验签的快照（字段 status 已按服务判定覆盖） */
  snapshot: MarketContext;
  /** 逐字段 status（含 "events" 伪字段） */
  fieldStatus: Record<string, CtxStatus>;
  evidenceId: string;
  receivedAt: IsoUtc;
}

export interface ConditionQuoteInput {
  evidenceIds: string[];
  /** 本步可执行单价（USD/股）；无 = 尚未取报价或不可换算 */
  executableUsdPerShare: DecimalString | null;
  referencePriceUsd: DecimalString | null;
  referenceKind: ReferenceKind | null;
  /** 可执行单价相对参考价（bps，正 = 链上更贵） */
  premiumBps: number | null;
}

export interface ConditionEvidence {
  /** null = 上下文不可达 / 验签失败（CONTEXT_UNAVAILABLE） */
  context: ConditionContextInput | null;
  /** 事件（含证据 id）；回放时调用方只放 firstKnownAt ≤ now 的版本 */
  events: Array<{ event: MarketEvent; evidenceId: string }>;
  /** 财报覆盖：underlyingId → 是否有财报日历覆盖；缺键 = 未知（EARNINGS_COVERAGE_UNKNOWN） */
  earningsCoverage: Record<string, boolean>;
  /** 本步报价 / 参考价（来自现有 prepare-step 报告）；null = 本轮尚未取证 */
  quote: ConditionQuoteInput | null;
  /** 链上余额（Lane C 组合快照）；缺键 = 未知 */
  balances: Record<string, { balanceRaw: RawAmount; evidenceId: string }>;
  /** 成本覆盖（Lane C）；缺键 = 未知 → TRACKED_COST_UNKNOWN */
  trackedCost: Record<string, { coverageBps: number; avgCostUsdPerShare: DecimalString | null; evidenceId: string }>;
  /** 理由卡状态；缺键 = 未知 */
  theses: Record<string, { status: ThesisStatus; evidenceIds: string[] }>;
}

export interface TaskConditionState {
  /** 任务涉及的标的（registry underlyingId） */
  underlyingIds: string[];
  /** 股票腿 assetKey（target/tracked_cost 用第一条腿） */
  outputAssetKeys: string[];
  mode: "LIVE" | "SIMULATION";
  /** 上一步**确认**（链上回执）的时刻；null = 尚无 */
  lastConfirmedStepAt: IsoUtc | null;
  /** 今日（纽约交易日）本任务已确认步数 */
  stepsConfirmedToday: number;
  /** 今日资金组已确认步数；null = 未知（无资金组 / Lane C 未就绪） */
  stepsConfirmedTodayInBudgetGroup: number | null;
  /** 下一步计划花费（cash_floor 用）；null = 未知 */
  nextStepAmountRaw: RawAmount | null;
}

export function emptyConditionEvidence(): ConditionEvidence {
  return { context: null, events: [], earningsCoverage: {}, quote: null, balances: {}, trackedCost: {}, theses: {} };
}
