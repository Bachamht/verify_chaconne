/**
 * C5 夜班日志（Recap）类型（Lane F）。页面（api-v2.ts 的 v6 段）与 SDK 镜像同一形状；
 * 若冻结进 contracts.ts 需走 CV-D。金额十进制字符串；时间 ISO-8601 UTC。
 */

/** 模拟 / 回放 / 真实三种标识（R-03）；FIXTURE 只在夹具证据模式出现，绝不标成 LIVE */
export type RecapMode = "LIVE" | "SIMULATION" | "REPLAY" | "FIXTURE";
export type RecapCoverage = "ok" | "unavailable";

export interface RecapReason {
  code: string;
  text: string;
}
export interface RecapTaskLine {
  /** mandate id（v5 授权计划）或 task id（v6 任务） */
  refId: string;
  refKind: "mandate" | "task";
  label: string;
  status: string;
  mode: RecapMode;
  steps: { done: number; max: number };
  blockers: RecapReason[];
  nextCheckAt: string | null;
}
export interface RecapWaitLine {
  refId: string;
  label: string;
  reasons: RecapReason[];
  evaluations: number;
  nextCheckAt: string | null;
}
export interface RecapTrade {
  at: string;
  refId: string;
  stepIndex: number;
  side: "buy" | "sell";
  inputAssetKey: string;
  outputAssetKey: string;
  amountInRaw: string;
  receivedRaw: string | null;
  txHash: string | null;
  state: string;
  mode: RecapMode;
}
export interface RecapRemaining {
  refId: string;
  label: string;
  stepsLeft: number;
  deadline: string;
}
export interface RecapDecision {
  refId: string;
  label: string;
  code: string;
  text: string;
  /** 页面动作：resume | authorize | extend | revoke | review */
  action: string;
}
export interface RecapLedgerLine {
  assetKey: string;
  spentRaw: string;
  receivedRaw: string;
  steps: number;
}
export interface RecapTimelineEntry {
  at: string;
  refId: string;
  type: "status" | "evaluation" | "step_confirmed" | "step_reverted" | "step_issued";
  text: string;
  assetKey?: string;
  amountRaw?: string;
  receivedRaw?: string;
  txHash?: string | null;
}
/** 个人里程碑：只按可核对的行为（R-05），每条带证据指针 */
export interface RecapMilestone {
  id: "first_simulation" | "first_authorization" | "first_step_confirmed" | "first_full_completion";
  label: { en: string; zh: string };
  at: string;
  evidence: { refId: string; txHash?: string | null };
}
/** 可翻创任务目录：只带结构，不带金额/钱包（Y-08） */
export interface RecapRemixable {
  refId: string;
  refKind: "mandate" | "task";
  structure: { side: "buy" | "sell"; inputAssetKey: string; outputAssetKeys: string[]; policyId?: string; steps: number };
  remixHref: string;
}
export interface RecapShare {
  public: boolean;
  hideAssets: boolean;
  hideAmounts: boolean;
  shareId: string | null;
  publicUrl: string | null;
}

export interface Recap {
  id: string;
  owner: string;
  /** 纽约本地交易日 */
  date: string;
  tz: "America/New_York";
  /** 实际收盘时刻（含提前收盘）与生成门槛（收盘 + 45 min），UTC */
  closeAtUtc: string;
  earlyClose: boolean;
  generateAfterUtc: string;
  generatedAt: string;
  /** 本日涉及的证据模式集合（R-03） */
  modes: RecapMode[];
  coverage: { mandates: RecapCoverage; tasks: RecapCoverage; events: RecapCoverage };
  sections: {
    handled: RecapTaskLine[];
    waited: RecapWaitLine[];
    trades: RecapTrade[];
    remaining: RecapRemaining[];
    decisions: RecapDecision[];
  };
  /** 账目与时间线一致（R-02）：每资产 spentRaw = Σ timeline.step_confirmed.amountRaw */
  ledger: RecapLedgerLine[];
  timeline: RecapTimelineEntry[];
  milestones: RecapMilestone[];
  remixable: RecapRemixable[];
  share: RecapShare;
}

/** 生成门槛未到时的占位（不是假数据） */
export interface RecapPending {
  status: "pending";
  owner: string;
  date: string;
  tz: "America/New_York";
  closeAtUtc: string | null;
  earlyClose: boolean;
  generateAfterUtc: string | null;
  tradingDay: boolean;
  note: string;
}
