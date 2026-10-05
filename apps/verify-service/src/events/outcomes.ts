/**
 * v7 · 事件实际值（P0-D，interfaces §12.7）服务侧公共件：两套事件存储（crowsnest 的 EventStore、财报的 DrizzleEventStore）共用。
 *  - 读视图：开关关 → 旧形状（剥掉 outcome）；开关开 → MarketEventV7（outcome / outcomeRevision / dataStatus）
 *  - 修订史派生 outcomeRevision（按 outcome 规范化哈希逐条走）
 *  - OutcomeHookRegistry：实际值首次入库 / 修订后的回调（Lane A 在这里挂 data_arrived 轮次；本 lane 只定义并调用）
 */
import { deriveOutcomeChange, eventDataStatus, type EventOutcome, type IsoUtc, type MarketEvent, type MarketEventV7 } from "@chaconne/core/verify";
import { log } from "../log";

/** 去掉 v7 字段 → 旧 MarketEvent 形状（开关关时所有读口都走这里，保证旧响应逐字节不变） */
export function stripOutcome(ev: MarketEventV7 | MarketEvent): MarketEvent {
  const { outcome: _o, outcomeRevision: _r, dataStatus: _s, ...rest } = ev as MarketEventV7;
  void _o;
  void _r;
  void _s;
  return rest;
}

/** 当前视图：outcome 以列为准（outcome_json / outcome_revision），dataStatus 按 nowMs 派生 */
export function v7View(ev: MarketEvent, outcome: EventOutcome | null | undefined, outcomeRevision: number, nowMs: number): MarketEventV7 {
  const base = stripOutcome(ev);
  const withOutcome: MarketEventV7 = outcome ? { ...base, outcome, outcomeRevision } : base;
  return { ...withOutcome, dataStatus: eventDataStatus(withOutcome, nowMs) };
}

/**
 * 修订史 → 逐条 v7 视图：outcomeRevision 按修订顺序重放哈希派生（首次 = 0，之后哈希变一次 +1），
 * dataStatus 取该修订**入库时刻**的状态（这条修订当时代表什么）。
 */
export function annotateRevisionOutcomes<T extends { revision: number; event: MarketEvent; changedAtMs: number }>(rows: readonly T[]): Array<T & { event: MarketEventV7 }> {
  let prev: { hash: string | null; outcomeRevision: number } | null = null;
  const out: Array<T & { event: MarketEventV7 }> = [];
  for (const r of [...rows].sort((a, b) => a.revision - b.revision)) {
    const outcome = (r.event as MarketEventV7).outcome;
    const c = deriveOutcomeChange(prev, outcome);
    if (c.kind !== "none") prev = { hash: c.hash, outcomeRevision: c.outcomeRevision };
    out.push({ ...r, event: v7View(r.event, outcome, c.kind === "none" ? 0 : c.outcomeRevision, r.changedAtMs) });
  }
  return out;
}

export interface OutcomeHookInfo {
  eventId: string;
  /** 事件 revision（producer 的） */
  revision: number;
  /** 服务端派生：data_arrived = 0 */
  outcomeRevision: number;
  change: "data_arrived" | "revised";
  /** outcome_received_at */
  receivedAt: IsoUtc;
  provider: EventOutcome["provider"];
}
/** Lane A：`onDataArrived` 打开 data_arrived 轮次；`onOutcomeRevised` 可选（修订另有 event.revised 通知 → event 轮次） */
export interface OutcomeHooks {
  onDataArrived?: (eventId: string, info: OutcomeHookInfo) => Promise<void> | void;
  onOutcomeRevised?: (eventId: string, info: OutcomeHookInfo) => Promise<void> | void;
}

export class OutcomeHookRegistry {
  private hooks: OutcomeHooks = {};
  set(h: OutcomeHooks): void {
    this.hooks = { ...h };
  }
  clear(): void {
    this.hooks = {};
  }
  /** 回调失败只记日志（摄入不受影响，与修订传播同一策略） */
  async emit(info: OutcomeHookInfo): Promise<void> {
    const fn = info.change === "data_arrived" ? this.hooks.onDataArrived : this.hooks.onOutcomeRevised;
    if (!fn) return;
    try {
      await fn(info.eventId, info);
    } catch (e) {
      log.warn("实际值回调失败（摄入不受影响）", { eventId: info.eventId, change: info.change, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
