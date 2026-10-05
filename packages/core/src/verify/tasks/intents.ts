/**
 * agent 交易意图 + 决策记录（CV-D16 批次 2）。
 *
 * agent 不是提交「一笔交易」而是提交「意图 + 决策记录」；Chaconne 做四道核验后才签步骤证书：
 *   1. facts    事实分拣：决策记录里的每条依据按来源分类（平台核验事实 / agent 数据 / agent 研究），信任档位决定哪些可采信；
 *   2. scope    授权：意图必须在签名范围内（资产集合 / 每笔上限 / 总额 / 步数 / 期限 / 允许卖出）+ 硬约束满足；
 *   3. execution 执行核验：与工具箱同一套引擎（路由 / 报价 / 价格冲击 / 参考价，按任务策略）；
 *   4. binding  绑定：证书 effectivePolicyHash == 当前授权 == 任务绑定哈希，输出代币在授权输出集内。
 * 决策记录**不是通行证**：它只被记录、分类、标注，从不放宽任何一道核验。
 */
import type { IsoUtc, RawAmount, Reason } from "../contracts";
import { isRawAmount } from "../amounts";
import type { TrustTier } from "./scope";

export const TRADE_INTENT_KINDS = ["buy", "sell"] as const;
export type TradeIntentKind = (typeof TRADE_INTENT_KINDS)[number];

export const DECISION_CLAIM_KINDS = ["platform_fact", "agent_data", "agent_research"] as const;
/** platform_fact = 引用 Chaconne 证据（evidenceId）；agent_data = agent 自带、有来源的数据；agent_research = agent 的研究结论 / 推理 */
export type DecisionClaimKind = (typeof DECISION_CLAIM_KINDS)[number];

export interface DecisionClaim {
  kind: DecisionClaimKind;
  /** 一句话（≤ 500 字） */
  text: string;
  /** 来源：平台证据 id（platform_fact）或 URL / 数据源名（agent_*） */
  source?: { evidenceId?: string; url?: string; name?: string };
  observedAt?: IsoUtc;
}

/** agent 提交的决策记录（原样保存进意图与证据包） */
export interface DecisionRecord {
  /** 为什么现在、买这个、这么多（≤ 2000 字） */
  rationale: string;
  claims: DecisionClaim[];
  /** 考虑过但没选的方案（可选） */
  alternatives?: string[];
  /** 修订自哪条意图（可选） */
  revisionOf?: string;
}

/** 每条依据的分拣结果：admissible = 信任档位允许采信；verified = 平台证据 id 在本次核验的证据里 */
export interface ClaimTriage {
  index: number;
  kind: DecisionClaimKind;
  admissible: boolean;
  verified: boolean | null;
  label: "platform_verified" | "platform_unknown_evidence" | "agent_provided_unverified" | "not_admissible";
  /** v7（CV-D23）：platform_verified 来自任务 15 分钟内看过的证据（agent-context / quotes）时，附观察时刻与年龄 */
  via?: "this_check" | "task_evidence";
  observedAt?: IsoUtc;
  ageS?: number;
}

/** CV-D23：任务证据（verify_task_evidence）的有效期——15 分钟内 Agent 看过的报价与上下文可以被引用并核对 */
export const TASK_EVIDENCE_TTL_MS = 15 * 60_000;
/** 任务证据索引：evidenceId → 数据观察时刻（年龄从它算）与登记进任务证据的时刻（15 分钟窗口从它算；缺省 = observedAt） */
export type TaskEvidenceIndex = ReadonlyMap<string, { observedAt: IsoUtc; seenAt?: IsoUtc }>;

export const INTENT_CHECK_IDS = ["facts", "scope", "execution", "binding"] as const;
export type IntentCheckId = (typeof INTENT_CHECK_IDS)[number];
export interface IntentCheck {
  id: IntentCheckId;
  ok: boolean;
  reasons: Reason[];
  /** 人可读补充（不含证书 / 签名） */
  detail: Record<string, unknown>;
}

