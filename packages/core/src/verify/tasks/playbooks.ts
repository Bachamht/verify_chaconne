/**
 * 模板（playbook）定义与参数校验（interfaces §11.5 / Y-01）。JSON 在 apps/verify-service/config/playbooks.json（版本化）；
 * 这里是纯函数：参数校验 → 条件项（含 `$param` 替换）→ PlanGoal 骨架。
 *
 * 模板不会把 `not_in_fed_blackout` 放进默认条件（K-07）；用户可显式加入。
 */
import { isDecimalString, isRawAmount } from "../amounts";
import type { Condition, ConditionSet, EventKind, IsoUtc, PlanGoal, PlaybookId, PolicyId, RawAmount } from "../contracts";
import { PLAYBOOK_IDS } from "../contracts";
import { findPolicy, LATEST_POLICY_VERSION } from "../policy";
import { makeConditionSet, validateConditionSet } from "../conditions";

export type PlaybookParamType = "integer" | "number" | "raw_amount" | "decimal" | "asset_key" | "event_kinds" | "boolean" | "iso" | "policy_id" | "reference_kind";
export interface PlaybookParamSpec {
  type: PlaybookParamType;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  /** asset_key：要求的登记角色 */
  role?: "stable_input" | "stock_output";
  enum?: string[];
  description?: string;
}
export interface PlaybookDefinition {
  id: PlaybookId;
  name: { en: string; zh: string };
  description: { en: string; zh: string };
  side: "buy" | "sell";
  /** 由哪个 lane 实现；lane_c = 只登记 id（portfolio_rebalance） */
  implementedBy: "lane_b" | "lane_c";
  params: Record<string, PlaybookParamSpec>;
  /** 至少要给其中之一（如 target_sell 的 targetPriceUsd / trackedCostPnlPctGte） */
  requireOneOf?: string[][];
  /** 条件模板：值里的 "$name" 引用参数；带 "$if": "name" 的项只在该参数有值时生成 */
  conditions: Array<Record<string, unknown>>;
  /** 用户自定义条件必须保留的类型 */
  requiredConditionTypes: Condition["type"][];
  simulationAllowed: boolean;
}
export interface PlaybookCatalog {
  version: string;
  playbooks: Record<string, PlaybookDefinition>;
}

export interface PlaybookParamError {
  field: string;
  code: string;
}

export const COMMON_PLAYBOOK_PARAMS: Record<string, PlaybookParamSpec> = {
  inputAssetKey: { type: "asset_key", required: true, role: "stable_input" },
  outputAssetKey: { type: "asset_key", required: true, role: "stock_output" },
  policyId: { type: "policy_id", default: "QUOTE_ONLY" },
  policyVersion: { type: "policy_id", default: LATEST_POLICY_VERSION },
  maxSlippageBps: { type: "integer", min: 1, max: 300, default: 50 },
  maxPriceImpactBps: { type: "integer", min: 1, max: 1000, default: 100 },
  maxReferenceDeviationBps: { type: "integer", min: 1, max: 2000, default: 300 },
  deadline: { type: "iso" },
};

function checkParam(name: string, spec: PlaybookParamSpec, v: unknown, errors: PlaybookParamError[]): unknown {
  if (v === undefined || v === null) {
    if (spec.default !== undefined) return spec.default;
    if (spec.required) errors.push({ field: name, code: "required" });
    return undefined;
  }
  switch (spec.type) {
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v) || (spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) errors.push({ field: name, code: "expected_integer_in_range" });
      return v;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v) || (spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) errors.push({ field: name, code: "expected_number_in_range" });
      return v;
    case "raw_amount":
      if (!isRawAmount(v) || BigInt(v) <= 0n) errors.push({ field: name, code: "expected_positive_raw_amount" });
      return v;
    case "decimal":
      if (!isDecimalString(v) || Number(v) <= 0) errors.push({ field: name, code: "expected_positive_decimal_string" });
      return v;
    case "asset_key":
      if (typeof v !== "string" || !/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(v)) errors.push({ field: name, code: "expected_asset_key" });
      return typeof v === "string" ? v.toLowerCase() : v;
    case "event_kinds":
      if (!Array.isArray(v) || v.length === 0 || v.some((k) => typeof k !== "string")) errors.push({ field: name, code: "expected_event_kinds" });
      return v;
    case "boolean":
      if (typeof v !== "boolean") errors.push({ field: name, code: "expected_boolean" });
      return v;
    case "iso":
      if (typeof v !== "string" || Number.isNaN(Date.parse(v))) errors.push({ field: name, code: "expected_iso" });
      return typeof v === "string" ? new Date(Date.parse(v)).toISOString() : v;
    case "policy_id":
      if (typeof v !== "string") errors.push({ field: name, code: "expected_string" });
      return v;
    case "reference_kind":
      if (v !== "live" && v !== "official_close" && v !== "close_last_tick") errors.push({ field: name, code: "expected_reference_kind" });
      return v;
  }
}

