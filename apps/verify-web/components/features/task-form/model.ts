/**
 * 任务表单（/start 第 1 步与 /agent/new 共用）的纯逻辑：模板 → 草稿、字段错误、服务端 400 字段映射、
 * 建任务结果分类、范围摘要的「这意味着什么」三行人话。无 React，test/v8TaskForm.test.ts 覆盖。
 * 草稿模型就是 /start 的 StartDraft（modelV7）；资金币种（inputAssetKey）作为可选字段挂在草稿上，缺省 = 登记表默认稳定币。
 */
import type { AssetEntry } from "@/lib/assets";
import { assetByKey, defaultStable, stablesOf } from "@/lib/assets";
import type { Locale } from "@/lib/i18n";
import { apiError, fieldErrorText } from "@/lib/errors";
import { COMPLEX_TASKS } from "@/components/agent/home/entries";
import { signaturePreview } from "@/components/agent/delegation/delegationModel";
import { createFailureKind, validateStartDraft, type StartDraft } from "@/components/onboarding/modelV7";

export type FormDraft = StartDraft & { inputAssetKey?: string };
export type FieldId = "objective" | "assets" | "inputAsset" | "total" | "perStep" | "maxSteps" | "days" | "strategy" | "conditions";
export type FieldErrors = Partial<Record<FieldId, string>>;

export const MAX_ASSETS = 8;
export const TEMPLATES = COMPLEX_TASKS;

/** 模板 → 草稿（与 v7 /start 的 fromTemplate 同一结果；预算默认 10 / 单笔 2 / 最多 5 笔） */
export function draftFromTemplate(i: number, stockKeys: readonly string[], locale: Locale, keep?: Pick<FormDraft, "inputAssetKey">): FormDraft {
  const t = TEMPLATES[i] ?? TEMPLATES[0]!;
  return {
    objective: t.objective[locale], strategy: t.strategy[locale], assetKeys: stockKeys.slice(0, t.assets), totalHuman: "100", perStepHuman: "20",
    maxSteps: Math.min(t.steps, 5), days: t.days, allowSell: false, regularOnly: !!t.regularSessionOnly, trustTier: t.trustTier, watch: [...t.watch], exampleId: t.id,
    ...(keep?.inputAssetKey ? { inputAssetKey: keep.inputAssetKey } : {}),
  };
}

/** 草稿选中的资金币种；没选或已不在登记表 → 默认稳定币 */
export function stableOf(draft: Pick<FormDraft, "inputAssetKey"> | null | undefined, assets: AssetEntry[]): AssetEntry | null {
  return assetByKey(stablesOf(assets), draft?.inputAssetKey) ?? defaultStable(assets);
}

/** 本地校验 → 字段错误（文案在 copy.ts，这里给字段 → 错误码） */
export function localFieldErrors(d: FormDraft, assets: AssetEntry[], tradable: readonly string[]): Partial<Record<FieldId, string>> {
  const stable = stableOf(d, assets);
  const out: Partial<Record<FieldId, string>> = {};
  if (!stable) out.inputAsset = "inputAsset";
  for (const e of validateStartDraft(d, stable)) out[e] = e;
  const lower = new Set(tradable.map((k) => k.toLowerCase()));
  if (!out.assets && d.assetKeys.some((k) => !lower.has(k.toLowerCase()))) out.assets = "unavailable";
  return out;
}

/** 服务端字段路径 → 表单字段（去掉 params. / scope. 前缀与数组下标） */
const SERVER_FIELD: Record<string, FieldId> = {
  objective: "objective",
  outputAssetKeys: "assets", outputAssetKey: "assets", assets: "assets",
  inputAssetKey: "inputAsset",
  budgetCapRaw: "total", amountRaw: "total", budget: "total",
  perStepCapRaw: "perStep", perStepAmountRaw: "perStep",
  maxSteps: "maxSteps", steps: "maxSteps",
  deadline: "days",
  strategy: "strategy",
  hardConditions: "conditions", conditions: "conditions",
};
export function serverFieldOf(path: string): FieldId | null {
  const key = path.replace(/^(params|scope|body)\./, "").replace(/\[\d+\]/g, "").split(".")[0] ?? "";
  return SERVER_FIELD[key] ?? null;
}

/** 落不到表单字段的服务端路径 → 人话名称（不露 params.xxx[0] 这类原始路径）；查不到用「其他设置」 */
const REST_FIELD_LABEL: Record<string, { zh: string; en: string }> = {
  ownerAddress: { zh: "钱包地址", en: "Wallet address" }, owner: { zh: "钱包地址", en: "Wallet address" },
  mode: { zh: "任务模式", en: "Task mode" },
  trustTier: { zh: "信任级别", en: "Trust level" },
  allowSell: { zh: "卖出授权", en: "Sell permission" }, sellAssetKeys: { zh: "卖出授权", en: "Sell permission" },
  regularSessionOnly: { zh: "交易时段", en: "Trading hours" }, regularOnly: { zh: "交易时段", en: "Trading hours" },
  watch: { zh: "关注事件", en: "Watched events" }, watchlist: { zh: "关注事件", en: "Watched events" },
  title: { zh: "任务标题", en: "Task title" },
  signature: { zh: "签名", en: "Signature" },
};
export function restFieldLabel(path: string, locale: Locale): string {
  const key = path.replace(/^(params|scope|body)\./, "").replace(/\[\d+\]/g, "").split(".")[0] ?? "";
  return REST_FIELD_LABEL[key]?.[locale] ?? (locale === "zh" ? "其他设置" : "Another setting");
}

