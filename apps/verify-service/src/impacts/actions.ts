/**
 * 事件卡六个动作（E-05）。每个动作只产生：证据视图 / 任务草案 / 等待计划 / 暂停签发 / 预览——**不发任何执行**（E-07）；
 * 响应固定带 `executed:false`、`issuesExecution:false`，且永远不含 calldata / 证书 / 签名。
 * 依赖 Lane B 任务命令的动作在其未就绪时返回 `effect:'not_ready'`（页面显示「任务服务未就绪」，不假成功）。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import type { AssetRegistry, Blocker, Condition, EvidenceRecord, IMPACT_ACTIONS, ImpactAction, IsoUtc, MarketEvent, TaskStatus } from "@chaconne/core/verify";
import { evaluateRule, matchRules } from "../events/earnings/window";
import type { EventStore, EvidenceSink } from "../events/earnings/store";
import { COMPANY_KINDS } from "./impacts";
import type { TaskCommands, TaskLite, TasksReader, WatchTaskDraft } from "./readers";
import { reasonText } from "./reasonText";

export type ActionEffect = "evidence" | "created" | "attached" | "draft" | "kept" | "wait" | "needs_choice" | "paused" | "preview" | "not_ready" | "invalid";

export interface ActionRequest {
  owner: string;
  eventId: string;
  action: ImpactAction;
  taskId?: string | null;
  /** wait_by_rule：日期只到天时用户此刻选择整日等待（不预选则提示选择） */
  wholeDayIfDayPrecision?: boolean;
  /** create_watch_task：新任务参数（未给用默认的 SIMULATION 观察任务） */
  params?: Record<string, unknown>;
  clientRequestId?: string;
}

export interface ActionResult {
  action: ImpactAction;
  eventId: string;
  taskId: string | null;
  effect: ActionEffect;
  /** 固定 false：影响清单只产生动作建议，不发任何执行 */
  executed: false;
  issuesExecution: false;
  mode: "SIMULATION" | null;
  code?: string;
  message: { zh: string; en: string };
  evidence?: EvidenceRecord[];
  draft?: WatchTaskDraft | { taskId: string; condition: Condition; requiresNewAuthorization: boolean; draftId: string | null };
  nextCheckAt?: IsoUtc | null;
  blockers?: Blocker[];
  taskStatus?: TaskStatus;
  preview?: { proposedConditions: Condition[]; diff: Array<{ itemType: Condition["type"]; before: unknown; after: unknown }>; writesAuthorization: false };
}

export interface ActionDeps {
  store: EventStore;
  evidence: EvidenceSink;
  tasks: TasksReader;
  commands: TaskCommands;
  registry: AssetRegistry;
  clock?: () => Date;
  calendar?: MarketCalendar;
}

export const ACTION_LIST: typeof IMPACT_ACTIONS = ["view_evidence", "create_watch_task", "keep_plan", "wait_by_rule", "pause_issuance", "preview_new_plan"] as const;

const DEFAULT_EARNINGS_RULE: Condition = { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true };
const macroRule = (ev: MarketEvent): Condition => ({ type: "avoid_event_window", kinds: [ev.kind], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true });

export function watchConditionFor(ev: MarketEvent): Condition {
  return ev.kind === "EARNINGS" ? DEFAULT_EARNINGS_RULE : macroRule(ev);
}

/** 决策留痕（keep_plan 等）：内存；只是用户意向记录，不影响任务 */
export class DecisionLog {
  readonly entries: Array<{ owner: string; eventId: string; action: ImpactAction; taskId: string | null; at: IsoUtc }> = [];
  add(e: { owner: string; eventId: string; action: ImpactAction; taskId: string | null; at: IsoUtc }): void {
    this.entries.push(e);
  }
  latest(owner: string, eventId: string): (typeof this.entries)[number] | null {
    return [...this.entries].reverse().find((x) => x.owner === owner && x.eventId === eventId) ?? null;
  }
}

export class ImpactActions {
  readonly decisions = new DecisionLog();
  constructor(private readonly d: ActionDeps) {}

  private base(req: ActionRequest, effect: ActionEffect, message: ActionResult["message"], extra: Partial<ActionResult> = {}): ActionResult {
    return { action: req.action, eventId: req.eventId, taskId: req.taskId ?? null, effect, executed: false, issuesExecution: false, mode: null, message, ...extra };
  }

