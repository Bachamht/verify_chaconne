/**
 * 活动流的人话（v8）：服务端事件 → 本地化一句话 + 人类单位。
 * 走查问题（10/3）：系统消息是英文原文、金额是最小单位（"spent 2000000"、"agent_goal LIVE (goal task…)"）。
 * 规则：系统 / 执行器写的 note 一律不直接显示（只放开发者视图）；只有 Agent 自己的话（declined / ended / needs_evidence 等）
 * 作为「原话」引用，因为那是它按策略语言写的判断，不能改写。
 * 纯函数，无 React，test/v8Activity.test.ts 覆盖真实样本。
 */
import type { Locale } from "./i18n";
import { groupDecimal, rawToDecimal } from "./numbers";
import { STATUS_META, taskUiStatus, type Tone } from "./status";
import { activityCategory, type ActivityCategory } from "./activityCategory";

export interface ActivityLike {
  id: string | number;
  at: string;
  actor: string;
  type: string;
  ref?: string | null;
  note?: string | null;
  data?: Record<string, unknown> | null;
}

export interface AssetLite { assetKey: string; tokenAddress: string; tokenDecimals: number; displaySymbol: string; role?: string }

export interface ActivityText {
  /** 本地化的一句话（不含原始码 / 最小单位） */
  text: string;
  /** Agent 的原话（按它的策略语言），可为空 */
  quote: string | null;
  category: ActivityCategory;
  tone: Tone;
  txHash: string | null;
  /** 下次检查（Agent 决定等待时） */
  nextCheckAt: string | null;
  /** 次要：只是状态流转回声，列表可降级显示 */
  minor: boolean;
}

/** stableAssetKey：任务的输入稳定币（task.goal.budget.inputAssetKeys[0]）；不给就用登记表第一个稳定币 */
export type ActivityCtx = { locale: Locale; assets: readonly AssetLite[]; stableAssetKey?: string | null };
type Ctx = ActivityCtx;

const L = (locale: Locale, zh: string, en: string) => (locale === "zh" ? zh : en);

function assetBy(ctx: Ctx, needle: string | null | undefined): AssetLite | null {
  if (!needle) return null;
  const n = needle.toLowerCase();
  return ctx.assets.find((a) => a.assetKey.toLowerCase() === n || a.tokenAddress.toLowerCase() === n || a.displaySymbol.toLowerCase() === n || n.endsWith(a.tokenAddress.toLowerCase())) ?? null;
}
function stable(ctx: Ctx): AssetLite | null {
  return (ctx.stableAssetKey ? assetBy(ctx, ctx.stableAssetKey) : null) ?? ctx.assets.find((a) => a.role === "stable_input") ?? null;
}
function amount(raw: unknown, asset: AssetLite | null): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (!asset) return null;
  const dec = rawToDecimal(String(raw), asset.tokenDecimals, asset.role === "stable_input" ? 2 : 6);
  return dec === null ? null : `${groupDecimal(dec)} ${asset.displaySymbol}`;
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

const TURN_REASON: Record<string, { zh: string; en: string }> = {
  ready_for_intent: { zh: "条件都在范围内，等 Agent 决定", en: "conditions are inside your scope; the agent decides next" },
  authorized: { zh: "委托完成，Agent 可以在签好的范围内行动", en: "delegation is complete; the agent may act inside the signed scope" },
  step_confirmed: { zh: "上一步已成交，Agent 重新评估", en: "the last step filled; the agent reassesses" },
  scheduled: { zh: "到了 Agent 预约的检查时间", en: "the agent's scheduled check is due" },
  data_arrived: { zh: "等的数据到了", en: "the data it waited for arrived" },
  event: { zh: "关注的事件有新进展", en: "a watched event moved" },
  owner_note: { zh: "你更新了指示", en: "you updated the brief" },
};

