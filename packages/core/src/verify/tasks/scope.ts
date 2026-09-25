/**
 * 授权范围（scope/1，CV-D16）：**签名只覆盖这里**。
 *
 * 任务的授权对象不再是「一份计划」而是「一个范围」：目标描述、允许买入的资产集合、总额、每笔上限、步数上限、期限、
 * 是否允许卖出、信任档位、签发方式、以及用户自设的硬约束条件。这些折进 `effectivePolicyHash`（作为展开参数
 * `conditionsHash` 的取值 = scopeHash），PlanGuard 每步比对证书与 mandate 的 effectivePolicyHash，因此范围内的任何
 * 一项都不可能被服务端或 agent 单方面放宽。模板参数、计划条件（时段 / 间隔 / 事件窗口 …）在范围之外：可改、不重签。
 *
 * 范围一经授权不可改：要放宽就建新任务重新签名（K-09 改为「改范围 = 新任务」）。
 */
import { hashCanonical } from "../canonical";
import { validateConditionSet } from "../conditions/validate";
import type { Bytes32, Condition, IsoUtc, RawAmount } from "../contracts";
import { isRawAmount } from "../amounts";

export const TRUST_TIERS = ["platform_only", "agent_data", "agent_research"] as const;
/**
 * 信任档位（决策记录里 agent 能拿什么当依据）：
 *  platform_only  = 只信 Chaconne 核验过的事实（上下文 / 事件 / 报价 / 参考价）；agent 自带数据只记录不采信；
 *  agent_data     = 允许 agent 提交带来源的数据声明（如另一家行情、链上余额）作为依据，标「agent 提供、未核验」；
 *  agent_research = 允许 agent 提交研究结论（观点 / 推理）作为依据，同样标注；硬约束仍由平台核验。
 */
export type TrustTier = (typeof TRUST_TIERS)[number];
export const ISSUANCE_MODES = ["auto", "agent"] as const;
/** auto = monitor 按计划条件签发；agent = 只由 agent 提交交易意图后签发（monitor 只评估不签） */
export type IssuanceMode = (typeof ISSUANCE_MODES)[number];

export const SCOPE_VERSION = "scope/1" as const;
export const SCOPE_MAX_OUTPUT_ASSETS = 8;
export const SCOPE_MAX_OBJECTIVE_CHARS = 500;
export const SCOPE_MAX_HARD_CONDITIONS = 8;

export interface TaskScope {
  version: typeof SCOPE_VERSION;
  /** 目标描述（人话，≤ 500 字）：给 agent 与页面看，不参与求值 */
  objective: string;
  /** 资金币种（登记表 stable_input） */
  inputAssetKey: string;
  /** 允许买入 / 持有的股票代币集合（登记表 stock_output，1..8，小写、去重、排序） */
  outputAssetKeys: string[];
  /** 总额（资金币种最小单位） */
  budgetCapRaw: RawAmount;
  /** 每笔上限（资金币种最小单位） */
  perStepCapRaw: RawAmount;
  /** 步数上限 */
  maxSteps: number;
  /** 授权到期（ISO） */
  deadline: IsoUtc;
  /** 是否允许卖出（卖出仍需按资产另签卖出授权；这里只决定 agent 能否提出卖出意图） */
  allowSell: boolean;
  trustTier: TrustTier;
  issuance: IssuanceMode;
  /** 硬约束条件（DSL 子集，折进签名；每次评估与计划条件一起 AND；不可被计划条件覆盖） */
  hardConditions: Condition[];
}

export function scopeHash(scope: TaskScope): Bytes32 {
  return hashCanonical({
    version: scope.version,
    objective: scope.objective,
    inputAssetKey: scope.inputAssetKey,
    outputAssetKeys: scope.outputAssetKeys,
    budgetCapRaw: scope.budgetCapRaw,
    perStepCapRaw: scope.perStepCapRaw,
    maxSteps: scope.maxSteps,
    deadline: scope.deadline,
    allowSell: scope.allowSell,
    trustTier: scope.trustTier,
    issuance: scope.issuance,
    hardConditions: scope.hardConditions,
  });
}

