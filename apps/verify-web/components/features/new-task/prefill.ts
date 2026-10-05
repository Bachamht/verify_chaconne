/**
 * /agent/new 的预填（方案 §5.4）：?from=draft|event|compare|replay。纯函数，test/v8TaskForm.test.ts 覆盖。
 *
 * 入口约定（各页链接用 newTaskHref 生成）：
 *  - draft：草案 / 「准备真实运行」交接。读本标签页 sessionStorage 里的两种草稿（taskDraft.ts 的 stashDraft / stashGoalDraft），读后即删。
 *  - event：事件卡「创建观察任务」。查询串 asset（可多个）、event（事件 id，只做说明）、eventName、objective。
 *  - compare：双策略对照。查询串 asset、task（对照的任务 id）。
 *  - replay：历史回放。查询串 asset（assetKey 或股票代码，如 AAPLx）。
 * 所有来源都还认旧查询串：inputAssetKey、perStepAmountRaw（最小单位）、steps、days、allowSell=1。
 * 预填只给起点：不带金额以外的旧授权、不带旧报价；不在登记表里的股票直接丢掉并计数。
 */
import type { AssetEntry } from "@/lib/assets";
import type { Locale } from "@/lib/i18n";
import { rawToDecimal } from "@/lib/numbers";
import { presetFromDraft, type DraftHandoff, type GoalDraft } from "@/components/agent/tasks/taskDraft";
import { draftFromTemplate, TEMPLATES, type FormDraft } from "../task-form/model";

export { FROM_SOURCES, fromSourceOf, newTaskHref, type FromSource } from "./href";
import type { FromSource } from "./href";

export interface PrefillCtx { stocks: AssetEntry[]; stables: AssetEntry[] }
export interface Prefill { patch: Partial<FormDraft>; dropped: number }

const lc = (s: string) => s.toLowerCase();
function resolveStock(needle: string, ctx: PrefillCtx): string | null {
  const n = lc(needle.trim());
  if (!n) return null;
  return ctx.stocks.find((a) => lc(a.assetKey) === n || lc(a.displaySymbol) === n)?.assetKey ?? null;
}
function resolveStable(needle: string | null | undefined, ctx: PrefillCtx): AssetEntry | null {
  if (!needle) return null;
  return ctx.stables.find((a) => lc(a.assetKey) === lc(needle)) ?? null;
}
const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : typeof v === "string" && /^\d{1,4}$/.test(v) && Number(v) > 0 ? Number(v) : undefined);

/** 每笔 × 笔数 → 总预算（十进制串，按币种精度，不经过浮点） */
export function totalOf(perHuman: string, steps: number, decimals: number): string | null {
  if (!/^\d+(\.\d+)?$/.test(perHuman) || !Number.isInteger(steps) || steps < 1) return null;
  const [i = "0", f = ""] = perHuman.split(".");
  if (f.length > decimals) return null;
  const raw = BigInt(i + f.padEnd(decimals, "0")) * BigInt(steps);
  return rawToDecimal(raw, decimals, decimals);
}

export function prefillFromGoal(g: GoalDraft): Partial<FormDraft> {
  return {
    objective: g.objective, strategy: g.strategy, assetKeys: g.assetKeys, inputAssetKey: g.inputAssetKey, totalHuman: g.totalHuman, perStepHuman: g.perStepHuman,
    maxSteps: g.maxSteps, days: g.days, trustTier: g.trustTier, watch: g.watch, regularOnly: g.regularOnly, exampleId: g.exampleId ?? null,
  };
}

export function prefillFromHandoff(d: DraftHandoff, ctx: PrefillCtx): Partial<FormDraft> {
  const decimalsOf = (k: string) => resolveStable(k, ctx)?.tokenDecimals ?? null;
  const p = presetFromDraft(d, decimalsOf);
  const out: Partial<FormDraft> = {};
  const keys = [p.outputAssetKey, ...(p.extraAssetKeys ?? [])].filter((k): k is string => !!k);
  if (keys.length) out.assetKeys = [...new Set(keys.map(lc))];
  if (p.inputAssetKey) out.inputAssetKey = p.inputAssetKey;
  if (p.perStepHuman) out.perStepHuman = p.perStepHuman;
  if (p.steps) out.maxSteps = p.steps;
  if (p.objective) out.objective = p.objective;
  if (p.allowSell !== undefined) out.allowSell = p.allowSell;
  if (p.regularSessionOnly) out.regularOnly = true;
  if (p.trustTier) out.trustTier = p.trustTier;
  const dec = p.inputAssetKey ? decimalsOf(p.inputAssetKey) : null;
  if (p.perStepHuman && p.steps && dec !== null) { const t = totalOf(p.perStepHuman, p.steps, dec); if (t) out.totalHuman = t; }
  return out;
}

