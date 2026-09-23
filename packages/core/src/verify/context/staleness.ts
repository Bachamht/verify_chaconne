/**
 * 逐字段 staleness（interfaces §11.3）——由 verify-service 判定，不信 producer 自报。
 *
 *   session.*                 10 分钟（fetchedAt 起）
 *   events                    60 分钟（packagedAt 起）
 *   fed.blackout*             60 分钟（派生日历）
 *   fed.hikeProb*             15 分钟
 *   rates.* / realYield10     日度定盘：observedAt 所在日的下一交易日 18:00 ET 前有效
 *   risk.*                    常规时段 20 分钟；休市按最后收盘：observedAt 须落在最近已完成交易日或之后
 *   crossAsset.lastDataRelease 事件 T+60 分钟内有效
 *   driftVerdict              60 分钟
 *
 * 规则优先级：value=null → unavailable；observedAt 晚于 receivedAt → unfinished（未完成区间，不得当已发生观测）；
 * 其余按上表算 ok / stale。producer 的 status 只在 unavailable/unfinished 上被采信（它不能把 stale 说成 ok）。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "../../calendar";
import { sessionAt } from "../../session";
import type { CtxField, CtxStatus, IsoUtc, MarketContext } from "../contracts";
import { lastCompletedTradingDate, nextTradingDay, nyDateAt, zonedLocalToUtcMs, NY_TZ } from "../conditions/calendarUtil";
import { contextFieldEntries } from "./schema";

export type FieldStatusMap = Record<string, CtxStatus>;

const MIN = 60_000;
const FIXED_TTL: Record<string, number> = {
  "session.": 10 * MIN,
  "fed.blackout": 60 * MIN,
  "fed.hikeProb": 15 * MIN,
  "driftVerdict": 60 * MIN,
};

function ttlFor(path: string): number | null {
  for (const [prefix, ttl] of Object.entries(FIXED_TTL)) if (path.startsWith(prefix)) return ttl;
  return null;
}

function dailyFixingFresh(observedAt: IsoUtc | null, nowMs: number, cal: MarketCalendar): boolean {
  if (!observedAt) return false;
  const obsDate = nyDateAt(Date.parse(observedAt));
  const deadline = zonedLocalToUtcMs(NY_TZ, nextTradingDay(obsDate, false, cal), 18 * 60);
  return nowMs <= deadline;
}

function riskFresh(f: CtxField<unknown>, nowMs: number, cal: MarketCalendar): boolean {
  const s = sessionAt(new Date(nowMs), cal).session;
  if (s === "REGULAR") return nowMs - Date.parse(f.fetchedAt) <= 20 * MIN;
  if (!f.observedAt) return false;
  return nyDateAt(Date.parse(f.observedAt)) >= lastCompletedTradingDate(nowMs, cal);
}

export function fieldStatusAt(path: string, f: CtxField<unknown>, nowMs: number, cal: MarketCalendar = NYSE_CALENDAR): CtxStatus {
  // CV-D15（2026-09-23，服务器上线观察）：「值为 null」与「不可得」是两回事。producer 标 status=ok 且 value=null 的字段
  // （不是假日 → holiday=null、不在静默期 → blackoutUntil=null、近 24h 无数据发布 → lastDataRelease=null）按合法空值处理，
  // 仍照常做新鲜度判定；只有 producer 标 unavailable / 没标 ok 的 null 才是不可得。
  const isNull = f.value === null || f.value === undefined;
  if (isNull && f.status !== "ok") return "unavailable";
  if (f.status === "unavailable") return "unavailable";
  if (f.observedAt && Date.parse(f.observedAt) > nowMs) return "unfinished";
  if (f.status === "unfinished") return "unfinished";
  const fetchedMs = Date.parse(f.fetchedAt);
  if (Number.isNaN(fetchedMs)) return "unavailable";
  const ttl = ttlFor(path);
  if (ttl !== null) return nowMs - fetchedMs <= ttl ? "ok" : "stale";
  if (path.startsWith("rates.")) return dailyFixingFresh(f.observedAt, nowMs, cal) ? "ok" : "stale";
  if (path.startsWith("risk.")) return riskFresh(f, nowMs, cal) ? "ok" : "stale";
  if (path === "crossAsset.lastDataRelease") {
    if (isNull) return nowMs - fetchedMs <= 60 * MIN ? "ok" : "stale";
    const v = f.value as { atUtc?: string } | null;
    const at = v?.atUtc ? Date.parse(v.atUtc) : NaN;
    if (Number.isNaN(at)) return "unavailable";
    return nowMs - at <= 60 * MIN ? "ok" : "stale";
  }
  return nowMs - fetchedMs <= 60 * MIN ? "ok" : "stale";
}

/** 全部字段 + "events" 伪字段的 status。receivedAt = 本服务收到快照的时刻（评估时点）。 */
export function assessContextStaleness(ctx: MarketContext, receivedAt: IsoUtc, cal: MarketCalendar = NYSE_CALENDAR): FieldStatusMap {
  const nowMs = Date.parse(receivedAt);
  const out: FieldStatusMap = {};
  for (const [path, f] of contextFieldEntries(ctx)) out[path] = fieldStatusAt(path, f, nowMs, cal);
  const packagedMs = Date.parse(ctx.packagedAt);
  out["events"] = Number.isNaN(packagedMs) ? "unavailable" : nowMs - packagedMs <= 60 * MIN ? "ok" : "stale";
  return out;
}

/** 把判定结果写回字段（value 保留；status 覆盖为服务判定） */
export function applyFieldStatus(ctx: MarketContext, status: FieldStatusMap): MarketContext {
  const clone = structuredClone(ctx) as MarketContext & Record<string, unknown>;
  for (const [path, s] of Object.entries(status)) {
    if (path === "events") continue;
    const segs = path.split(".");
    let cur: Record<string, unknown> = clone;
    for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]!] as Record<string, unknown>;
    const f = cur[segs[segs.length - 1]!] as CtxField<unknown> | undefined;
    if (f) f.status = s;
  }
  return clone;
}
