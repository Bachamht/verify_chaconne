/** 事件台 v8 文案（zh / en 各自纯净；中文不用破折号）。动作名沿用旧事件台的口径。 */
import type { ImpactAction } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";

const C = {
  title: { zh: "事件台", en: "Event desk" },
  subtitle: { zh: "看看接下来哪些事件可能影响你的任务，以及 Agent 打算怎么应对。", en: "See which upcoming events may affect your tasks, and how the agent plans to respond." },
  range: { zh: "范围", en: "Range" },
  hours: { zh: "小时", en: "h" },
  only_relevant: { zh: "只看相关", en: "Relevant only" },
  all_assets: { zh: "全部资产", en: "All assets" },
  asset: { zh: "资产", en: "Asset" },
  source_line: { zh: "事件日历", en: "Event calendar" },
  updated: { zh: "更新于", en: "Updated" },
  heartbeat: { zh: "心跳", en: "Heartbeat" },
  deviation: { zh: "偏差", en: "Deviation" },
  not_returned: { zh: "未返回", en: "Not returned" },
  impact_checking: { zh: "影响分析核对中", en: "Checking impacts" },
  impact_checked: { zh: "影响已核对", en: "Impacts checked" },
  impact_failed: { zh: "服务端影响核对没有完成，下面按你的任务条件在本地推算", en: "The server impact check did not finish; the list below is worked out from your task conditions" },
  tasks_n: { zh: "个任务", en: "tasks" },
  task_1: { zh: "个任务", en: "task" },
  no_task: { zh: "无任务", en: "No tasks" },
  tasks_unknown: { zh: "任务未返回", en: "Tasks not returned" },
  tasks_error: { zh: "你的任务没有读到，暂时判断不了哪些事件相关", en: "Could not read your tasks, so relevance cannot be worked out yet" },
  estimated: { zh: "估计", en: "Estimated" },
  date_only: { zh: "全天", en: "All day" },
  empty_title: { zh: "这个范围内没有事件", en: "No events in this range" },
  empty_desc: { zh: "日历里确实没有排期，不是读取失败。可以把范围放宽到 72 小时。", en: "Nothing is scheduled; this is not a loading failure. Try widening the range to 72 hours." },
  empty_rel_title: { zh: "没有会影响你任务的事件", en: "No events affect your tasks" },
  empty_rel_desc: { zh: "你未结束的任务都没有命中这个范围内的事件。关掉「只看相关」可以看全部。", en: "None of your open tasks match an event in this range. Turn off Relevant only to see all." },
  show_all: { zh: "看全部事件", en: "Show all events" },
  widen: { zh: "放宽到 72 小时", en: "Widen to 72 hours" },
  load_error: { zh: "事件日历没有读到", en: "Could not read the event calendar" },
  tab_detail: { zh: "详情", en: "Details" },
  tab_coverage: { zh: "财报覆盖", en: "Earnings coverage" },
  when: { zh: "时间", en: "When" },
  kind: { zh: "类型", en: "Type" },
  status: { zh: "状态", en: "Status" },
  source: { zh: "来源", en: "Source" },
  assets: { zh: "相关资产", en: "Assets" },
  freshness: { zh: "数据新鲜度", en: "Freshness" },
  hits_h: { zh: "Agent 会怎么做", en: "What the agent will do" },
  hits_none: { zh: "你未结束的任务都不受这个事件影响。", en: "None of your open tasks is affected by this event." },
  hits_skipped: { zh: "已结束的任务不计算影响。", en: "Finished tasks are not evaluated." },
  window_active: { zh: "暂停中，结束于", en: "Paused until" },
  window_upcoming: { zh: "暂停开始于", en: "Pause starts" },
  window_over: { zh: "窗口已结束", en: "Window over" },
  blockers_h: { zh: "服务端当前判断", en: "Current server view" },
  macro_note: { zh: "宏观事件只标注可能相关，供研究参考，不说成必然的方向。", en: "Macro events are flagged as possibly related, for research only; a link is not a claim of direction." },
  more: { zh: "更多", en: "More" },
  for_task: { zh: "作用于", en: "For" },
  no_exec: { zh: "这些动作只产生建议、预览或草案，不会发出任何执行。", en: "These actions produce suggestions, previews or drafts only; nothing is executed." },
  pause_title: { zh: "暂停这个任务的后续签发？", en: "Pause further issuance for this task?" },
  pause_body: { zh: "Agent 不再为这个任务签发新的买入意图。已签的链上授权不会被撤销，额度保持不变；之后可以在任务页恢复。", en: "The agent stops issuing new buy intents for this task. Signed on-chain authorizations are not revoked and allowances stay as they are; you can resume from the task page." },
  pause_confirm: { zh: "暂停后续签发", en: "Pause issuance" },
  action_failed: { zh: "没有完成", en: "Did not complete" },
  nothing_changed: { zh: "任务没有任何改动", en: "Nothing about the task changed" },
  action_blocked_local: { zh: "本地只读环境不会发出写操作。", en: "This local read-only environment does not send writes." },
  preview_no_auth: { zh: "只是预览：不改真实任务、不写任何授权。", en: "Preview only: the real task and your authorization are untouched." },
  preview_same: { zh: "新计划与现计划没有差异。", en: "The new plan does not differ from the current one." },
  evidence_none: { zh: "暂无证据记录；估计日期的事件来源还没有发布正式记录。", en: "No evidence record yet; for estimated dates the source has not published a record." },
  evidence_n: { zh: "条证据", en: "evidence record(s)" },
  open_task: { zh: "查看任务", en: "Open task" },
  whole_day: { zh: "整日等待", en: "Wait the whole day" },
  cov_desc: { zh: "财报日历源：Finnhub（源没有确认字段，日期一律按估计）。未覆盖的资产写「未知」，不等于「没有财报」。", en: "Earnings source: Finnhub (it has no confirmation field, so dates are estimates). Uncovered assets show Unknown, which does not mean no earnings." },
  cov_next: { zh: "下一份财报", en: "Next report" },
  cov_probed: { zh: "最近探测", en: "Last probed" },
  cov_state: { zh: "覆盖", en: "Coverage" },
  cov_corp: { zh: "公司行动（拆股、分红、停牌）未接入：这里不显示「未发生」。", en: "Corporate actions (splits, dividends, halts) are not connected; nothing here means none happened." },
  cov_empty: { zh: "登记表里没有股票资产。", en: "No stock assets in the registry." },
} satisfies Record<string, { zh: string; en: string }>;