/** v7：superseded = 同一授权的新意图签发时，旧意图的步骤从未被取走（其作业同一事务取消） */
export const INTENT_STATUSES = ["certified", "simulated", "rejected", "withdrawn", "expired", "superseded"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export interface AgentTradeIntent {
  id: string;
  taskId: string;
  clientRequestId: string;
  kind: TradeIntentKind;
  outputAssetKey: string;
  amountInRaw: RawAmount;
  decision: DecisionRecord;
  triage: ClaimTriage[];
  checks: IntentCheck[];
  status: IntentStatus;
  /** 签发的步骤（certified）；simulated / rejected 为 null */
  step: { mandateId: string; stepIndex: number; validUntil: IsoUtc } | null;
  /** 计划条件的偏离（信息项：agent 在范围内可以偏离计划，但要记下来） */
  planDeviations: Reason[];
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
}

export interface IntentError {
  field: string;
  code: string;
}

/** 信任档位允许采信的依据种类 */
export function admissibleClaimKinds(tier: TrustTier): ReadonlySet<DecisionClaimKind> {
  if (tier === "agent_research") return new Set(["platform_fact", "agent_data", "agent_research"]);
  if (tier === "agent_data") return new Set(["platform_fact", "agent_data"]);
  return new Set(["platform_fact"]);
}

export function resolveDecisionRecord(raw: unknown): { ok: true; decision: DecisionRecord } | { ok: false; errors: IntentError[] } {
  const errors: IntentError[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rationale = typeof o["rationale"] === "string" ? o["rationale"].trim() : "";
  if (!rationale || rationale.length > 2000) errors.push({ field: "decision.rationale", code: "expected_string_1_to_2000" });
  const claims: DecisionClaim[] = [];
  if (o["claims"] !== undefined) {
    if (!Array.isArray(o["claims"]) || o["claims"].length > 32) errors.push({ field: "decision.claims", code: "expected_array_max_32" });
    else o["claims"].forEach((c, i) => {
      const cc = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      const kind = (DECISION_CLAIM_KINDS as readonly unknown[]).includes(cc["kind"]) ? (cc["kind"] as DecisionClaimKind) : null;
      const text = typeof cc["text"] === "string" ? cc["text"].trim() : "";
      if (!kind) errors.push({ field: `decision.claims[${i}].kind`, code: `expected_${DECISION_CLAIM_KINDS.join("|")}` });
      if (!text || text.length > 500) errors.push({ field: `decision.claims[${i}].text`, code: "expected_string_1_to_500" });
      const src = cc["source"] && typeof cc["source"] === "object" ? (cc["source"] as Record<string, unknown>) : null;
      const source = src ? { ...(typeof src["evidenceId"] === "string" ? { evidenceId: src["evidenceId"] } : {}), ...(typeof src["url"] === "string" && src["url"].length <= 500 ? { url: src["url"] } : {}), ...(typeof src["name"] === "string" && src["name"].length <= 100 ? { name: src["name"] } : {}) } : undefined;
      if (kind === "platform_fact" && !source?.evidenceId) errors.push({ field: `decision.claims[${i}].source.evidenceId`, code: "required_for_platform_fact" });
      const observedAt = typeof cc["observedAt"] === "string" && Number.isFinite(Date.parse(cc["observedAt"])) ? new Date(Date.parse(cc["observedAt"])).toISOString() : undefined;
      if (kind && text) claims.push({ kind, text, ...(source && Object.keys(source).length ? { source } : {}), ...(observedAt ? { observedAt } : {}) });
    });
  }
  const alternatives = Array.isArray(o["alternatives"]) ? o["alternatives"].filter((a): a is string => typeof a === "string" && a.length <= 500).slice(0, 8) : undefined;
  const revisionOf = typeof o["revisionOf"] === "string" && /^int_[0-9a-f]+$/.test(o["revisionOf"]) ? o["revisionOf"] : undefined;
  if (errors.length) return { ok: false, errors };
  return { ok: true, decision: { rationale, claims, ...(alternatives && alternatives.length ? { alternatives } : {}), ...(revisionOf ? { revisionOf } : {}) } };
}

/**
 * 事实分拣：按信任档位与本次核验的证据 id 集合给每条依据打标签。
 * v7（CV-D23）：可选 taskEvidence = 该任务 15 分钟内 verify_task_evidence 里的 evidenceId（Agent 刚看过的报价与上下文）——
 * 同样标 platform_verified，并附 observedAt 与年龄（秒）；超过 15 分钟的不承认（标 platform_unknown_evidence）。
 */
export function triageClaims(decision: DecisionRecord, tier: TrustTier, evidenceIds: ReadonlySet<string>, taskEvidence?: TaskEvidenceIndex, nowIso?: IsoUtc): ClaimTriage[] {
  const allowed = admissibleClaimKinds(tier);
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  return decision.claims.map((c, index) => {
    const admissible = allowed.has(c.kind);
    if (!admissible) return { index, kind: c.kind, admissible, verified: null, label: "not_admissible" as const };
    if (c.kind === "platform_fact") {
      const id = c.source?.evidenceId;
      if (id && evidenceIds.has(id)) return { index, kind: c.kind, admissible, verified: true, label: "platform_verified" as const, ...(taskEvidence ? { via: "this_check" as const } : {}) };
      const te = id ? taskEvidence?.get(id) : undefined;
      if (te) {
        const seenMs = nowMs - Date.parse(te.seenAt ?? te.observedAt);
        const ageMs = nowMs - Date.parse(te.observedAt);
        if (Number.isFinite(seenMs) && seenMs >= 0 && seenMs <= TASK_EVIDENCE_TTL_MS) return { index, kind: c.kind, admissible, verified: true, label: "platform_verified" as const, via: "task_evidence" as const, observedAt: te.observedAt, ageS: Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 1000)) : 0 };
      }
      return { index, kind: c.kind, admissible, verified: false, label: "platform_unknown_evidence" as const };
    }
    return { index, kind: c.kind, admissible, verified: false, label: "agent_provided_unverified" as const };
  });
}

