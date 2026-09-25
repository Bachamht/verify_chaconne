/**
 * 任务草稿 → POST /v1/tasks 请求体（V-24）。纯函数，页面与测试共用。
 * 服务端必填：inputAssetKey（资金币种）+ perStepAmountRaw / amountRaw（每步金额，最小单位）——两处表单此前都漏了。
 */
import type { Condition, IssuanceMode, PlaybookId, TrustTier } from "@chaconne/core/verify";
import type { TemplateTaskBody, TaskMode } from "@/lib/api-v2";
import { humanToRaw } from "@/lib/format";

export interface TaskDraft {
  playbookId: PlaybookId;
  outputAssetKey: string;
  inputAssetKey: string;
  steps: number;
  /** 每步金额（人类单位，如 "1" = 1 USDG） */
  perStepHuman: string;
  mode: TaskMode;
  conditions: Condition[];
  /** discount_watch 专用：最大溢价 bps */
  maxPremiumBps?: number;
  /** 每一步交易的核验策略；缺省 QUOTE_ONLY（24 小时可执行，只核对路由 / 报价 / 价格冲击） */
  policyId?: "QUOTE_ONLY" | "REFERENCE_CONTEXT" | "STRICT_LIVE";
  /** 最大价格冲击（bps，1–1000）；超过则该步拒绝，这是唯一的硬性拦截 */
  maxPriceImpactBps?: number;
  /** 只在美股常规时段执行（可选；链上股票本身 24 小时可交易）。表单据此加一条 session 条件，不作为参数发送 */
  regularSessionOnly?: boolean;
  /** 草案里带的 owner（A2MCP 草案是完整的 POST /v1/tasks 请求体）；只在没连钱包时预填 */
  ownerAddress?: string;
  /* ---- 授权范围（CV-D16）：签名只覆盖这些；模板参数与计划条件在签名之外 ---- */
  /** 目标描述（人话）；缺省 = 模板标题 */
  objective?: string;
  /** 除主资产外还允许 agent 买入的资产（登记表 assetKey） */
  extraAssetKeys?: string[];
  /** 信任档位：agent 提交决策时能拿什么当依据 */
  trustTier?: TrustTier;
  /** 签发方式：auto = 平台按计划签发；agent = 只由 agent 提交交易意图后签发 */
  issuance?: IssuanceMode;
  /** 是否允许 agent 提出卖出（卖出仍需按资产另签授权） */
  allowSell?: boolean;
}
export type DraftField = "outputAssetKey" | "inputAssetKey" | "steps" | "perStepAmountRaw" | "ownerAddress" | "maxPriceImpactBps";

/** 模板的金额参数名：DCA / 加仓按每步（perStepAmountRaw）；单步模板按总额（amountRaw） */
export function amountParamOf(playbookId: PlaybookId): "perStepAmountRaw" | "amountRaw" {
  return playbookId === "session_dca" || playbookId === "event_aware_accumulate" ? "perStepAmountRaw" : "amountRaw";
}

/** 与服务端一致的前置校验；返回 { field → code }（code 与服务端 details[].code 同名，文案统一走 fieldErrorText） */
export function validateDraft(d: TaskDraft, owner: string, decimals: number | null): Partial<Record<DraftField, string>> {
  const e: Partial<Record<DraftField, string>> = {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) e.ownerAddress = "required";
  if (!/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(d.outputAssetKey)) e.outputAssetKey = "expected_asset_key";
  if (!/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(d.inputAssetKey)) e.inputAssetKey = "required";
  if (!Number.isInteger(d.steps) || d.steps < 1 || d.steps > 60) e.steps = "expected_integer_in_range";
  if (decimals === null || humanToRaw(d.perStepHuman, decimals) === null) e.perStepAmountRaw = "expected_positive_raw_amount";
  return e;
}

