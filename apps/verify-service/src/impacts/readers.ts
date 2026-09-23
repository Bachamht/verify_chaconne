/**
 * Lane D 对 Lane B（任务）/ Lane C（持仓、通知）表的**可替换 reader / 命令接口**。
 * 未就绪时注入 notReady* stub：返回 status='unavailable' / code='TASKS_SERVICE_NOT_READY'，页面据此显示「未就绪 / 不可用」，不假成功。
 * 测试注入 fixture*。合并后由 Lane I 换成真实实现（签名不变）。
 */
import type { Blocker, Condition, EvmAddress, IsoUtc, MarketEvent, NotificationPayload, RawAmount, TaskStatus } from "@chaconne/core/verify";

export type ReaderStatus = "ok" | "unavailable";
export interface ReaderResult<T> {
  status: ReaderStatus;
  items: T[];
  /** unavailable 时的机器码，如 PORTFOLIO_SERVICE_NOT_READY */
  note?: string;
  asOf?: IsoUtc | null;
}

export interface Holding {
  assetKey: string;
  balanceRaw: RawAmount;
}
export interface TaskLite {
  id: string;
  owner: EvmAddress;
  status: TaskStatus;
  playbookId?: string;
  conditions: { items: Condition[] };
  /** 任务涉及的资产（输入/输出） */
  assetKeys: string[];
  mandateIds: string[];
  thesisId?: string;
  nextCheckAt: IsoUtc | null;
}

export interface HoldingsReader {
  holdings(owner: string): Promise<ReaderResult<Holding>>;
}
export interface TasksReader {
  tasksOf(owner: string): Promise<ReaderResult<TaskLite>>;
  /** 与事件相关（条件命中该事件类型 / 资产）的任务，跨 owner；修订传播用 */
  tasksForEvent(event: MarketEvent): Promise<ReaderResult<TaskLite>>;
}

export type CommandResult<T = Record<string, never>> = { ok: true; data: T } | { ok: false; code: "TASKS_SERVICE_NOT_READY" | "TASK_NOT_FOUND" | "FORBIDDEN" | "INVALID"; message: string };
export interface TaskRecheck {
  taskId: string;
  nextCheckAt: IsoUtc | null;
  blockers: Blocker[];
}
export interface WatchTaskDraft {
  ownerAddress: string;
  playbookId: "session_dca" | "event_aware_accumulate";
  mode: "SIMULATION";
  conditions: { version: "conditions/1"; items: Condition[] };
  params: Record<string, unknown>;
  clientRequestId: string;
}
/** 任务命令（Lane B `POST /v1/tasks*`）。每个命令只改任务或产草案，**不发任何执行**。 */
export interface TaskCommands {
  recheck(r: TaskRecheck): Promise<CommandResult>;
  pause(owner: string, taskId: string): Promise<CommandResult<{ status: TaskStatus }>>;
  create(owner: string, draft: WatchTaskDraft): Promise<CommandResult<{ taskId: string; status: TaskStatus }>>;
  /** 把条件挂到现有任务：有授权的任务 → 返回待签草案（新条件 = 新授权，§11.4） */
  attachCondition(owner: string, taskId: string, condition: Condition): Promise<CommandResult<{ requiresNewAuthorization: boolean; draftId: string | null }>>;
}
export interface Notifier {
  enqueue(payload: NotificationPayload): Promise<void>;
}

/* ---------------- stubs ---------------- */

export const notReadyHoldings: HoldingsReader = {
  async holdings() {
    return { status: "unavailable", items: [], note: "PORTFOLIO_SERVICE_NOT_READY", asOf: null };
  },
};
export const notReadyTasks: TasksReader = {
  async tasksOf() {
    return { status: "unavailable", items: [], note: "TASKS_SERVICE_NOT_READY", asOf: null };
  },
  async tasksForEvent() {
    return { status: "unavailable", items: [], note: "TASKS_SERVICE_NOT_READY", asOf: null };
  },
};
const notReady = <T,>(): CommandResult<T> => ({ ok: false, code: "TASKS_SERVICE_NOT_READY", message: "任务服务未就绪（Lane B POST /v1/tasks 未接入）" });
export const notReadyCommands: TaskCommands = {
  recheck: async () => notReady(),
  pause: async () => notReady(),
  create: async () => notReady(),
  attachCondition: async () => notReady(),
};

export class MemoryNotifier implements Notifier {
  readonly sent: NotificationPayload[] = [];
  async enqueue(p: NotificationPayload): Promise<void> {
    // outbox 幂等键：重复入队不重复记
    if (this.sent.some((s) => s.idempotencyKey === p.idempotencyKey)) return;
    this.sent.push(p);
  }
}

/* ---------------- fixtures（测试） ---------------- */

export function fixtureHoldings(byOwner: Record<string, Holding[]>, asOf: IsoUtc | null = null): HoldingsReader {
  return { async holdings(owner) { return { status: "ok", items: byOwner[owner.toLowerCase()] ?? [], asOf }; } };
}
export function fixtureTasks(tasks: TaskLite[]): TasksReader & { tasks: TaskLite[] } {
  return {
    tasks,
    async tasksOf(owner) {
      return { status: "ok", items: tasks.filter((t) => t.owner.toLowerCase() === owner.toLowerCase()) };
    },
    async tasksForEvent(ev) {
      return { status: "ok", items: tasks.filter((t) => t.conditions.items.some((c) => (c.type === "earnings_window" && ev.kind === "EARNINGS") || (c.type === "avoid_event_window" && c.kinds.includes(ev.kind)))) };
    },
  };
}
export class MemoryTaskCommands implements TaskCommands {
  readonly rechecks: TaskRecheck[] = [];
  readonly paused: string[] = [];
  readonly created: WatchTaskDraft[] = [];
  readonly attached: Array<{ taskId: string; condition: Condition }> = [];
  constructor(private readonly tasks: TaskLite[] = []) {}
  async recheck(r: TaskRecheck): Promise<CommandResult> {
    this.rechecks.push(r);
    const t = this.tasks.find((x) => x.id === r.taskId);
    if (t) t.nextCheckAt = r.nextCheckAt;
    return { ok: true, data: {} };
  }
  async pause(owner: string, taskId: string): Promise<CommandResult<{ status: TaskStatus }>> {
    const t = this.tasks.find((x) => x.id === taskId && x.owner.toLowerCase() === owner.toLowerCase());
    if (!t) return { ok: false, code: "TASK_NOT_FOUND", message: "task not found" };
    t.status = "PAUSED";
    this.paused.push(taskId);
    return { ok: true, data: { status: "PAUSED" } };
  }
  async create(_owner: string, draft: WatchTaskDraft): Promise<CommandResult<{ taskId: string; status: TaskStatus }>> {
    this.created.push(draft);
    return { ok: true, data: { taskId: `task_fixture_${this.created.length}`, status: "ACTIVE" } };
  }
  async attachCondition(owner: string, taskId: string, condition: Condition): Promise<CommandResult<{ requiresNewAuthorization: boolean; draftId: string | null }>> {
    const t = this.tasks.find((x) => x.id === taskId && x.owner.toLowerCase() === owner.toLowerCase());
    if (!t) return { ok: false, code: "TASK_NOT_FOUND", message: "task not found" };
    this.attached.push({ taskId, condition });
    const requires = t.mandateIds.length > 0;
    return { ok: true, data: { requiresNewAuthorization: requires, draftId: requires ? `draft_${taskId}` : null } };
  }
}
