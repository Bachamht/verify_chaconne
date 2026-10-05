/**
 * 日志回执（v8 /agent/journal，方案 §5.8）：把一天的 recap（含 Agent 段）换成一条条「回执」：
 * 动作 / 变了什么 / 证据 / 时间 / 可撤销？
 * 规则：
 *  - 动作文字一律走 lib/activityText 的 humanizeActivity；系统写的英文 note 不显示。
 *  - Agent 自己写的话（declined 的理由、改主意条件、决策摘要）作为「原话」引用保留，并标明是 Agent 原话。
 *  - 「没有回应」这类系统等待按任务合并成一条，避免整屏重复。
 *  - 签发不等于成交；只有链上确认的才算成交（产品语义）。
 * 纯函数，无 React；test/v8JournalLab.test.ts 用真实样本覆盖。
 */
import { deepActionHref } from "@/lib/useDeepAction";
import { agentQuoteLabel } from "@/components/kit/AgentQuote";
import type { RecapView } from "@/lib/api-v2";
import type { Locale } from "@/lib/i18n";
import { humanizeActivity, type ActivityCtx, type AssetLite } from "@/lib/activityText";
import { groupDecimal, rawToDecimal } from "@/lib/numbers";
import type { Tone } from "@/lib/status";

export type ReceiptKind = "fill" | "certified" | "declined" | "needs_data" | "no_response" | "ended" | "fault" | "recovery" | "other";
/** no：已成交，撤不回 · onchain：可链上撤销 · reclaim：可收回额度 · none：没改变任何东西，无需撤销 */
export type Revocable = "no" | "onchain" | "reclaim" | "none";

export interface Receipt {
  id: string;
  at: string;
  taskId: string | null;
  kind: ReceiptKind;
  /** 做了什么（本地化一句话） */
  action: string;
  /** 变了什么（本地化一句话） */
  changed: string;
  tone: Tone;
  evidence: { kind: "tx" | "intent" | "none"; value: string | null };
  revocable: Revocable;
  /** Agent 原话（按它的策略语言，不翻译） */
  quote: string | null;
  /** Agent 原话：什么情况下它会再行动 */
  nextIf: string | null;
  /** 合并的条数（no_response） */
  count: number;
}

type Agent = NonNullable<RecapView["agent"]>;
const L = (locale: Locale, zh: string, en: string) => (locale === "zh" ? zh : en);
const near = (a: string, b: string, ms = 5_000) => Math.abs(Date.parse(a) - Date.parse(b)) <= ms;

function findAsset(assets: readonly AssetLite[], needle: string | null | undefined): AssetLite | null {
  if (!needle) return null;
  const n = needle.toLowerCase();
  return assets.find((a) => a.assetKey.toLowerCase() === n || a.displaySymbol.toLowerCase() === n || a.tokenAddress.toLowerCase() === n || n.endsWith(a.tokenAddress.toLowerCase())) ?? null;
}
function fmt(raw: string | null | undefined, asset: AssetLite | null): string | null {
  if (!raw || !asset) return null;
  const d = rawToDecimal(raw, asset.tokenDecimals, asset.role === "stable_input" ? 2 : 6);
  return d === null ? null : `${groupDecimal(d)} ${asset.displaySymbol}`;
}

const REVOCABLE: Record<Revocable, { zh: string; en: string; hintZh: string; hintEn: string; tone: Tone }> = {
  no: { zh: "不可撤销", en: "Final", hintZh: "已在链上成交，无法撤回。", hintEn: "Filled on-chain; it cannot be undone.", tone: "muted" },
  onchain: { zh: "可链上撤销", en: "Revocable on-chain", hintZh: "证书过期前仍可能执行。暂停或取消任务只停止签发新证书；要彻底停止，到任务页做链上撤销。", hintEn: "The certificate may still execute until it expires. Pausing or cancelling only stops new certificates; to stop for good, revoke on-chain from the task page.", tone: "warn" },
  reclaim: { zh: "可收回额度", en: "Allowance reclaimable", hintZh: "任务结束不会自动收回链上额度；需要的话到「资金」收回。", hintEn: "Ending a task does not reclaim the on-chain allowance; reclaim it under Funds if you want.", tone: "info" },
  none: { zh: "无需撤销", en: "Nothing to undo", hintZh: "这一条没有改变额度或持仓。", hintEn: "This entry changed no allowance or holding.", tone: "muted" },
};
export function revocableMeta(r: Revocable, locale: Locale): { label: string; hint: string; tone: Tone } {
  const m = REVOCABLE[r];
  return { label: locale === "zh" ? m.zh : m.en, hint: locale === "zh" ? m.hintZh : m.hintEn, tone: m.tone };
}