export function prefillFromQuery(q: URLSearchParams, ctx: PrefillCtx): Partial<FormDraft> {
  const out: Partial<FormDraft> = {};
  const assets = q.getAll("asset").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (assets.length) out.assetKeys = assets;
  const objective = q.get("objective")?.trim();
  if (objective) out.objective = objective.slice(0, 500);
  const stable = resolveStable(q.get("inputAssetKey"), ctx);
  if (stable) out.inputAssetKey = stable.assetKey;
  const steps = posInt(q.get("steps"));
  if (steps) out.maxSteps = steps;
  const days = posInt(q.get("days"));
  if (days) out.days = days;
  if (q.get("allowSell") === "1") out.allowSell = true;
  const raw = q.get("perStepAmountRaw");
  const dec = (stable ?? ctx.stables.find((a) => /^USDG$/i.test(a.displaySymbol)) ?? ctx.stables[0])?.tokenDecimals;
  if (raw && /^\d+$/.test(raw) && dec !== undefined) {
    const per = rawToDecimal(raw, dec, dec);
    if (per && per !== "0") { out.perStepHuman = per; if (steps) { const t = totalOf(per, steps, dec); if (t) out.totalHuman = t; } }
  }
  return out;
}

/** 合并三种来源（查询串打底，草稿覆盖），股票只留登记表里可交易的；返回丢掉了几只 */
export function resolvePrefill(input: { query: URLSearchParams; handoff: DraftHandoff | null; goal: GoalDraft | null }, ctx: PrefillCtx): Prefill {
  const patch: Partial<FormDraft> = { ...prefillFromQuery(input.query, ctx), ...(input.handoff ? prefillFromHandoff(input.handoff, ctx) : {}), ...(input.goal ? prefillFromGoal(input.goal) : {}) };
  let dropped = 0;
  if (patch.assetKeys) {
    const kept: string[] = [];
    for (const k of patch.assetKeys) { const r = resolveStock(k, ctx); if (r && !kept.includes(r)) kept.push(r); else if (!r) dropped++; }
    patch.assetKeys = kept.slice(0, 8);
    if (!kept.length) delete patch.assetKeys;
  }
  if (patch.inputAssetKey && !resolveStable(patch.inputAssetKey, ctx)) delete patch.inputAssetKey;
  return { patch, dropped };
}

/** 预填后用哪个模板高亮：草稿带 exampleId 就用它；带了自己的目标 / 策略就不高亮（-1）；否则第一个 */
export function templateFor(patch: Partial<FormDraft>): number {
  if (patch.exampleId) { const i = TEMPLATES.findIndex((t) => t.id === patch.exampleId); if (i >= 0) return i; }
  return patch.objective !== undefined || patch.strategy !== undefined ? -1 : 0;
}

/** 预填后的起始草稿：模板打底，补丁覆盖；不高亮模板时清掉模板策略（不让别的模板的策略冒充这份草稿的） */
export function prefilledDraft(patch: Partial<FormDraft>, stockKeys: readonly string[], locale: Locale): { draft: FormDraft; template: number } {
  const template = templateFor(patch);
  const base = draftFromTemplate(Math.max(0, template), stockKeys, locale);
  if (template < 0) { base.strategy = ""; base.exampleId = null; }
  return { draft: { ...base, ...patch }, template };
}

/** 预填来源的一句说明（页面顶部，提醒核对） */
export function prefillNote(from: FromSource, locale: Locale, extra: { dropped: number; eventName?: string | null; taskId?: string | null }): string {
  const zh = locale === "zh";
  const head = {
    draft: zh ? "已从草案预填" : "Prefilled from a draft",
    event: zh ? (extra.eventName ? `已按事件「${extra.eventName}」预填` : "已按事件预填") : (extra.eventName ? `Prefilled from the event "${extra.eventName}"` : "Prefilled from an event"),
    compare: zh ? "已从双策略对照预填" : "Prefilled from the two-policy comparison",
    replay: zh ? "已从历史回放预填" : "Prefilled from a replay",
  }[from];
  const tail = zh ? "。核对股票、预算和方向后再创建。" : ". Check the stocks, budget and direction before creating.";
  const drop = extra.dropped ? (zh ? `有 ${extra.dropped} 只股票当前不可交易，已移除。` : ` ${extra.dropped} stock(s) are not tradable now and were removed.`) : "";
  return `${head}${tail}${drop}`;
}
