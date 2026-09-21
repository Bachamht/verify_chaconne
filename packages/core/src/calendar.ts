/**
 * NYSE 休市日历（§7.1 种子数据）。
 *
 * 核实记录（the design log D-011）：2026 全年 + 2027 全年假日与半日市
 * 于 2026-07-03 与 nyse.com/markets/hours-calendars 官方表逐条核对一致，
 * 与 PRD §7.1 所列 2026 剩余日期亦一致（双源达成）。
 *
 * ⚠ 运营者年度维护（SETUP.md 待办）：每年 12 月把次年官方日历追加到下表。
 * poller 的 QA 日报自 11 月起自动提醒（calendarCoversYear 检查）。
 */

export interface MarketCalendar {
  /** 全天休市（YYYY-MM-DD，America/New_York 本地日） */
  holidays: ReadonlySet<string>;
  /** 半日市：13:00 收盘（感恩节次日 / 平安夜） */
  halfDays: ReadonlySet<string>;
  coveredYears: readonly number[];
}

export const NYSE_CALENDAR: MarketCalendar = {
  coveredYears: [2026, 2027],
  holidays: new Set([
    // ---- 2026 ----
    "2026-01-01", // New Year's Day（周四）
    "2026-01-19", // Martin Luther King, Jr. Day
    "2026-02-16", // Washington's Birthday
    "2026-04-03", // Good Friday
    "2026-05-25", // Memorial Day
    "2026-06-19", // Juneteenth National Independence Day
    "2026-07-03", // Independence Day 补休（7/4 为周六；本文档撰写当日即休市）
    "2026-09-07", // Labor Day
    "2026-11-26", // Thanksgiving Day
    "2026-12-25", // Christmas Day
    // ---- 2027 ----
    "2027-01-01", // New Year's Day
    "2027-01-18", // MLK Day
    "2027-02-15", // Washington's Birthday
    "2027-03-26", // Good Friday
    "2027-05-31", // Memorial Day
    "2027-06-18", // Juneteenth（观察日）
    "2027-07-05", // Independence Day（观察日）
    "2027-09-06", // Labor Day
    "2027-11-25", // Thanksgiving Day
    "2027-12-24", // Christmas Day（观察日）
  ]),
  halfDays: new Set([
    "2026-11-27", // 感恩节次日 13:00 收盘
    "2026-12-24", // 平安夜 13:00 收盘
    "2027-11-26", // 感恩节次日（2027 平安夜为圣诞观察日，全天休市）
  ]),
};

export function calendarCoversYear(cal: MarketCalendar, year: number): boolean {
  return cal.coveredYears.includes(year);
}