/** 原话标签：中文页遇到不含中文的原话，明确写「英文原文，未翻译」 */
/** 原话标签：唯一来源在 kit 的 agentQuoteLabel */
export function quoteLabel(quote: string, locale: Locale, kind: "said" | "nextIf" = "said"): string {
  return agentQuoteLabel(quote, locale, kind);
}

const NOTHING = (l: Locale) => L(l, "没有交易，额度和持仓都没变", "No trade; allowance and holdings unchanged");

export function buildReceipts(recap: Pick<RecapView, "sections" | "agent">, ctx: ActivityCtx): Receipt[] {
  const { locale, assets } = ctx;
  const a: Agent | undefined = recap.agent;
  const out: Receipt[] = [];
  const base = (id: string, at: string, taskId: string | null, kind: ReceiptKind): Receipt => ({ id, at, taskId, kind, action: "", changed: "", tone: "neutral", evidence: { kind: "none", value: null }, revocable: "none", quote: null, nextIf: null, count: 1 });

  const actions = Array.isArray(a?.actions?.items) ? a!.actions.items : [];
  const runs = Array.isArray(a?.runs?.items) ? a!.runs.items : [];
  const waits = Array.isArray(a?.waits) ? a!.waits : [];
  const fills = Array.isArray(a?.fills) ? a!.fills : [];
  // 意图 → 资产（成交回执要知道买的是哪只）；意图 → Agent 的决策摘要
  const legOf = new Map<string, AssetLite | null>();
  const summaryOf = new Map(runs.filter((r) => r.action?.kind === "intent" && r.decisionSummary).map((r) => [r.action!.ref, r.decisionSummary!]));

  actions.forEach((it, i) => {
    const h = humanizeActivity({ id: i, at: it.at, actor: it.actor, type: it.type, note: it.note }, ctx);
    const r = base(`a${i}`, it.at, it.taskId, "other");
    r.action = h.text;
    r.tone = h.tone;
    const note = it.note ?? "";
    if (it.type === "intent_certified") {
      const m = note.match(/^intent (\S+) certified: (buy|sell) (\S+) \d+ → step (\d+)/);
      if (m) legOf.set(`${it.taskId}:${m[4]}`, findAsset(assets, m[3]));
      Object.assign(r, { kind: "certified", changed: L(locale, "签发了步骤证书，等链上执行（签发不等于成交）", "A step certificate was issued and awaits on-chain execution (issued is not filled)"), evidence: { kind: "intent", value: m?.[1] ?? null }, revocable: "onchain", quote: m ? summaryOf.get(m[1]!) ?? null : null });
    } else if (it.type === "agent_declined" || it.type === "agent_needs_evidence") {
      const w = waits.find((x) => x.taskId === it.taskId && x.type === it.type && near(x.at, it.at));
      Object.assign(r, { kind: it.type === "agent_declined" ? "declined" : "needs_data", changed: NOTHING(locale), quote: h.quote, nextIf: w?.invalidation ?? null });
    } else if (it.type === "agent_ended") {
      Object.assign(r, { kind: "ended", changed: L(locale, "任务结束；链上额度不会自动收回", "Task ended; the on-chain allowance is not reclaimed automatically"), revocable: "reclaim", quote: h.quote });
    } else {
      Object.assign(r, { changed: NOTHING(locale), quote: h.quote });
    }
    out.push(r);
  });

  // 等待：已在 actions 里出现的 Agent 决定不重复；系统的「没有回应」按任务合并
  const silent = new Map<string, Receipt>();
  waits.forEach((w, i) => {
    if (actions.some((x) => x.taskId === w.taskId && x.type === w.type && near(x.at, w.at))) return;
    if (w.type === "agent_no_response") {
      const cur = silent.get(w.taskId);
      if (cur) { cur.count += 1; if (Date.parse(w.at) > Date.parse(cur.at)) cur.at = w.at; return; }
      silent.set(w.taskId, { ...base(`w${i}`, w.at, w.taskId, "no_response"), changed: NOTHING(locale) });
      return;
    }
    const h = humanizeActivity({ id: i, at: w.at, actor: w.actor, type: w.type, note: w.note }, ctx);
    out.push({ ...base(`w${i}`, w.at, w.taskId, w.type === "agent_needs_evidence" ? "needs_data" : "declined"), action: h.text, changed: NOTHING(locale), quote: h.quote, nextIf: w.actor.startsWith("agent") ? w.invalidation : null });
  });
  for (const r of silent.values()) {
    r.action = r.count > 1 ? L(locale, `Agent 有 ${r.count} 轮没有回应`, `The agent did not answer ${r.count} rounds`) : L(locale, "Agent 这一轮没有回应", "The agent did not answer this round");
    out.push(r);
  }

  const seenTx = new Set<string>();
  fills.forEach((f, i) => {
    if (f.txHash) seenTx.add(f.txHash.toLowerCase());
    const h = humanizeActivity({ id: i, at: f.at, actor: "system", type: "step_confirmed", data: { stepIndex: f.stepIndex, spentRaw: f.spentRaw, txHash: f.txHash } }, ctx);
    const got = fmt(f.receivedRaw, legOf.get(`${f.taskId}:${f.stepIndex}`) ?? null);
    const verb = f.side === "sell" ? L(locale, "卖出", "Sold") : L(locale, "买入", "Bought");
    out.push({ ...base(`f${i}`, f.at, f.taskId, "fill"), action: h.text, tone: "ok", changed: got ? `${verb} ${got}` : L(locale, `${verb}成交，数量见交易`, `${verb}; see the transaction for the amount`), evidence: { kind: "tx", value: f.txHash }, revocable: "no" });
  });
  // 旧式授权计划（mandate）的成交：不在 Agent 段里
  (recap.sections?.trades ?? []).forEach((t, i) => {
    if (t.txHash && seenTx.has(t.txHash.toLowerCase())) return;
    const inA = findAsset(assets, t.inputAssetKey);
    const outA = findAsset(assets, t.outputAssetKey);
    const paid = fmt(t.amountInRaw, inA);
    const got = fmt(t.receivedRaw, outA);
    out.push({ ...base(`t${i}`, t.at, null, "fill"), action: L(locale, `第 ${t.stepIndex + 1} 步已在链上成交`, `Step ${t.stepIndex + 1} filled on-chain`), tone: "ok", changed: [paid && L(locale, `花 ${paid}`, `paid ${paid}`), got && L(locale, `得到 ${got}`, `received ${got}`)].filter(Boolean).join(L(locale, "，", ", ")) || L(locale, "数量见交易", "See the transaction for amounts"), evidence: { kind: "tx", value: t.txHash }, revocable: "no" });
  });

  [...(a?.faults ?? []).map((x) => ({ ...x, rec: false })), ...(a?.recoveries ?? []).map((x) => ({ ...x, rec: true }))].forEach((x, i) => {
    const h = humanizeActivity({ id: i, at: x.at, actor: x.actor, type: x.type, note: x.note }, ctx);
    out.push({ ...base(`x${i}`, x.at, x.taskId, x.rec ? "recovery" : "fault"), action: x.rec ? L(locale, "执行问题已自动恢复", "An execution problem recovered automatically") : h.text, tone: x.rec ? "ok" : "bad", changed: x.rec ? L(locale, "恢复后照常运行", "Running normally again") : L(locale, "这一步没有成交", "This step did not fill"), quote: h.quote });
  });

  return out.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
}