/** 400 的 details[] → 字段错误 + 落不到字段上的剩余项（显示在表单顶部） */
export function mapServerDetails(details: unknown, locale: Locale): { fields: FieldErrors; rest: string[] } {
  const fields: FieldErrors = {};
  const rest: string[] = [];
  if (!Array.isArray(details)) return { fields, rest };
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    const f = (d as { field?: unknown }).field;
    const c = (d as { code?: unknown }).code;
    const text = fieldErrorText(typeof c === "string" ? c : "invalid", locale);
    const id = typeof f === "string" ? serverFieldOf(f) : null;
    if (id) { if (!fields[id]) fields[id] = text; }
    else rest.push(typeof f === "string" ? `${restFieldLabel(f, locale)}${locale === "zh" ? "：" : ": "}${text}` : text);
  }
  return { fields, rest };
}

export type CreateOutcome =
  | { kind: "ok"; id: string }
  | { kind: "fields"; fields: FieldErrors; rest: string[] }
  | { kind: "hosted_closed" }
  | { kind: "sim_limit" }
  | { kind: "unreachable" }
  | { kind: "mismatch" }
  | { kind: "other"; message: string };

/** POST /v1/tasks 的结果分类：成功还要核对模式与 owner（返回的任务与请求不一致就停） */
export function classifyCreate(r: { status: number; data: unknown } | null, expect: { mode: "SIMULATION" | "LIVE"; owner: string }, locale: Locale): CreateOutcome {
  if (!r || r.status === 0) return { kind: "unreachable" };
  if (r.status === 200 || r.status === 201) {
    const c = r.data as { mode?: string; task?: { id?: string; owner?: string } } | null;
    if (!c?.task?.id || c.mode !== expect.mode || c.task.owner?.toLowerCase() !== expect.owner.toLowerCase()) return { kind: "mismatch" };
    return { kind: "ok", id: c.task.id };
  }
  if (r.status === 400) {
    const m = mapServerDetails((r.data as { details?: unknown } | null)?.details, locale);
    if (Object.keys(m.fields).length || m.rest.length) return { kind: "fields", ...m };
  }
  const kind = createFailureKind(r);
  if (kind !== "other") return { kind };
  return { kind: "other", message: apiError(r, locale) };
}

/** 真实运行要签几次：买入 2 次 + 每只允许卖出的股票再加 2（链上额度已够时更少，这是上限） */
export function signatureCount(d: Pick<FormDraft, "allowSell" | "assetKeys">): number {
  return signaturePreview(d.allowSell ? d.assetKeys.length : 0, d.allowSell);
}

/** 显示用字段错误：服务端优先，其次本地校验（本地给的是码，copy 里翻成人话） */
export function displayErrors(local: Partial<Record<FieldId, string>>, server: FieldErrors, copyOf: (code: string) => string): FieldErrors {
  const out: FieldErrors = {};
  for (const [k, code] of Object.entries(local) as Array<[FieldId, string]>) out[k] = copyOf(code);
  return { ...out, ...server };
}

/** 折叠态摘要的一句概要：「10 USDG · 2 只股票 · 只买入」 */
export function peekText(d: FormDraft, symbol: string, locale: Locale): string {
  const zh = locale === "zh";
  const n = d.assetKeys.length;
  return [
    `${d.totalHuman || "—"} ${symbol}`.trim(),
    zh ? `${n} 只股票` : `${n} ${n === 1 ? "stock" : "stocks"}`,
    d.allowSell ? (zh ? "买入，也允许卖出" : "buy and sell") : (zh ? "只买入" : "buy only"),
  ].join(" · ");
}

/** 摘要「这意味着什么」：花钱上限 / 方向 / 签名，三行人话 */
export function meaningLines(d: FormDraft, symbol: string, locale: Locale): [string, string, string] {
  const zh = locale === "zh";
  const n = d.assetKeys.length;
  const spend = zh
    ? `Agent 最多花 ${d.totalHuman} ${symbol}，每笔不超过 ${d.perStepHuman} ${symbol}，最多成交 ${d.maxSteps} 笔，${d.days} 天后到期。`
    : `The agent spends at most ${d.totalHuman} ${symbol}, no more than ${d.perStepHuman} ${symbol} per trade, up to ${d.maxSteps} fills, and stops after ${d.days} days.`;
  const dir = d.allowSell
    ? (zh ? `它可以买入，也可以卖出这 ${n} 只股票；卖出包含你钱包里原有的持仓，不限于本任务买入的部分。` : `It may buy and also sell these ${n} stocks; selling includes holdings already in your wallet, not only what this task bought.`)
    : (zh ? `它只会买入你选的 ${n} 只股票，不会卖出钱包里的任何持仓。` : `It only buys the ${n} stocks you chose and never sells anything in your wallet.`);
  const sign = zh
    ? `观察不签名、不执行交易，Agent 也可能选择等待。转为真实运行，买入最多要签 2 次${d.allowSell ? "，每只可以卖出的股票再加 2 次" : ""}；签名不是交易，额度已经设好时会更少。只有链上确认才算成交，任务结束不会撤销已有的额度。`
    : `Observations do not sign or execute trades, and the agent may choose to wait. Going live may require up to two signatures for a buy${d.allowSell ? ", plus two for each stock it may sell" : ""}, but these are not transactions and fewer may be needed if allowances are already set. Only an on-chain confirmation counts as a fill, and ending a task does not revoke existing allowances.`;
  return [spend, dir, sign];
}
