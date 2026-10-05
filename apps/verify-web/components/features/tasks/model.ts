/**
 * v8 任务列表的纯逻辑（无 React，test/v8Tasks.test.ts 覆盖）。
 * 数据来源两路合并：GET /v1/tasks?owner（浏览器建的任务，完整 Task）+ GET /v1/records?owner（全部记录，含 Agent 接入 key 建的任务、
 * 任务模式与授权花费）。走查问题：用 key 建的任务只出现在「全部记录」，这里按 id 合并成一张表，records 独有的再单独取详情补齐。
 */
import type { Task } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import type { RecordItem } from "@/lib/api-v2";
import { hasReasonText, reasonText } from "@/lib/reasons";
import { isTerminal, taskUiStatus, type UiStatus } from "@/lib/status";
import { groupDecimal, rawToDecimal } from "@/lib/numbers";
import { playbookTitle } from "@/components/agent/tasks/taskTitle";

export interface AssetInfo { assetKey: string; displaySymbol: string; tokenDecimals: number; role?: string }

export type TaskMode = "LIVE" | "SIMULATION";
export type StatusGroup = "active" | "needs_you" | "paused" | "ended";
export const GROUP_LABEL: Record<StatusGroup, { zh: string; en: string }> = {
  active: { zh: "进行中", en: "Active" },
  needs_you: { zh: "需要你", en: "Needs you" },
  paused: { zh: "已暂停", en: "Paused" },
  ended: { zh: "已结束", en: "Ended" },
};

export interface TaskRow {
  id: string;
  title: string;
  status: UiStatus;
  rawStatus: string;
  group: StatusGroup;
  mode: TaskMode | null;
  side: "buy" | "sell";
  /** 股票名（不露合约地址；未登记的写「未登记资产」） */
  stocks: string[];
  /** 买入授权已花费（稳定币最小单位）；观察任务 / 不可知 = null */
  spentRaw: string | null;
  capRaw: string | null;
  /** 稳定币未知 → null（金额显示「未返回」，不猜 USDG / 6 位） */
  stableSymbol: string | null;
  stableDecimals: number | null;
  next: NextStep;
  updatedAt: string;
  createdAt: string;
  /** 真实任务才有；buy 任务不显示「最多可卖」，只说是否允许卖出 */
  allowSell: boolean;
  task: Task | null;
}

export interface NextStep { text: string; at: string | null; label: "next_check" | "since" | null }

const L = (locale: Locale, zh: string, en: string) => (locale === "zh" ? zh : en);
const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function assetOf(assets: readonly AssetInfo[], key: string | null | undefined): AssetInfo | null {
  return key ? assets.find((a) => eq(a.assetKey, key)) ?? null : null;
}
export function assetName(assets: readonly AssetInfo[], key: string | null | undefined, locale: Locale): string {
  return assetOf(assets, key)?.displaySymbol ?? L(locale, "未登记资产", "Unlisted asset");
}

export function statusGroup(s: UiStatus): StatusGroup {
  if (s === "paused") return "paused";
  if (s === "needs_you" || s === "revoking") return "needs_you";
  if (isTerminal(s)) return "ended";
  return "active";
}

/** 阻塞项一句话：有映射用本地化短句；未映射的码不露 SNAKE_CASE（英文页可用服务端原句） */
export function blockerLine(b: { code: string; text?: string | null }, locale: Locale): string {
  if (hasReasonText(b.code)) return reasonText(b.code, locale);
  if (locale === "en" && b.text) return b.text;
  return L(locale, "另有一项条件暂未满足", "Another condition is not met yet");
}