/** 参数校验（Y-01）：未知参数拒绝；缺失必填拒绝；范围外拒绝；返回展开默认值后的参数 */
export function validatePlaybookParams(def: PlaybookDefinition, raw: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; errors: PlaybookParamError[] } {
  const errors: PlaybookParamError[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const specs = { ...COMMON_PLAYBOOK_PARAMS, ...def.params };
  for (const k of Object.keys(o)) if (!(k in specs)) errors.push({ field: k, code: "unknown_param" });
  const params: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const v = checkParam(name, spec, o[name], errors);
    if (v !== undefined) params[name] = v;
  }
  const pid = params["policyId"];
  const pver = params["policyVersion"];
  if (typeof pid !== "string" || !["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"].includes(pid)) errors.push({ field: "policyId", code: "unknown_policy" });
  else if (typeof pver !== "string" || !findPolicy(pid as PolicyId, pver)) errors.push({ field: "policyVersion", code: "unknown_version" });
  for (const group of def.requireOneOf ?? []) if (!group.some((k) => params[k] !== undefined)) errors.push({ field: group.join("|"), code: "require_one_of" });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, params };
}

function substitute(v: unknown, params: Record<string, unknown>): unknown {
  if (typeof v === "string" && v.startsWith("$")) return params[v.slice(1)];
  if (Array.isArray(v)) return v.map((x) => substitute(x, params));
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, params)]));
  return v;
}

/** 模板条件项（已替换参数；`$if` 参数缺失的项跳过） */
export function playbookConditionItems(def: PlaybookDefinition, params: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const tpl of def.conditions) {
    const cond = tpl["$if"];
    if (typeof cond === "string" && (params[cond] === undefined || params[cond] === null || params[cond] === false)) continue;
    const { $if: _skip, ...rest } = tpl;
    void _skip;
    out.push(substitute(rest, params));
  }
  return out;
}

/**
 * 合并用户条件：同类型 → 用户项替换模板项；新类型追加；模板 requiredConditionTypes 必须仍在。
 * 全部走 DSL 校验（含 Y-05 / K-08）。
 */
export function mergeConditions(def: PlaybookDefinition, params: Record<string, unknown>, userItems: unknown[] | null, mode: "LIVE" | "SIMULATION"): { ok: true; set: ConditionSet } | { ok: false; errors: Array<{ index: number; field: string; code: string }> } {
  const base = playbookConditionItems(def, params) as Array<Record<string, unknown>>;
  let items: unknown[] = base;
  if (userItems && userItems.length > 0) {
    const userTypes = new Set(userItems.map((u) => (typeof u === "object" && u !== null ? (u as Record<string, unknown>)["type"] : undefined)));
    items = [...base.filter((b) => !userTypes.has(b["type"])), ...userItems];
  }
  const v = validateConditionSet({ version: "conditions/1", items }, mode);
  if (!v.ok) return v;
  const present = new Set(v.set.items.map((i) => i.type));
  const missing = def.requiredConditionTypes.filter((t) => !present.has(t));
  if (missing.length > 0) return { ok: false, errors: missing.map((t) => ({ index: -1, field: "conditions.items", code: `required_condition_missing:${t}` })) };
  return { ok: true, set: makeConditionSet(v.set.items) };
}

export interface PlaybookGoalArgs {
  ownerAddress: `0x${string}`;
  recipientAddress: `0x${string}`;
  executionChainId: number;
  params: Record<string, unknown>;
  def: PlaybookDefinition;
  nowIso: IsoUtc;
}

/** 总预算与步数：steps × perStepAmountRaw（DCA / accumulate）或 amountRaw（单步模板） */
export function playbookBudget(def: PlaybookDefinition, params: Record<string, unknown>): { steps: number; perStepAmountRaw: RawAmount; totalRaw: RawAmount } {
  const steps = typeof params["steps"] === "number" ? params["steps"] : 1;
  const per = (params["perStepAmountRaw"] ?? params["amountRaw"]) as RawAmount;
  if (!isRawAmount(per)) throw new Error(`playbook ${def.id}: 缺少 perStepAmountRaw/amountRaw`);
  return { steps, perStepAmountRaw: per, totalRaw: (BigInt(per) * BigInt(steps)).toString() };
}