/** 「需要你决定」里服务端没映射到 lib/reasons 的码（不露英文原文） */
const DECISION_TEXT: Record<string, { zh: string; en: string }> = {
  CANCELLED_OFFCHAIN: { zh: "服务端取消只停止签发新证书；已签发且未过期的证书仍可能执行。要彻底停止，到任务页做链上撤销。", en: "Service-side cancel only stops new certificates; an issued, unexpired certificate may still execute. Revoke on-chain from the task page to stop for good." },
};
export function decisionText(code: string, locale: Locale): string | null {
  return DECISION_TEXT[code]?.[locale] ?? null;
}
/**
 * 决定项的去处：直接到能做这件事的地方。收回额度 → 资金页的额度区；链上撤销 → 任务页（或早期授权计划页）并直接打开撤销确认框；
 * 待签授权 → 任务页并打开委托签名面板；继续 → 任务页并打开「继续还是取消」；复核 / 续期 → 任务页（「需要我处理什么」在页面顶部）。
 */
export function decisionHref(d: { action: string; refId: string }): string {
  if (d.action === "reclaim") return "/agent/funds#allowances";
  const page = d.refId.startsWith("tsk_") ? `/agent/tasks/${d.refId}` : d.refId.startsWith("mnd_") ? `/tasks/${d.refId}` : null;
  if (!page) return "/agent/tasks";
  if (d.action === "revoke") return deepActionHref(page, "revoke");
  if (d.action === "authorize" && page.startsWith("/agent/")) return deepActionHref(page, "delegate");
  if (d.action === "resume" && page.startsWith("/agent/")) return deepActionHref(page, "decide");
  return page;
}