export function buildTaskBody(d: TaskDraft, owner: string, decimals: number, clientRequestId: string): TemplateTaskBody {
  const raw = humanToRaw(d.perStepHuman, decimals) ?? "0";
  const params: Record<string, unknown> = { inputAssetKey: d.inputAssetKey.toLowerCase(), outputAssetKey: d.outputAssetKey.toLowerCase(), steps: d.steps, [amountParamOf(d.playbookId)]: raw, policyId: d.policyId ?? "QUOTE_ONLY" };
  if (d.maxPriceImpactBps !== undefined) params["maxPriceImpactBps"] = d.maxPriceImpactBps;
  if (d.playbookId === "discount_watch") params["maxPremiumBps"] = d.maxPremiumBps ?? 30;
  const body: TemplateTaskBody = { clientRequestId, ownerAddress: owner.toLowerCase(), playbookId: d.playbookId, params, conditions: { version: "conditions/1", items: d.conditions }, mode: d.mode };
  const scope = scopeOfDraft(d);
  if (scope) body.scope = scope;
  return body;
}

/** 范围里只发用户明确设置的项；总额 / 每笔 / 步数 / 期限缺省由服务端按计划推导（范围 = 计划本身） */
export function scopeOfDraft(d: TaskDraft): TemplateTaskBody["scope"] | null {
  const scope: NonNullable<TemplateTaskBody["scope"]> = {};
  const objective = d.objective?.trim();
  if (objective) scope.objective = objective.slice(0, 500);
  const extra = (d.extraAssetKeys ?? []).map((k) => k.toLowerCase()).filter((k) => k && k !== d.outputAssetKey.toLowerCase());
  if (extra.length) scope.outputAssetKeys = [...new Set([d.outputAssetKey.toLowerCase(), ...extra])].sort();
  if (d.trustTier && d.trustTier !== "platform_only") scope.trustTier = d.trustTier;
  if (d.issuance && d.issuance !== "auto") scope.issuance = d.issuance;
  if (d.allowSell) scope.allowSell = true;
  return Object.keys(scope).length ? scope : null;
}