  async apply(req: ActionRequest): Promise<ActionResult> {
    const owner = req.owner.toLowerCase();
    const now = (this.d.clock ?? (() => new Date()))().toISOString();
    const ev = await this.d.store.get(req.eventId);
    if (!ev) return this.base(req, "invalid", { zh: "事件不存在", en: "Event not found" }, { code: "EVENT_NOT_FOUND" });
    const tasksRes = await this.d.tasks.tasksOf(owner);
    const task: TaskLite | null = req.taskId ? (tasksRes.items.find((t) => t.id === req.taskId) ?? null) : null;
    if (req.taskId && tasksRes.status === "ok" && !task) return this.base(req, "invalid", { zh: "任务不存在或不属于你", en: "Task not found or not yours" }, { code: "TASK_NOT_FOUND" });
    const notReady = (): ActionResult => this.base(req, "not_ready", { zh: "任务服务未就绪：这个动作暂时不能执行，不会假装成功。", en: "Task service not ready: this action cannot run yet and will not pretend to." }, { code: "TASKS_SERVICE_NOT_READY" });

    switch (req.action) {
      case "view_evidence": {
        const evidence = await this.d.evidence.forRef(ev.id);
        return this.base(req, "evidence", { zh: `事件 ${ev.name} 的 ${evidence.length} 条证据（来源 ${ev.source}，修订 ${ev.revision}）`, en: `${evidence.length} evidence record(s) for ${ev.name} (source ${ev.source}, revision ${ev.revision})` }, { evidence });
      }
      case "keep_plan": {
        this.decisions.add({ owner, eventId: ev.id, action: req.action, taskId: req.taskId ?? null, at: now });
        return this.base(req, "kept", { zh: "保持现计划：任务与授权都没有改动。", en: "Plan kept: no task or authorization was changed." });
      }
      case "create_watch_task": {
        const condition = watchConditionFor(ev);
        if (task) {
          if (tasksRes.status !== "ok") return notReady();
          const r = await this.d.commands.attachCondition(owner, task.id, condition);
          if (!r.ok) return r.code === "TASKS_SERVICE_NOT_READY" ? notReady() : this.base(req, "invalid", { zh: r.message, en: r.message }, { code: r.code });
          return this.base(
            req,
            r.data.requiresNewAuthorization ? "draft" : "attached",
            r.data.requiresNewAuthorization
              ? { zh: "条件已生成草案：改条件 = 新授权，需要你重新签署；旧授权不会自动失效。", en: "Condition drafted: changing conditions requires a new authorization; the old one is not revoked automatically." }
              : { zh: "条件已挂到现有任务（无授权，无需重签）。", en: "Condition attached to the existing task (no authorization involved)." },
            { draft: { taskId: task.id, condition, requiresNewAuthorization: r.data.requiresNewAuthorization, draftId: r.data.draftId } },
          );
        }
        const asset = this.d.registry.entries.find((e) => e.role === "stock_output" && ev.underlyingIds.includes(e.underlyingId));
        const draft: WatchTaskDraft = {
          ownerAddress: owner,
          playbookId: ev.kind === "EARNINGS" ? "event_aware_accumulate" : "session_dca",
          mode: "SIMULATION",
          conditions: { version: "conditions/1", items: [{ type: "session", allow: ["US_REGULAR"] }, condition] },
          params: { ...(asset ? { outputAssetKey: asset.assetKey } : {}), watchEventId: ev.id, ...(req.params ?? {}) },
          clientRequestId: req.clientRequestId ?? `watch-${ev.id}-${owner.slice(2, 10)}`,
        };
        const r = await this.d.commands.create(owner, draft);
        if (!r.ok) return r.code === "TASKS_SERVICE_NOT_READY" ? { ...notReady(), draft, mode: "SIMULATION" } : this.base(req, "invalid", { zh: r.message, en: r.message }, { code: r.code, draft });
        return this.base(req, "created", { zh: "已创建 SIMULATION 观察任务：只评估、不签证明、不执行。", en: "SIMULATION watch task created: evaluates only, signs nothing, executes nothing." }, { taskId: r.data.taskId, taskStatus: r.data.status, draft, mode: "SIMULATION" });
      }
      case "wait_by_rule": {
        if (!task) return tasksRes.status !== "ok" ? notReady() : this.base(req, "invalid", { zh: "按规则等待需要指定任务", en: "wait_by_rule needs a taskId" }, { code: "TASK_REQUIRED" });
        const cal = this.d.calendar ?? NYSE_CALENDAR;
        const items = req.wholeDayIfDayPrecision ? task.conditions.items.map((c) => (c.type === "avoid_event_window" ? { ...c, wholeDayIfDayPrecision: true } : c)) : task.conditions.items;
        const matches = matchRules(ev, items, cal);
        if (matches.length === 0) return this.base(req, "invalid", { zh: "该任务没有约束这个事件的规则；可先「创建观察任务」把规则挂上。", en: "This task has no rule constraining this event; attach one via create_watch_task first." }, { code: "NO_MATCHING_RULE" });
        const evals = matches.map((m) => evaluateRule(ev, m, now));
        const needs = matches.filter((m) => !m.result.ok);
        if (needs.length > 0) {
          const blockers = evals.flatMap((e) => (e.blocker ? [e.blocker] : []));
          return this.base(req, "needs_choice", { zh: reasonText("EVENT_DATE_UNCERTAIN", "zh"), en: reasonText("EVENT_DATE_UNCERTAIN", "en") }, { code: "EVENT_DATE_UNCERTAIN", blockers, nextCheckAt: null });
        }
        const blockers = evals.flatMap((e) => (e.blocker ? [e.blocker] : []));
        const nexts = evals.map((e) => e.nextCheckAt).filter((x): x is string => !!x).sort();
        const nextCheckAt = nexts[0] ?? null;
        const r = await this.d.commands.recheck({ taskId: task.id, nextCheckAt, blockers });
        return this.base(
          req,
          "wait",
          { zh: `按已有规则等待：下次检查 ${nextCheckAt ?? "未知"}；窗口内不签发。${r.ok ? "" : "（任务服务未就绪，等待计划尚未写回任务）"}`, en: `Waiting by your rule: next check ${nextCheckAt ?? "unknown"}; nothing is issued inside the window.${r.ok ? "" : " (task service not ready; not written back yet)"}` },
          { nextCheckAt, blockers, ...(r.ok ? {} : { code: r.code }) },
        );
      }
      case "pause_issuance": {
        if (!task) return tasksRes.status !== "ok" ? notReady() : this.base(req, "invalid", { zh: "暂停签发需要指定任务", en: "pause_issuance needs a taskId" }, { code: "TASK_REQUIRED" });
        const r = await this.d.commands.pause(owner, task.id);
        if (!r.ok) return r.code === "TASKS_SERVICE_NOT_READY" ? notReady() : this.base(req, "invalid", { zh: r.message, en: r.message }, { code: r.code });
        return this.base(req, "paused", { zh: "已暂停后续签发：只阻止新的证书；已取走且未过期的证书仍可能可执行。彻底停止以链上 revokeMandate 确认为准（§11.6）。", en: "Issuance paused: only new certificates are blocked; an already-issued, unexpired certificate may still execute. A full stop needs on-chain revokeMandate confirmation (§11.6)." }, { taskStatus: r.data.status });
      }
      case "preview_new_plan": {
        const condition = watchConditionFor(ev);
        const existing = task?.conditions.items ?? [];
        const proposed = [...existing.filter((c) => c.type !== condition.type), condition];
        const before = existing.find((c) => c.type === condition.type) ?? null;
        return this.base(req, "preview", { zh: "新计划预览（SIMULATION）：只展示条件差异，不写任何授权。", en: "New plan preview (SIMULATION): shows the condition diff only; writes no authorization." }, { mode: "SIMULATION", preview: { proposedConditions: proposed, diff: [{ itemType: condition.type, before, after: condition }], writesAuthorization: false } });
      }
      default:
        return this.base(req, "invalid", { zh: "未知动作", en: "Unknown action" }, { code: "UNKNOWN_ACTION" });
    }
  }
}

export function isCompanyEvent(ev: MarketEvent): boolean {
  return COMPANY_KINDS.includes(ev.kind);
}