/**
 * 日志是当天收盘后的快照；「需要你决定」按任务的实时状态核一遍（10/5 走查：已取消 / 已删除的任务还在日志里要你处理）。
 * live = 现在的任务状态（任务列表没拿到时传 null → 一律当作未处理）；列表里没有 = 已删除。
 * 早期授权计划（mnd_）与收回额度这里核不了，保持未处理。
 */
export type DecisionState = "open" | "done" | "deleted";
const ENDED = new Set(["COMPLETED", "CANCELLED", "REVOKED", "EXPIRED"]);
export function decisionState(d: { action: string; refId: string }, live: ReadonlyMap<string, string> | null): DecisionState {
  if (!live || !d.refId.startsWith("tsk_") || d.action === "reclaim") return "open";
  const s = live.get(d.refId);
  if (s === undefined) return "deleted";
  if (d.action === "revoke") return s === "REVOKED" ? "done" : "open";
  if (d.action === "authorize") return s === "AWAITING_AUTHORIZATION" ? "open" : "done";
  if (d.action === "resume") return s === "PAUSED" ? "open" : "done";
  return ENDED.has(s) ? "done" : "open";
}

/** 决定项按钮上的字：说清点了去做什么 */
export function decisionLabel(action: string, locale: Locale): string {
  const zh = locale === "zh";
  if (action === "revoke") return zh ? "去链上撤销" : "Revoke on-chain";
  if (action === "reclaim") return zh ? "去收回额度" : "Reclaim allowance";
  if (action === "authorize") return zh ? "去签名" : "Sign now";
  if (action === "resume") return zh ? "继续或取消" : "Resume or cancel";
  return zh ? "去任务里处理" : "Handle in the task";
}

/** 交易日翻页：跳过周六日（节假日由服务端返回 pending / 空日志说明） */
export function shiftTradingDay(date: string, delta: 1 | -1): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  do d.setUTCDate(d.getUTCDate() + delta);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
/** 交易日 YYYY-MM-DD →「10月2日 周五」/「Fri, Oct 2」；页面不直出 ISO 日期（E3） */
export function dayText(date: string, locale: Locale): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return L(locale, "日期未返回", "Date not returned");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (locale === "zh") return `${Number(m[2])}月${Number(m[3])}日 ${new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(d)}`;
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

/** 当天链上成交数：与回执列表同口径（Agent 段成交 + 旧式授权计划成交，去重后） */
export function fillCounts(receipts: readonly Receipt[], agentFills: ReadonlyArray<{ side?: string | null }>): { total: number; buy: number; sell: number; legacy: number } {
  const total = receipts.filter((r) => r.kind === "fill").length;
  const sell = agentFills.filter((f) => f.side === "sell").length;
  const buy = agentFills.length - sell;
  return { total, buy, sell, legacy: Math.max(0, total - agentFills.length) };
}

export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