export type CopyKey = keyof typeof C;
export const copy = (locale: Locale) => (k: CopyKey): string => C[k][locale];

export const ACTION_LABEL: Record<ImpactAction, { zh: string; en: string }> = {
  preview_new_plan: { zh: "预览条件变更", en: "Preview condition change" },
  view_evidence: { zh: "查看依据", en: "View evidence" },
  create_watch_task: { zh: "创建观察任务", en: "Create watch task" },
  keep_plan: { zh: "保持现计划", en: "Keep current plan" },
  wait_by_rule: { zh: "按已有规则等待", en: "Wait by existing rule" },
  pause_issuance: { zh: "暂停后续签发", en: "Pause further issuance" },
};

export const EVENT_STATUS: Record<string, { zh: string; en: string }> = {
  estimated: { zh: "估计日期", en: "Estimated" },
  confirmed: { zh: "已确认", en: "Confirmed" },
  revised: { zh: "已改期", en: "Rescheduled" },
  cancelled: { zh: "已取消", en: "Cancelled" },
  released: { zh: "已发布", en: "Released" },
};

export const COVERAGE: Record<string, { zh: string; en: string; tone: "ok" | "warn" | "neutral" | "muted" }> = {
  covered: { zh: "已覆盖", en: "Covered", tone: "ok" },
  unknown: { zh: "未知", en: "Unknown", tone: "warn" },
  unavailable: { zh: "源不可用", en: "Source unavailable", tone: "warn" },
  not_probed: { zh: "尚未探测", en: "Not probed yet", tone: "muted" },
};

/** 来源串 → 人能读的名字；认不出就取最后一段并去掉前缀 */
const SOURCE: Record<string, { zh: string; en: string }> = {
  "crowsnest.fred": { zh: "FRED 经济数据", en: "FRED" },
  "crowsnest.bea": { zh: "美国经济分析局", en: "BEA" },
  "crowsnest.bls": { zh: "美国劳工统计局", en: "BLS" },
  "crowsnest.eia": { zh: "美国能源信息署", en: "EIA" },
  "crowsnest.ism": { zh: "ISM 采购经理指数", en: "ISM" },
  "crowsnest.umich": { zh: "密歇根大学", en: "University of Michigan" },
  "crowsnest.treasury": { zh: "美国财政部", en: "US Treasury" },
  "crowsnest.fedcal": { zh: "联储日程", en: "Fed calendar" },
  "crowsnest.fedrule": { zh: "联储静默期规则", en: "Fed blackout rule" },
  "crowsnest.yaml": { zh: "人工维护日程", en: "Curated calendar" },
  "crowsnest.queue": { zh: "海外数据日程", en: "International calendar" },
  "crowsnest.nyse": { zh: "纽交所日历", en: "NYSE calendar" },
  finnhub: { zh: "Finnhub 财报日历", en: "Finnhub earnings calendar" },
};
export function sourceName(src: string, locale: Locale): string {
  return SOURCE[src]?.[locale] ?? (locale === "zh" ? "其它数据源" : "Other source");
}