export function nextStep(task: Pick<Task, "status" | "blockers" | "nextCheckAt" | "updatedAt">, locale: Locale): NextStep {
  const s = task.status;
  if (s === "PAUSED") return { text: L(locale, "已暂停，打开可继续或取消", "Paused; open to resume or cancel"), at: task.updatedAt, label: "since" };
  if (s === "AWAITING_AUTHORIZATION") return { text: L(locale, "等你完成委托清单里的签名", "Waiting for your signatures in the delegation checklist"), at: null, label: null };
  if (s === "REVOKE_PENDING") return { text: L(locale, "等链上撤销确认", "Waiting for the on-chain revocation"), at: task.updatedAt, label: "since" };
  if (s === "DRAFT") return { text: L(locale, "草稿，尚未开始", "Draft; not started"), at: null, label: null };
  if (isTerminal(taskUiStatus(s))) return { text: L(locale, "已结束，不再签发新步骤", "Ended; no further steps"), at: null, label: null };
  const blockers = task.blockers ?? [];
  if (blockers.length > 0) {
    const more = blockers.length > 1 ? L(locale, `（还有 ${blockers.length - 1} 项）`, ` (+${blockers.length - 1})`) : "";
    return { text: `${blockerLine(blockers[0]!, locale)}${more}`, at: task.nextCheckAt, label: task.nextCheckAt ? "next_check" : null };
  }
  if (task.nextCheckAt) return { text: L(locale, "按计划检查条件", "Checks conditions on schedule"), at: task.nextCheckAt, label: "next_check" };
  return { text: L(locale, "等 Agent 下一轮判断", "Waiting for the agent's next round"), at: null, label: null };
}

/** 卖出授权在记录里以股票作为输入：输入不是稳定币就是卖出授权，不计入「预算已用」 */
export function isBuyMandate(m: Pick<RecordItem, "inputAssetKey">, assets: readonly AssetInfo[], stableKey?: string | null): boolean {
  if (stableKey && eq(m.inputAssetKey, stableKey)) return true;
  const a = assetOf(assets, m.inputAssetKey);
  return a ? a.role === "stable_input" : false;
}

function sumRaw(values: Array<string | undefined>): string | null {
  let total = 0n;
  let any = false;
  for (const v of values) {
    if (!v || !/^\d+$/.test(v)) continue;
    total += BigInt(v);
    any = true;
  }
  return any ? total.toString() : null;
}

/** 某任务的买入花费：该任务名下买入授权的 spent 之和；没有授权时为 0（真实任务）；观察任务、记录没拿到（mandates = null）返回 null */
export function spentForTask(taskId: string, mode: TaskMode | null, mandates: readonly RecordItem[] | null, assets: readonly AssetInfo[], stableKey?: string | null): string | null {
  if (mode === "SIMULATION" || mandates === null) return null;
  const mine = mandates.filter((m) => m.kind === "mandate" && m.taskId === taskId && isBuyMandate(m, assets, stableKey));
  if (mine.length === 0) return mode === "LIVE" ? "0" : null;
  return sumRaw(mine.map((m) => m.spent));
}

function human(raw: unknown, a: AssetInfo | null): string | null {
  if (typeof raw !== "string" || !a) return null;
  const d = rawToDecimal(raw, a.tokenDecimals, 2);
  return d === null ? null : `${groupDecimal(d)} ${a.displaySymbol}`;
}

/** 人类标题：目标式任务 = 目标原文；模板任务 = 模板 · 股票名 · 每步金额 × 步数。永不出现合约地址 / tsk_ id */
export function rowTitle(task: Pick<Task, "playbookId" | "scope">, params: Record<string, unknown> | null | undefined, stocks: readonly string[], stable: AssetInfo | null, locale: Locale): string {
  const objective = task.scope?.objective?.trim();
  if (task.playbookId === "agent_goal" && objective) return objective;
  const per = human(params?.["perStepAmountRaw"] ?? params?.["amountRaw"], stable);
  const steps = typeof params?.["steps"] === "number" ? (params["steps"] as number) : null;
  const amount = per ? (steps && steps > 1 ? `${per} × ${steps}` : per) : null;
  return [playbookTitle(task.playbookId, locale), stocks.join(" + ") || null, amount].filter(Boolean).join(" · ");
}