/** 系统写的已知短句 → 人话；认不出返回 null（不显示原文） */
function knownSystemNote(note: string, ctx: Ctx): string | null {
  const { locale } = ctx;
  let m: RegExpMatchArray | null;
  if (/^delegation: buy authorization and allowance are ready/i.test(note)) return L(locale, "买入授权和额度都已就绪，任务开始运行", "Buy authorization and allowance are ready; the task is running");
  if ((m = note.match(/^(\d+)\/(\d+) steps confirmed/i))) return L(locale, `已确认 ${m[1]}/${m[2]} 步`, `${m[1]} of ${m[2]} steps confirmed`);
  if (/^certificate issued on agent intent/i.test(note)) return L(locale, "已为 Agent 的意图签发步骤证书（签发不等于成交）", "Step certificate issued for the agent's intent (issued is not filled)");
  if (/^paused on the agent's ended report/i.test(note)) return L(locale, "Agent 报告结束，任务在服务端暂停；链上额度不会自动收回", "The agent reported it is done; the task paused service-side. On-chain allowance is not reclaimed automatically");
  if (/^buy authorization completed and no task position left to sell/i.test(note)) return L(locale, "买入次数用完，本任务也没有可卖的持仓，任务完成", "Buy steps are used up and no task position is left to sell; the task is complete");
  return null;
}

export function humanizeActivity(it: ActivityLike, ctx: Ctx): ActivityText {
  const { locale } = ctx;
  const d = (it.data ?? {}) as Record<string, unknown>;
  const note = str(it.note) ?? "";
  const category = activityCategory(it);
  const base: ActivityText = { text: "", quote: null, category, tone: "neutral", txHash: str(d["txHash"]), nextCheckAt: str(d["nextCheckAt"]), minor: false };
  const agentSpoke = it.actor.startsWith("agent:") && !["created", "authorized", "permit_submitted"].includes(it.type);
  let m: RegExpMatchArray | null;

  switch (it.type) {
    case "created": {
      const mode = /\bLIVE\b/.test(note) ? L(locale, "真实任务", "live task") : /\bSIMULATION\b/.test(note) ? L(locale, "观察任务（模拟）", "observation task (simulation)") : L(locale, "任务", "task");
      const own = /agent's own strategy/i.test(note) ? L(locale, "，按 Agent 自己的策略", ", using the agent's own strategy") : "";
      return { ...base, text: L(locale, `创建了${mode}${own}`, `Created a ${mode}${own}`), tone: "brand" };
    }
    case "status": {
      const to = str(d["to"]);
      const known = note ? knownSystemNote(note, ctx) : null;
      const label = to ? STATUS_META[taskUiStatus(to)][locale] : null;
      return { ...base, text: known ?? (label ? L(locale, `任务状态：${label}`, `Task status: ${label}`) : L(locale, "任务状态更新", "Task status updated")), minor: !known, tone: to === "COMPLETED" ? "ok" : to === "PAUSED" ? "warn" : "neutral" };
    }
    case "authorized": {
      if (str(d["side"]) === "sell" || /^sell authorization/i.test(note)) {
        const key = note.match(/sell authorization (\S+)/)?.[1] ?? null;
        const a = assetBy(ctx, key);
        return { ...base, text: L(locale, `签了卖出授权：${a?.displaySymbol ?? "一只股票"}`, `Signed a sell authorization: ${a?.displaySymbol ?? "one stock"}`), tone: "info" };
      }
      return { ...base, text: L(locale, "签了买入授权（签名，不是交易）", "Signed the buy authorization (a signature, not a transaction)"), tone: "info" };
    }
    case "permit_submitted": {
      const a = assetBy(ctx, str(d["token"]));
      const amt = amount(d["value"], a);
      return { ...base, text: L(locale, `签了 ${a?.displaySymbol ?? "代币"} 额度许可${amt ? `（${amt}）` : ""}，由平台执行身份代为上链，你不用发交易`, `Signed a ${a?.displaySymbol ?? "token"} allowance permit${amt ? ` (${amt})` : ""}; the platform executor relays it, you send no transaction`), tone: "info" };
    }
    case "permit_confirmed": {
      const a = assetBy(ctx, str(d["token"]));
      return { ...base, text: L(locale, `${a?.displaySymbol ?? "代币"} 额度已在链上生效`, `${a?.displaySymbol ?? "Token"} allowance is set on-chain`), tone: "ok" };
    }
    case "delegation_completed": {
      const s = num(d["signatures"]);
      const tx = num(d["userTransactions"]);
      return { ...base, text: L(locale, `委托完成：签名 ${s ?? "—"} 次，你发起的交易 ${tx ?? "—"} 笔`, `Delegation complete: ${s ?? "—"} signatures, ${tx ?? "—"} transactions from you`), tone: "ok" };
    }
    case "agent_turn": {
      const v = num(d["turnVersion"]);
      const reason = str(d["reason"]);
      const why = reason && TURN_REASON[reason] ? TURN_REASON[reason][locale] : L(locale, "Agent 开始新一轮分析", "the agent starts a new round");
      return { ...base, text: L(locale, `第 ${v ?? "—"} 轮：${why}`, `Round ${v ?? "—"}: ${why}`), category: "research", minor: true };
    }
    case "intent_certified": {
      if ((m = note.match(/certified: (buy|sell) (\S+) (\d+) → step (\d+)/))) {
        const out = assetBy(ctx, m[2]);
        const side = m[1] === "sell";
        const amt = side ? amount(m[3], out) : amount(m[3], stable(ctx));
        const step = Number(m[4]) + 1;
        return { ...base, text: side ? L(locale, `Agent 提出卖出 ${amt ?? m[2]}，核验通过，签发第 ${step} 步证书`, `The agent proposed selling ${amt ?? m[2]}; checks passed, step ${step} certificate issued`) : L(locale, `Agent 提出用 ${amt ?? "—"} 买入 ${out?.displaySymbol ?? m[2]}，核验通过，签发第 ${step} 步证书`, `The agent proposed buying ${out?.displaySymbol ?? m[2]} with ${amt ?? "—"}; checks passed, step ${step} certificate issued`), tone: "brand" };
      }
      return { ...base, text: L(locale, "Agent 的意图通过核验，已签发步骤证书", "The agent's intent passed the checks; a step certificate was issued"), tone: "brand" };
    }
    case "step_confirmed": {
      const idx = num(d["stepIndex"]);
      const amt = amount(d["spentRaw"], stable(ctx));
      return { ...base, text: L(locale, `${idx !== null ? `第 ${idx + 1} 步` : "一步"}已在链上成交${amt ? `，花费 ${amt}` : ""}`, `${idx !== null ? `Step ${idx + 1}` : "A step"} filled on-chain${amt ? `, spent ${amt}` : ""}`), tone: "ok", category: "fill_confirmed" };
    }
    case "agent_declined":
      return { ...base, text: L(locale, "Agent 决定这一轮先不交易", "The agent decided not to trade this round"), quote: note || null, category: "waiting" };
    case "agent_ended":
      return { ...base, text: L(locale, "Agent 判断任务完成，结束了任务", "The agent judged the task done and ended it"), quote: note || null, tone: "ok", category: "ended" };
    case "agent_needs_evidence":
      return { ...base, text: L(locale, "Agent 在等数据，先不行动", "The agent is waiting for data before acting"), quote: note || null, category: "waiting_data" };
  }
  // 兜底：类别文案；Agent 自己写的话作为原话，系统原文不显示
  const fallback = CATEGORY_TEXT[category] ?? CATEGORY_TEXT.other!;
  return { ...base, text: fallback[locale], quote: agentSpoke && note ? note : null, tone: category === "exec_failed" || category === "intent_rejected" ? "bad" : category === "fill_confirmed" ? "ok" : "neutral" };
}

const CATEGORY_TEXT: Partial<Record<ActivityCategory, { zh: string; en: string }>> = {
  research: { zh: "Agent 在研究", en: "The agent is researching" },
  quote: { zh: "查询了可成交报价", en: "Checked an executable quote" },
  intent_buy: { zh: "Agent 提交了买入意图", en: "The agent submitted a buy intent" },
  intent_sell: { zh: "Agent 提交了卖出意图", en: "The agent submitted a sell intent" },
  intent_rejected: { zh: "Agent 的意图没通过核验，没有签发", en: "The agent's intent failed the checks; nothing was issued" },
  certified: { zh: "步骤证书已签发（签发不等于成交）", en: "Step certificate issued (issued is not filled)" },
  tx_sent: { zh: "交易已广播，等链上确认", en: "Transaction broadcast; waiting for on-chain confirmation" },
  fill_confirmed: { zh: "链上成交已确认", en: "Fill confirmed on-chain" },
  exec_failed: { zh: "执行没有成功", en: "Execution did not go through" },
  recovered: { zh: "已自动恢复", en: "Recovered automatically" },
  waiting: { zh: "等待中", en: "Waiting" },
  waiting_data: { zh: "等数据：实际值还没出来", en: "Waiting for data: actual figures are not out yet" },
  data_arrived: { zh: "等的实际值到了", en: "The actual figures arrived" },
  plan_revised: { zh: "Agent 修订了计划", en: "The agent revised its plan" },
  decision: { zh: "Agent 做出了决定", en: "The agent made a decision" },
  delegation: { zh: "委托有更新", en: "Delegation updated" },
  permit: { zh: "额度有更新", en: "Allowance updated" },
  control: { zh: "暂停 / 继续 / 取消", en: "Pause / resume / cancel" },
  ended: { zh: "Agent 结束了任务", en: "The agent ended the task" },
  other: { zh: "其它活动", en: "Other activity" },
};

export const ACTOR_LABEL: Record<string, { zh: string; en: string }> = {
  owner: { zh: "你", en: "You" },
  "agent:hosted": { zh: "Chaconne Agent", en: "Chaconne Agent" },
  "agent:byo": { zh: "你的 Agent", en: "Your agent" },
  "executor:hosted": { zh: "平台执行", en: "Platform executor" },
  system: { zh: "系统", en: "System" },
};
export function actorLabel(actor: string, locale: Locale): string {
  return (ACTOR_LABEL[actor] ?? (actor.startsWith("agent") ? ACTOR_LABEL["agent:hosted"]! : actor.startsWith("executor") ? ACTOR_LABEL["executor:hosted"]! : ACTOR_LABEL["system"]!))[locale];
}
