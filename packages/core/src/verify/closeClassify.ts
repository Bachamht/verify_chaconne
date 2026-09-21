/**
 * 收盘分类（CV-D06，纯函数；Lane B2 在 live.ts 调用）。
 *  - t == 当日 16:00:00 ET 整 且 当日已收盘 → last_tick（未确认）
 *  - t < 16:00 且当日已收盘 → last_regular_observation（数据缺口；用 closeSource "pyth" 形态记录，交由交叉核验）
 *  - 盘中（REGULAR）→ 不是收盘：返回 null（调用方用 previousClose 记上一交易日 official）
 *  - official 只在 candle 或次日 pc 与已记录 last_tick 一致时由 confirmLastTick 升级
 */
import { NYSE_CALENDAR, type MarketCalendar } from "../calendar";
import { nyPartsOf, sessionAt } from "../session";
import type { RefCloseEvidence } from "./contracts";

export interface LastTradeClassification {
  closeSource: RefCloseEvidence["closeSource"];
  tradingDate: string;
  /** 源时间（= t） */
  sourcePublishedAt: string;
  note: "last_tick_at_1600" | "gap_before_close";
}

/** 16:00:00 ET 整（America/New_York） */
export function isRegularCloseInstant(tUnixSec: number): boolean {
  const p = nyPartsOf(new Date(tUnixSec * 1000));
  return p.hour === 16 && p.minute === 0 && tUnixSec % 60 === 0;
}

export function classifyLastTrade(args: { tUnixSec: number; nowIso: string; calendar?: MarketCalendar }): LastTradeClassification | null {
  const cal = args.calendar ?? NYSE_CALENDAR;
  const tDate = new Date(args.tUnixSec * 1000);
  const tInfo = sessionAt(tDate, cal);
  const nowInfo = sessionAt(new Date(args.nowIso), cal);
  const sameDay = tInfo.nyDate === nowInfo.nyDate;
  const dayClosed = !sameDay || nowInfo.session === "POST" || nowInfo.session === "CLOSED";
  if (!dayClosed) return null;
  if (tInfo.session !== "REGULAR" && !isRegularCloseInstant(args.tUnixSec)) return null;
  const sourcePublishedAt = tDate.toISOString();
  if (isRegularCloseInstant(args.tUnixSec)) return { closeSource: "last_tick", tradingDate: tInfo.nyDate, sourcePublishedAt, note: "last_tick_at_1600" };
  return { closeSource: "pyth", tradingDate: tInfo.nyDate, sourcePublishedAt, note: "gap_before_close" };
}

/** 次日 previousClose（或日线 candle 收盘）与已记录的 last_tick 一致 → 升级为 official（带确认记录）；不一致 → null（不升级，记 SOURCE_CONFLICT 由调用方决定） */
export function confirmLastTick(recorded: RefCloseEvidence, confirm: { method: "candle" | "next_day_pc"; closeUsd: string; confirmedAt: string }): RefCloseEvidence | null {
  if (recorded.closeSource !== "last_tick") return null;
  if (recorded.closeUsd !== confirm.closeUsd) return null;
  return { ...recorded, closeSource: "official", confirmation: { method: confirm.method, confirmedAt: confirm.confirmedAt, matchedUsd: confirm.closeUsd } };
}