/**
 * 意图请求体。v7 卖出体 `{kind: "sell", assetKey, amountInRaw}`：assetKey = 要卖出的股票（本任务买入形成的持仓），
 * outputAssetKey 可省（给了必须等于任务资金币种——由服务端按任务核对）；买入体不变（outputAssetKey = 要买的股票）。
 * 解析结果里 sell 的 `assetKey` 必有；buy 的 `assetKey` = outputAssetKey。可选 turnVersion（整数 ≥ 0）与 nextCheckAt（ISO）。
 */
export interface IntentBody {
  clientRequestId: string;
  kind: TradeIntentKind;
  /** buy：要买的股票；sell：服务端核对后的资金币种（未给为 ""） */
  outputAssetKey: string;
  /** v7：PlanGuard 拉取方向上的资产——buy = 买入的股票；sell = 卖出的股票 */
  assetKey: string;
  amountInRaw: RawAmount;
  decision: DecisionRecord;
  turnVersion?: number;
  nextCheckAt?: string;
}
export function resolveIntentBody(raw: unknown): { ok: true; body: IntentBody } | { ok: false; errors: IntentError[] } {
  const errors: IntentError[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const clientRequestId = typeof o["clientRequestId"] === "string" && /^[A-Za-z0-9_\-:.]{1,128}$/.test(o["clientRequestId"]) ? o["clientRequestId"] : null;
  if (!clientRequestId) errors.push({ field: "clientRequestId", code: "required" });
  const kind = o["kind"] === undefined ? "buy" : (TRADE_INTENT_KINDS as readonly unknown[]).includes(o["kind"]) ? (o["kind"] as TradeIntentKind) : null;
  if (!kind) errors.push({ field: "kind", code: "expected_buy|sell" });
  // 兼容 v6 卖出体（只给 outputAssetKey = 股票）：没有 assetKey 时把它当作要卖出的股票，outputAssetKey 留空（服务端补资金币种）
  const legacySell = kind === "sell" && typeof o["assetKey"] !== "string" && typeof o["outputAssetKey"] === "string";
  const outputAssetKey = legacySell ? "" : typeof o["outputAssetKey"] === "string" ? o["outputAssetKey"].toLowerCase() : kind === "sell" ? "" : null;
  if (outputAssetKey === null) errors.push({ field: "outputAssetKey", code: "expected_asset_key" });
  const assetKey = kind === "sell" ? (typeof o["assetKey"] === "string" && o["assetKey"] ? o["assetKey"].toLowerCase() : legacySell ? (o["outputAssetKey"] as string).toLowerCase() : null) : outputAssetKey;
  if (kind === "sell" && !assetKey) errors.push({ field: "assetKey", code: "expected_asset_key_for_sell" });
  const turnVersion = o["turnVersion"] === undefined || o["turnVersion"] === null ? undefined : Number.isInteger(o["turnVersion"]) && (o["turnVersion"] as number) >= 0 ? (o["turnVersion"] as number) : null;
  if (turnVersion === null) errors.push({ field: "turnVersion", code: "expected_non_negative_integer" });
  const nextCheckAt = o["nextCheckAt"] === undefined || o["nextCheckAt"] === null ? undefined : typeof o["nextCheckAt"] === "string" && Number.isFinite(Date.parse(o["nextCheckAt"])) ? new Date(Date.parse(o["nextCheckAt"])).toISOString() : null;
  if (nextCheckAt === null) errors.push({ field: "nextCheckAt", code: "expected_iso_time" });
  const amountInRaw = isRawAmount(o["amountInRaw"]) && BigInt(o["amountInRaw"] as string) > 0n ? (o["amountInRaw"] as RawAmount) : null;
  if (!amountInRaw) errors.push({ field: "amountInRaw", code: "expected_positive_raw_amount" });
  const d = resolveDecisionRecord(o["decision"]);
  if (!d.ok) errors.push(...d.errors);
  if (errors.length || !d.ok) return { ok: false, errors };
  return { ok: true, body: { clientRequestId: clientRequestId!, kind: kind!, outputAssetKey: outputAssetKey!, assetKey: assetKey!, amountInRaw: amountInRaw!, decision: d.decision, ...(typeof turnVersion === "number" ? { turnVersion } : {}), ...(typeof nextCheckAt === "string" ? { nextCheckAt } : {}) } };
}