/** 记录里的任务（没有完整 Task 时）→ 最小 Task 形状，供标题与下一步使用 */
function taskFromRecord(r: RecordItem): Task {
  const out = r.outputAssetKeys?.[0];
  return {
    id: r.id, owner: "0x0" as Task["owner"], playbookId: (r.playbookId ?? "agent_goal") as Task["playbookId"],
    goal: { side: r.side ?? "buy", legs: out ? [{ outputAssetKey: out, weightBps: 10000 }] : [], budget: { amountInRaw: r.amountInRaw ?? "0", inputAssetKeys: r.inputAssetKey ? [r.inputAssetKey] : [] } } as unknown as Task["goal"],
    conditions: { version: "conditions/1", items: [] } as unknown as Task["conditions"],
    mandateIds: [], status: (r.status ?? "WAITING") as Task["status"], blockers: [], nextCheckAt: null, executorPresence: "offline",
    createdAt: r.createdAt as Task["createdAt"], updatedAt: r.createdAt as Task["updatedAt"],
  };
}

export interface MergeInput {
  listed: readonly Task[];
  /** records 里独有任务的详情（GET /v1/tasks/:id），取不到就用记录本身 */
  details: Readonly<Record<string, { task: Task; mode?: TaskMode | null; params?: Record<string, unknown> }>>;
  records: readonly RecordItem[] | null;
  assets: readonly AssetInfo[];
  locale: Locale;
}

export function mergeTaskRows({ listed, details, records, assets, locale }: MergeInput): TaskRow[] {
  const recTasks = new Map((records ?? []).filter((r) => r.kind === "task").map((r) => [r.id, r]));
  // 记录没拿到 → null：预算「已用」显示未返回，不当 0
  const mandates = records ? records.filter((r) => r.kind === "mandate") : null;
  const seen = new Set<string>();
  const rows: TaskRow[] = [];
  const push = (task: Task, rec: RecordItem | undefined, mode0: TaskMode | null | undefined, params0: Record<string, unknown> | undefined, full: boolean) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    const mode: TaskMode | null = mode0 ?? (rec?.mode === "LIVE" || rec?.mode === "SIMULATION" ? rec.mode : task.mandateIds.length > 0 ? "LIVE" : null);
    const sell = task.goal?.side === "sell";
    const stableKey = sell ? task.goal?.legs?.[0]?.outputAssetKey : task.scope?.inputAssetKey ?? task.goal?.budget?.inputAssetKeys?.[0];
    const stable = assetOf(assets, stableKey) ?? assets.find((a) => a.role === "stable_input") ?? null;
    const stockKeys = sell ? task.goal?.budget?.inputAssetKeys ?? [] : task.scope?.outputAssetKeys ?? task.goal?.legs?.map((l) => l.outputAssetKey) ?? [];
    const status = taskUiStatus(task.status);
    const stocks = [...new Set(stockKeys.map((k) => assetName(assets, k, locale)))];
    rows.push({
      id: task.id,
      title: rowTitle(task, params0 ?? rec?.params ?? null, stocks, stable, locale),
      status, rawStatus: task.status, group: statusGroup(status), mode, side: sell ? "sell" : "buy",
      stocks,
      spentRaw: spentForTask(task.id, mode, mandates, assets, stableKey),
      capRaw: task.scope?.budgetCapRaw ?? task.goal?.budget?.amountInRaw ?? rec?.amountInRaw ?? null,
      stableSymbol: stable?.displaySymbol ?? null, stableDecimals: stable?.tokenDecimals ?? null,
      next: nextStep(task, locale), updatedAt: task.updatedAt ?? task.createdAt, createdAt: task.createdAt,
      allowSell: !sell && task.scope?.allowSell === true,
      task: full ? task : null,
    });
  };
  for (const t of listed) push(t, recTasks.get(t.id), undefined, undefined, true);
  for (const [id, rec] of recTasks) {
    const d = details[id];
    if (d) push(d.task, rec, d.mode ?? null, d.params, true);
    else push(taskFromRecord(rec), rec, undefined, undefined, false);
  }
  return rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** records 里有、/v1/tasks 列表里没有的任务 id（Agent 接入 key 建的任务） */
export function recordOnlyTaskIds(listed: readonly Pick<Task, "id">[], records: readonly RecordItem[] | null): string[] {
  const ids = new Set(listed.map((t) => t.id));
  return (records ?? []).filter((r) => r.kind === "task" && !ids.has(r.id)).map((r) => r.id);
}

export { STATUS_GROUPS, deleteConsequence, filterRows, groupCounts, parseGroup, parseMode, type TaskFilter } from "./filters";