export function playbookGoal(a: PlaybookGoalArgs): PlanGoal {
  const p = a.params;
  const { totalRaw } = playbookBudget(a.def, p);
  const inputKey = String(p["inputAssetKey"]);
  const outputKey = String(p["outputAssetKey"]);
  const deadline = typeof p["deadline"] === "string" ? p["deadline"] : new Date(Date.parse(a.nowIso) + 30 * 86_400_000).toISOString();
  const policyId = String(p["policyId"]) as PolicyId;
  // 方向：买入 = 花稳定币买股票；卖出 = 卖股票换稳定币（V-24：budget 永远是付出侧）
  const sell = a.def.side === "sell";
  return {
    ownerAddress: a.ownerAddress,
    recipientAddress: a.recipientAddress,
    executionChainId: a.executionChainId,
    legs: [{ outputAssetKey: sell ? inputKey : outputKey, weightBps: 10_000 }],
    budget: { inputAssetKeys: [sell ? outputKey : inputKey], amountInRaw: totalRaw },
    side: a.def.side,
    policyId,
    policyVersion: String(p["policyVersion"]),
    maxSlippageBps: p["maxSlippageBps"] as number,
    maxPriceImpactBps: (p["maxPriceImpactBps"] as number | undefined) ?? null,
    ...(policyId === "QUOTE_ONLY" ? {} : { maxReferenceDeviationBps: (p["maxReferenceDeviationBps"] as number | undefined) ?? null }),
    deadline,
  };
}

export function isPlaybookId(x: unknown): x is PlaybookId {
  return typeof x === "string" && (PLAYBOOK_IDS as readonly string[]).includes(x);
}

/**
 * 目标式任务的内置「模板」（CV-D16 批次 6）：没有条件、没有计划——agent 自己的策略决定何时、买哪个、买多少；
 * 平台只提供数据、范围内的核验与可核对的交付。参数由授权范围合成（服务端），不进目录文件。
 */
export const AGENT_GOAL_PLAYBOOK: PlaybookDefinition = {
  id: "agent_goal",
  name: { en: "Goal task (agent's own strategy)", zh: "目标任务（agent 自己的策略）" },
  description: { en: "No template and no plan conditions: you hand the agent an objective and a signed scope (assets, budget, per-step cap, steps, deadline, hard constraints). The agent decides when, which asset and how much, submits trade intents with its decision record, and Chaconne verifies each one before issuing a step certificate. The example playbooks are only examples of strategies.", zh: "没有模板、没有计划条件：你把目标和签过的范围（资产集合、总额、每笔上限、步数、期限、硬约束）交给 agent，它用自己的策略决定何时、买哪个、买多少，提交交易意图和决策记录，Chaconne 逐笔核验后才签步骤证书。示例模板只是策略示例。" },
  side: "buy",
  implementedBy: "lane_b",
  params: { steps: { type: "integer", min: 1, max: 1000, required: true }, perStepAmountRaw: { type: "raw_amount", required: true } },
  conditions: [],
  requiredConditionTypes: [],
  simulationAllowed: true,
};

export function validatePlaybookCatalog(raw: unknown): { ok: true; catalog: PlaybookCatalog } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o0 = (raw ?? {}) as Record<string, unknown>;
  // agent_goal 是内置的，目录文件可以不写
  const o: Record<string, unknown> = typeof o0["playbooks"] === "object" && o0["playbooks"] !== null && !("agent_goal" in (o0["playbooks"] as object)) ? { ...o0, playbooks: { ...(o0["playbooks"] as object), agent_goal: AGENT_GOAL_PLAYBOOK } } : o0;
  if (typeof o["version"] !== "string" || !/^playbooks\/\d+\.\d+\.\d+$/.test(o["version"])) errors.push("version");
  const pbs = o["playbooks"];
  if (typeof pbs !== "object" || pbs === null) errors.push("playbooks");
  else {
    for (const id of PLAYBOOK_IDS) if (!(id in (pbs as object))) errors.push(`missing playbook ${id}`);
    for (const [id, def] of Object.entries(pbs as Record<string, PlaybookDefinition>)) {
      if (!isPlaybookId(id) || def.id !== id) errors.push(`bad id ${id}`);
      if (def.side !== "buy" && def.side !== "sell") errors.push(`${id}.side`);
      if (!Array.isArray(def.conditions)) errors.push(`${id}.conditions`);
      if (def.conditions?.some((c) => c["type"] === "not_in_fed_blackout")) errors.push(`${id}: not_in_fed_blackout must not be a template default (K-07)`);
      if (typeof def.simulationAllowed !== "boolean") errors.push(`${id}.simulationAllowed`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, catalog: o as unknown as PlaybookCatalog };
}

export type { EventKind as PlaybookEventKind };