export interface ScopeError {
  field: string;
  code: string;
}

export interface ScopeDefaults {
  objective: string;
  inputAssetKey: string;
  outputAssetKeys: string[];
  budgetCapRaw: RawAmount;
  perStepCapRaw: RawAmount;
  maxSteps: number;
  deadline: IsoUtc;
  allowSell: boolean;
}

/** 规范化资产集合：小写、去重、排序（哈希稳定） */
export function normalizeAssetKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((k) => k.toLowerCase()))].sort();
}

/**
 * 解析请求体里的 scope（可缺省：缺省项由计划推导）。只做结构与自洽校验；登记表角色、与计划的包含关系由服务端再查。
 * 规则：perStepCap ≤ budgetCap；perStepCap × 1 ≤ budgetCap；maxSteps 1..1000；deadline 在 now 之后；
 * hardConditions 走 DSL 校验（mode 同任务）。
 */
export function resolveTaskScope(raw: unknown, defaults: ScopeDefaults, mode: "LIVE" | "SIMULATION", nowIso: IsoUtc): { ok: true; scope: TaskScope } | { ok: false; errors: ScopeError[] } {
  const errors: ScopeError[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["version", "objective", "inputAssetKey", "outputAssetKeys", "budgetCapRaw", "perStepCapRaw", "maxSteps", "deadline", "allowSell", "trustTier", "issuance", "hardConditions"].includes(k)) errors.push({ field: `scope.${k}`, code: "unknown_field" });
  if (o["version"] !== undefined && o["version"] !== SCOPE_VERSION) errors.push({ field: "scope.version", code: "unsupported_version" });
  const objective = o["objective"] === undefined ? defaults.objective : typeof o["objective"] === "string" ? o["objective"].trim() : null;
  if (objective === null || objective.length === 0 || objective.length > SCOPE_MAX_OBJECTIVE_CHARS) errors.push({ field: "scope.objective", code: "expected_string_1_to_500" });
  const inputAssetKey = o["inputAssetKey"] === undefined ? defaults.inputAssetKey : typeof o["inputAssetKey"] === "string" ? o["inputAssetKey"].toLowerCase() : null;
  if (inputAssetKey === null) errors.push({ field: "scope.inputAssetKey", code: "expected_asset_key" });
  let outputAssetKeys: string[] | null = null;
  if (o["outputAssetKeys"] === undefined) outputAssetKeys = normalizeAssetKeys(defaults.outputAssetKeys);
  else if (Array.isArray(o["outputAssetKeys"]) && o["outputAssetKeys"].every((k) => typeof k === "string")) outputAssetKeys = normalizeAssetKeys(o["outputAssetKeys"] as string[]);
  if (!outputAssetKeys || outputAssetKeys.length < 1 || outputAssetKeys.length > SCOPE_MAX_OUTPUT_ASSETS) errors.push({ field: "scope.outputAssetKeys", code: `expected_1_to_${SCOPE_MAX_OUTPUT_ASSETS}_asset_keys` });
  const budgetCapRaw = o["budgetCapRaw"] === undefined ? defaults.budgetCapRaw : isRawAmount(o["budgetCapRaw"]) ? (o["budgetCapRaw"] as RawAmount) : null;
  if (budgetCapRaw === null || BigInt(budgetCapRaw) <= 0n) errors.push({ field: "scope.budgetCapRaw", code: "expected_positive_raw_amount" });
  const perStepCapRaw = o["perStepCapRaw"] === undefined ? defaults.perStepCapRaw : isRawAmount(o["perStepCapRaw"]) ? (o["perStepCapRaw"] as RawAmount) : null;
  if (perStepCapRaw === null || BigInt(perStepCapRaw) <= 0n) errors.push({ field: "scope.perStepCapRaw", code: "expected_positive_raw_amount" });
  else if (budgetCapRaw !== null && BigInt(perStepCapRaw) > BigInt(budgetCapRaw)) errors.push({ field: "scope.perStepCapRaw", code: "must_be_lte_budgetCap" });
  const maxSteps = o["maxSteps"] === undefined ? defaults.maxSteps : typeof o["maxSteps"] === "number" ? o["maxSteps"] : null;
  if (maxSteps === null || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) errors.push({ field: "scope.maxSteps", code: "expected_integer_1_to_1000" });
  const deadline = o["deadline"] === undefined ? defaults.deadline : typeof o["deadline"] === "string" && Number.isFinite(Date.parse(o["deadline"])) ? new Date(Date.parse(o["deadline"])).toISOString() : null;
  if (deadline === null) errors.push({ field: "scope.deadline", code: "expected_iso_datetime" });
  else if (Date.parse(deadline) <= Date.parse(nowIso)) errors.push({ field: "scope.deadline", code: "must_be_future" });
  const allowSell = o["allowSell"] === undefined ? defaults.allowSell : typeof o["allowSell"] === "boolean" ? o["allowSell"] : null;
  if (allowSell === null) errors.push({ field: "scope.allowSell", code: "expected_boolean" });
  const trustTier = o["trustTier"] === undefined ? "platform_only" : (TRUST_TIERS as readonly unknown[]).includes(o["trustTier"]) ? (o["trustTier"] as TrustTier) : null;
  if (trustTier === null) errors.push({ field: "scope.trustTier", code: `expected_${TRUST_TIERS.join("|")}` });
  const issuance = o["issuance"] === undefined ? "auto" : (ISSUANCE_MODES as readonly unknown[]).includes(o["issuance"]) ? (o["issuance"] as IssuanceMode) : null;
  if (issuance === null) errors.push({ field: "scope.issuance", code: `expected_${ISSUANCE_MODES.join("|")}` });
  let hardConditions: Condition[] = [];
  if (o["hardConditions"] !== undefined) {
    if (!Array.isArray(o["hardConditions"]) || o["hardConditions"].length > SCOPE_MAX_HARD_CONDITIONS) errors.push({ field: "scope.hardConditions", code: `expected_array_max_${SCOPE_MAX_HARD_CONDITIONS}` });
    else if (o["hardConditions"].some((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "thesis_holds")) errors.push({ field: "scope.hardConditions", code: "thesis_holds_not_allowed" });
    else {
      const v = validateConditionSet({ version: "conditions/1", items: o["hardConditions"] }, mode);
      if (!v.ok) for (const e of v.errors) errors.push({ field: `scope.hardConditions[${e.index}].${e.field}`, code: e.code });
      else hardConditions = v.set.items;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scope: { version: SCOPE_VERSION, objective: objective!, inputAssetKey: inputAssetKey!, outputAssetKeys: outputAssetKeys!, budgetCapRaw: budgetCapRaw!, perStepCapRaw: perStepCapRaw!, maxSteps: maxSteps!, deadline: deadline!, allowSell: allowSell!, trustTier: trustTier!, issuance: issuance!, hardConditions } };
}

/** 计划条件与硬约束合并：硬约束同类型覆盖计划项（硬约束不可被计划放宽）；可重复类型两边都保留 */
export function mergeHardConditions(planItems: readonly Condition[], hard: readonly Condition[], repeatable: ReadonlySet<Condition["type"]>): Condition[] {
  const hardTypes = new Set(hard.filter((h) => !repeatable.has(h.type)).map((h) => h.type));
  return [...planItems.filter((p) => !hardTypes.has(p.type)), ...hard];
}

/** 计划条件的修改是否触碰硬约束（同非重复类型即视为触碰） */
export function touchesHardConditions(items: readonly Condition[], hard: readonly Condition[], repeatable: ReadonlySet<Condition["type"]>): Condition["type"][] {
  const hardTypes = new Set(hard.filter((h) => !repeatable.has(h.type)).map((h) => h.type));
  return [...new Set(items.filter((i) => hardTypes.has(i.type)).map((i) => i.type))];
}
