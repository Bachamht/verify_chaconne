/**
 * Lane E · 决策实验（C9）：注入接口与快照形态。
 *
 * 冻结类型（ConditionSet / ConditionEvaluation / Blocker / PolicyComparison / ReplayRun）全部来自 contracts.ts，
 * 本文件只定义 Lane E 与 Lane B 的**接缝**：条件求值器与任务读取器都是注入的，core/lab 不实现完整 DSL。
 *
 * 给 Lane B 对齐（interfaces §11.4 / §11.5）：
 *  - `ConditionEvaluator.evaluate(set, evidence, taskState, now)` 与冻结签名一致；`evidence` 的形态见 `ConditionEvidenceInput`
 *    （规范化证据记录 + 已验签的上下文快照 + 事件版本），因为 `market_context` 证据 payload 只含哈希与逐字段 status，不含数值。
 *  - `ConditionTaskState` 是求值需要的最小任务状态；B 的正式 taskState 只要是它的超集即可直接传入。
 */
import type { Bytes32, ConditionEvaluation, ConditionSet, EvidenceRecord, IsoUtc, MarketContext, MarketEvent, PlanGoal, Task } from "../contracts";

/** 求值输入：三类来源分开给，求值器自己决定用哪些；缺什么就写 null / 空数组，绝不补值 */
export interface ConditionEvidenceInput {
  /** verify_evidence 规范化记录（okx_quote / pyth_reference / market_context / market_event …） */
  records: EvidenceRecord[];
  /** 已验签的上下文快照；取不到 → null（依赖它的条件 → INSUFFICIENT_EVIDENCE / CONTEXT_UNAVAILABLE） */
  context: MarketContext | null;
  /** 事件版本集合：同一 id 只给"当前可知"的那一版（回放时按 firstKnownAt ≤ t 选） */
  events: MarketEvent[];
}

/** 求值需要的最小任务状态（B 的正式 taskState 应是其超集） */
export interface ConditionTaskState {
  /** 上一步**确认**（链上回执）的时刻；无 → null */
  lastConfirmedStepAt: IsoUtc | null;
  /** 今日（纽约交易日）已确认步数 */
  stepsConfirmedToday: number;
  /** 本任务已确认总步数 */
  stepsConfirmed: number;
}

/** 条件求值器（Lane B 的 evaluateConditions 包一层即可） */
export interface ConditionEvaluator {
  /** 标识：`reference`（Lane E 参考实现）或 B 的正式实现名；进响应体，方便识别 */
  readonly id: string;
  evaluate(set: ConditionSet, evidence: ConditionEvidenceInput, taskState: ConditionTaskState, now: IsoUtc): ConditionEvaluation;
}

/**
 * 证据快照（对照 compare-policies 固定的输入）：最近一次评估的证据集合 + 上下文快照 + 事件版本。
 * `id` 由内容哈希派生（`snap_` + hash 前 24 hex），同一证据 → 同一 id，可复算（L-02）。
 */
export interface EvidenceSnapshot {
  id: string;
  taskId: string;
  /** 快照对应的评估时刻（= 最近一次评估的 evaluatedAt） */
  takenAt: IsoUtc;
  records: EvidenceRecord[];
  context: MarketContext | null;
  /** 事件版本钉死：evaluate 用这些版本，不再取新修订 */
  events: MarketEvent[];
  /** keccak256(canonical({takenAt, evidenceIds, contextHash, eventVersions})) */
  hash: Bytes32;
}

/** 任务读取（Lane B 的 tasks 表；合并前 Lane E 用内存实现） */
export interface LabTaskRecord {
  task: Task;
  /** 建任务的调用方（API key 派生），owner 鉴权用：callerId 相同或 owner 地址相同才可读 */
  callerId: string;
  taskState: ConditionTaskState;
  /** 规划器目标（同资产/资金基准/费用假设由它固定）；SIMULATION 任务也有 */
  goal: PlanGoal | null;
  /** 最近一次评估（monitor 或 prepare-step 落库的证据 + 上下文 + 事件版本）；从未评估 → null */
  latestEvaluation: { evaluatedAt: IsoUtc; evaluation: ConditionEvaluation | null; evidence: ConditionEvidenceInput } | null;
}

export interface TaskReader {
  readTask(taskId: string): Promise<LabTaskRecord | null>;
}

/** 回放档案（服务侧从三类数据源读出；core 只按时间过滤） */
export interface ReplayArchive {
  /** verify_evidence（9/20 起）：按 time.receivedAt 可见 */
  records: EvidenceRecord[];
  /** verify_context_snapshots + crowsnest 30 天回填：按 receivedAt（服务收到）与 packagedAt 双重 ≤ t */
  contextSnapshots: Array<{ receivedAt: IsoUtc; context: MarketContext }>;
  /** 事件全部修订版本（每版一条，firstKnownAt 各自不同）：按 firstKnownAt ≤ t 选每个 id 的最新可知版 */
  eventVersions: MarketEvent[];
  /** Chaconne premium_1h：只作参考价/链上价背景，不当 quote；ts = 小时桶起始 */
  referenceBars: Array<{ ts: IsoUtc; refPriceUsd: number | null; tokenPriceUsd: number | null }>;
  /** 参考价断供且已清空的区间（服务侧判定：覆盖跨度内缺失的常规时段小时桶） */
  referencePurged: Array<{ from: IsoUtc; to: IsoUtc }>;
}
