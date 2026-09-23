/**
 * 修订传播（Lane D）：事件 revision 变化 → 重算受影响任务的 nextCheckAt 与阻塞 → 发 `event.revised`（已发布 → `event.released`）。
 * 通知只是唤醒（D-087）：载荷只含 id/类型/版本/摘要/链接；幂等键 `${type}:${entityId}:${version}`。
 * 任务读写与通知入队都是注入接口（readers.ts）；未就绪时只发通知、记录"未能应用"，不伪装已重算。
 */
import type { Blocker, IsoUtc, NotificationPayload, NotificationType } from "@chaconne/core/verify";
import { NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import type { Notifier, TaskCommands, TasksReader } from "../../impacts/readers";
import type { EventUpsertResult } from "./store";
import { evaluateRule, matchRules } from "./window";

export interface PropagatorDeps {
  tasks: TasksReader;
  commands: TaskCommands;
  notify: Notifier;
  clock?: () => Date;
  /** 通知里的链接前缀（verify-web） */
  publicBaseUrl?: string;
  calendar?: MarketCalendar;
}

export interface TaskPropagation {
  taskId: string;
  nextCheckAt: IsoUtc | null;
  blockers: Blocker[];
  applied: boolean;
  note?: string;
}
export interface PropagationResult {
  eventId: string;
  revision: number;
  type: NotificationType | null;
  notified: boolean;
  tasksStatus: "ok" | "unavailable";
  tasks: TaskPropagation[];
}

export class EventRevisionPropagator {
  constructor(private readonly d: PropagatorDeps) {}

  async onChange(r: EventUpsertResult): Promise<PropagationResult> {
    const ev = r.event;
    const base: PropagationResult = { eventId: ev.id, revision: ev.revision, type: null, notified: false, tasksStatus: "ok", tasks: [] };
    if (r.change === "unchanged" || r.change === "created") return base;
    const type: NotificationType = r.change === "released" ? "event.released" : "event.revised";
    const now = (this.d.clock ?? (() => new Date()))().toISOString();

    // 1) 受影响任务：重算 nextCheckAt 与阻塞（按各任务自己的条件参数）
    const found = await this.d.tasks.tasksForEvent(ev);
    base.tasksStatus = found.status;
    for (const t of found.items) {
      const matches = matchRules(ev, t.conditions.items, this.d.calendar ?? NYSE_CALENDAR);
      if (matches.length === 0) continue;
      const evals = matches.map((m) => evaluateRule(ev, m, now));
      const blockers = evals.flatMap((e) => (e.blocker ? [e.blocker] : []));
      const nexts = evals.map((e) => e.nextCheckAt).filter((x): x is string => !!x);
      const nextCheckAt = nexts.length > 0 ? nexts.sort()[0]! : null;
      const cmd = await this.d.commands.recheck({ taskId: t.id, nextCheckAt, blockers });
      base.tasks.push({ taskId: t.id, nextCheckAt, blockers, applied: cmd.ok, ...(cmd.ok ? {} : { note: cmd.code }) });
    }

    // 2) 通知（每个事件版本一条；不携带权限）
    const from = r.previous ? `${r.previous.dateLocal}${r.previous.sessionHint ? " " + r.previous.sessionHint : ""}` : "";
    const to = `${ev.dateLocal}${ev.sessionHint ? " " + ev.sessionHint : ""}`;
    const summary = type === "event.released" ? `${ev.name} released (rev ${ev.revision})` : `${ev.name} rescheduled: ${from} → ${to} (rev ${ev.revision}, ${ev.status}/${ev.datePrecision})`;
    const payload: NotificationPayload = {
      type,
      entityId: ev.id,
      version: ev.revision,
      idempotencyKey: `${type}:${ev.id}:${ev.revision}`,
      summary,
      url: `${(this.d.publicBaseUrl ?? "").replace(/\/$/, "")}/agent/events?event=${encodeURIComponent(ev.id)}`,
      at: now,
    };
    await this.d.notify.enqueue(payload);
    base.type = type;
    base.notified = true;
    return base;
  }
}
