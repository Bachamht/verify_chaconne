/** 任务的人类标题与状态文案（V-32）：「分段定投 · AAPLx · 2 USDG × 3 步」，不用 tsk_ id 当标题。纯函数，页面与测试共用。 */
import type { Task, TaskStatus } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import { formatAmount } from "@/lib/format";
import { hasReasonText, reasonText } from "@/lib/reasons";

/** 阻塞项一句话：有映射用本地化短句，没有就用接口给的 text（不露原始码） */
export function blockerSentence(b: { code: string; text?: string }, locale: Locale): string {
  return hasReasonText(b.code) ? reasonText(b.code, locale) : b.text || b.code;
}

export interface AssetLike { assetKey: string; displaySymbol: string; tokenDecimals: number }

const PLAYBOOK: Record<string, { en: string; zh: string }> = {
  session_dca: { en: "Session DCA", zh: "分段定投" },
  event_aware_accumulate: { en: "Event-aware accumulate", zh: "避开事件的加仓" },
  discount_watch: { en: "Discount watch", zh: "折价观察" },
  target_sell: { en: "Target sell", zh: "目标价卖出" },
  portfolio_rebalance: { en: "Portfolio rebalance", zh: "组合再平衡" },
  agent_goal: { en: "Agent task", zh: "Agent 任务" },
};
export function playbookTitle(id: string, locale: Locale): string {
  return PLAYBOOK[id]?.[locale] ?? id;
}

const STATUS: Record<TaskStatus, { en: string; zh: string }> = {
  DRAFT: { en: "Draft", zh: "草稿" },
  AWAITING_AUTHORIZATION: { en: "Awaiting your signature", zh: "等你签授权" },
  ACTIVE: { en: "Active", zh: "运行中" },
  WAITING: { en: "Waiting", zh: "等待中" },
  STEP_PREPARED: { en: "Step ready", zh: "本步已就绪" },
  PARTIAL: { en: "Partially done", zh: "部分完成" },
  COMPLETED: { en: "Completed", zh: "已完成" },
  PAUSED: { en: "Paused", zh: "已暂停" },
  REVOKE_PENDING: { en: "Revoking on-chain", zh: "链上撤销中" },
  REVOKED: { en: "Revoked", zh: "已撤销" },
  EXPIRED: { en: "Expired", zh: "已到期" },
  CANCELLED: { en: "Cancelled", zh: "已取消" },
};
export function statusLabel(status: string, locale: Locale): string {
  return STATUS[status as TaskStatus]?.[locale] ?? status;
}

const find = (assets: AssetLike[], key: string | undefined) => (key ? assets.find((a) => a.assetKey.toLowerCase() === key.toLowerCase()) ?? null : null);
const short = (k: string) => (k.includes(":") ? `${k.split(":")[2]?.slice(0, 6)}…${k.slice(-4)}` : k);

/** 标题：模板 · 股票符号 · 每步金额 × 步数（有 params）或 · 总额（只有 goal） */
export function taskTitle(task: Pick<Task, "playbookId" | "goal" | "scope">, params: Record<string, unknown> | null | undefined, assets: AssetLike[], locale: Locale): string {
  const zh = locale === "zh";
  const sell = task.goal?.side === "sell";
  const stockKey = sell ? task.goal?.budget?.inputAssetKeys?.[0] : task.goal?.legs?.[0]?.outputAssetKey;
  const stableKey = sell ? task.goal?.legs?.[0]?.outputAssetKey : task.goal?.budget?.inputAssetKeys?.[0];
  const stock = find(assets, stockKey);
  const stable = find(assets, stableKey);
  const stockName = stock?.displaySymbol ?? (stockKey ? short(stockKey) : "—");
  const dec = stable?.tokenDecimals ?? 6;
  const sym = stable?.displaySymbol ?? "";
  const per = typeof params?.["perStepAmountRaw"] === "string" ? (params["perStepAmountRaw"] as string) : null;
  const one = typeof params?.["amountRaw"] === "string" ? (params["amountRaw"] as string) : null;
  const steps = typeof params?.["steps"] === "number" ? (params["steps"] as number) : null;
  let amount: string;
  if (per && steps) amount = `${formatAmount(per, dec, sym)} × ${steps} ${zh ? "步" : "step(s)"}`;
  else if (one) amount = steps && steps > 1 ? `${formatAmount(one, dec, sym)} × ${steps} ${zh ? "步" : "step(s)"}` : formatAmount(one, dec, sym);
  else if (task.goal?.budget?.amountInRaw) amount = `${zh ? "共" : "total"} ${formatAmount(task.goal.budget.amountInRaw, dec, sym)}`;
  else amount = "";
  // 目标式任务：标题就是目标本身
  if (task.playbookId === "agent_goal" && task.scope?.objective) return task.scope.objective;
  return [playbookTitle(task.playbookId, locale), stockName, amount].filter(Boolean).join(" · ");
}