/** 默认每步金额（人类单位）：余额已知 → min(1, 余额/步数 截到 2 位)；余额未知 → 1 */
export function defaultPerStep(balanceRaw: string | bigint | null | undefined, decimals: number, steps: number): string {
  if (balanceRaw === null || balanceRaw === undefined) return "1";
  let bal: bigint;
  try {
    bal = BigInt(balanceRaw);
  } catch {
    return "1";
  }
  const n = Math.max(1, steps);
  const unit = 10n ** BigInt(decimals);
  const perRaw = bal / BigInt(n);
  if (perRaw >= unit) return "1";
  // 截到 2 位小数
  const cents = (perRaw * 100n) / unit;
  if (cents <= 0n) return "1";
  const s = cents.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`.replace(/\.?0+$/, "");
}

/** 会话内的草稿交接（Missions「用这个草案」/ 一句话编译 → 表单预填）：只在本浏览器 sessionStorage，不上传 */
export const DRAFT_KEY = "verify_task_draft_v1";
export interface DraftHandoff {
  playbookId?: string;
  mode?: string;
  params?: Record<string, unknown>;
  conditions?: { items?: Condition[] } | Condition[];
  ownerAddress?: string;
  /** A2MCP 草案可能标出缺什么（如 ["ownerAddress"]）；表单本来就会要求补 owner */
  missingForCreate?: string[];
  /** 授权范围（CV-D16） */
  scope?: { objective?: unknown; outputAssetKeys?: unknown[]; trustTier?: unknown; issuance?: unknown; allowSell?: unknown };
}
export function stashDraft(d: DraftHandoff): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}
export function takeDraft(): DraftHandoff | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DRAFT_KEY);
    const d = JSON.parse(raw) as DraftHandoff;
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}
/** 草稿（服务端 draft / 一句话编译结果 / 查询串）→ 表单预填值；金额按精度换成人类单位 */
export function presetFromDraft(d: DraftHandoff | null | undefined, decimalsOf: (assetKey: string) => number | null): Partial<TaskDraft> {
  if (!d) return {};
  const p = (d.params ?? {}) as Record<string, unknown>;
  const out: Partial<TaskDraft> = {};
  if (typeof d.playbookId === "string") out.playbookId = d.playbookId as PlaybookId;
  if (typeof d.ownerAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(d.ownerAddress)) out.ownerAddress = d.ownerAddress;
  if (d.mode === "SIMULATION" || d.mode === "LIVE") out.mode = d.mode;
  if (typeof p["outputAssetKey"] === "string") out.outputAssetKey = p["outputAssetKey"];
  if (typeof p["inputAssetKey"] === "string") out.inputAssetKey = p["inputAssetKey"];
  if (typeof p["steps"] === "number" && Number.isInteger(p["steps"])) out.steps = p["steps"];
  if (typeof p["maxPremiumBps"] === "number") out.maxPremiumBps = p["maxPremiumBps"];
  if (p["policyId"] === "QUOTE_ONLY" || p["policyId"] === "REFERENCE_CONTEXT" || p["policyId"] === "STRICT_LIVE") out.policyId = p["policyId"];
  if (typeof p["maxPriceImpactBps"] === "number" && Number.isInteger(p["maxPriceImpactBps"])) out.maxPriceImpactBps = p["maxPriceImpactBps"];
  const sc = d.scope;
  if (sc && typeof sc === "object") {
    if (typeof sc.objective === "string") out.objective = sc.objective;
    if (sc.trustTier === "platform_only" || sc.trustTier === "agent_data" || sc.trustTier === "agent_research") out.trustTier = sc.trustTier;
    if (sc.issuance === "auto" || sc.issuance === "agent") out.issuance = sc.issuance;
    if (typeof sc.allowSell === "boolean") out.allowSell = sc.allowSell;
    if (Array.isArray(sc.outputAssetKeys)) out.extraAssetKeys = sc.outputAssetKeys.filter((k): k is string => typeof k === "string");
  }
  const raw = (p["perStepAmountRaw"] ?? p["amountRaw"]) as unknown;
  if (typeof raw === "string" && /^\d+$/.test(raw) && typeof p["inputAssetKey"] === "string") {
    const dec = decimalsOf(p["inputAssetKey"]);
    if (dec !== null) {
      const s = raw.padStart(dec + 1, "0");
      const i = s.slice(0, s.length - dec);
      const f = s.slice(s.length - dec).replace(/0+$/, "");
      out.perStepHuman = f ? `${i}.${f}` : i;
    }
  }
  const items = Array.isArray(d.conditions) ? d.conditions : Array.isArray(d.conditions?.items) ? d.conditions.items : null;
  if (items && items.length) { out.conditions = items; if (items.some((c) => c && typeof c === "object" && (c as { type?: string }).type === "session")) out.regularSessionOnly = true; }
  return out;
}

/** 目标式任务的会话内交接（/start 「准备真实运行」→ /agent 目标表单预填）：只在本浏览器 sessionStorage */
export const GOAL_DRAFT_KEY = "verify_goal_draft_v1";
export interface GoalDraft {
  objective: string;
  strategy: string;
  assetKeys: string[];
  inputAssetKey: string;
  totalHuman: string;
  perStepHuman: string;
  maxSteps: number;
  days: number;
  trustTier: "platform_only" | "agent_data" | "agent_research";
  watch: string[];
  regularOnly: boolean;
  exampleId?: string;
}
export function stashGoalDraft(d: GoalDraft): boolean {
  try {
    sessionStorage.setItem(GOAL_DRAFT_KEY, JSON.stringify(d));
    return sessionStorage.getItem(GOAL_DRAFT_KEY) === JSON.stringify(d);
  } catch {
    return false;
  }
}
export function takeGoalDraft(): GoalDraft | null {
  try {
    const raw = sessionStorage.getItem(GOAL_DRAFT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(GOAL_DRAFT_KEY);
    const d = JSON.parse(raw) as GoalDraft;
    return d && typeof d === "object" && typeof d.objective === "string" ? d : null;
  } catch {
    return null;
  }
}
