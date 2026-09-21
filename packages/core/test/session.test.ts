/**
 * §7 美股时段引擎：IANA America/New_York（严禁固定 UTC 偏移）。
 * 用 2026 年真实日期做端到端断言，覆盖 EDT/EST 两种夏令时状态、
 * 假日、半日市、边界分钟。
 */
import { describe, expect, it } from "vitest";
import { sessionAt, sessionsSinceClose } from "../src/session";

const at = (iso: string) => sessionAt(new Date(iso));

describe("§7.1 常规交易日（2026-07-06 周一，EDT=UTC-4）", () => {
  it("04:00 NY 前 → CLOSED", () => {
    expect(at("2026-07-06T07:59:00Z").session).toBe("CLOSED");
  });
  it("04:00–09:30 → PRE", () => {
    expect(at("2026-07-06T08:00:00Z").session).toBe("PRE");
    expect(at("2026-07-06T13:29:59Z").session).toBe("PRE");
  });
  it("09:30–16:00 → REGULAR（含开盘瞬间）", () => {
    expect(at("2026-07-06T13:30:00Z").session).toBe("REGULAR");
    expect(at("2026-07-06T19:59:59Z").session).toBe("REGULAR");
  });
  it("16:00–20:00 → POST（收盘瞬间起）", () => {
    expect(at("2026-07-06T20:00:00Z").session).toBe("POST");
    expect(at("2026-07-06T23:59:59Z").session).toBe("POST");
  });
  it("20:00 NY 起 → CLOSED", () => {
    expect(at("2026-07-07T00:00:00Z").session).toBe("CLOSED");
  });
});

describe("§7.1 冬令时（2026-01-05 周一，EST=UTC-5）", () => {
  it("09:35 NY = 14:35 UTC → REGULAR", () => {
    expect(at("2026-01-05T14:35:00Z").session).toBe("REGULAR");
  });
  it("若按固定 UTC-4 计算会误判的时刻：09:29 EST → PRE", () => {
    expect(at("2026-01-05T14:29:00Z").session).toBe("PRE");
  });
});

describe("§7.1 周末与假日", () => {
  it("2026-07-03（独立日补休，本文档撰写当日）→ HOLIDAY 全天", () => {
    expect(at("2026-07-03T15:00:00Z").session).toBe("HOLIDAY");
    // 2026-07-03T02:00Z 的 NY 时间是 7/2 22:00 —— 属于前一天（非假日）盘后结束 → CLOSED
    expect(at("2026-07-03T02:00:00Z").session).toBe("CLOSED");
  });
  it("周六/周日 → CLOSED（即使处于常规时段钟点）", () => {
    expect(at("2026-07-04T18:00:00Z").session).toBe("CLOSED"); // 周六
    expect(at("2026-07-05T18:00:00Z").session).toBe("CLOSED"); // 周日
  });
  it("9/7 劳动节、11/26 感恩节、12/25 圣诞 → HOLIDAY", () => {
    expect(at("2026-09-07T15:00:00Z").session).toBe("HOLIDAY");
    expect(at("2026-11-26T16:00:00Z").session).toBe("HOLIDAY");
    expect(at("2026-12-25T16:00:00Z").session).toBe("HOLIDAY");
  });
});

describe("§7.1 半日市（13:00 收盘）", () => {
  it("11/27（感恩节次日，EST）：12:30 → REGULAR，13:00 → POST，17:00 → CLOSED", () => {
    expect(at("2026-11-27T17:30:00Z").session).toBe("REGULAR");
    expect(at("2026-11-27T17:30:00Z").isHalfDay).toBe(true);
    expect(at("2026-11-27T18:00:00Z").session).toBe("POST");
    expect(at("2026-11-27T22:00:00Z").session).toBe("CLOSED");
  });
  it("12/24（平安夜，EST）同规则", () => {
    expect(at("2026-12-24T17:59:00Z").session).toBe("REGULAR");
    expect(at("2026-12-24T18:00:00Z").session).toBe("POST");
  });
});

describe("时区正确性哨兵", () => {
  it("同一 UTC 时刻的 nyDate 跨日正确（NY 比 UTC 晚）", () => {
    const info = at("2026-07-04T01:00:00Z"); // NY = 7/3 21:00 → 假日当天，但已过盘后
    expect(info.nyDate).toBe("2026-07-03");
    expect(info.session).toBe("HOLIDAY");
  });
});

describe("§7.2 收盘欠账计数 sessionsSinceClose（FIX-085 绝对陈旧闸）", () => {
  it("周日看周五收盘 → 0（正常闭市，不算欠账）", () => {
    expect(sessionsSinceClose("2026-09-18", new Date("2026-09-20T12:00:00Z"))).toBe(0);
  });
  it("收盘日 ≥ 当日 → 0（含冷启动的未来日期）", () => {
    expect(sessionsSinceClose("2026-09-20", new Date("2026-09-20T12:00:00Z"))).toBe(0);
    expect(sessionsSinceClose("2026-12-31", new Date("2026-09-20T12:00:00Z"))).toBe(0);
  });
  it("长周末：劳工节(9/7)后周二盘前看上周五收盘 → 0（假日不算欠账）", () => {
    // 2026-09-08T12:00Z = 08:00 NY 周二 → PRE，今日尚未收盘
    expect(sessionsSinceClose("2026-09-04", new Date("2026-09-08T12:00:00Z"))).toBe(0);
  });
  it("当日常规收盘后才把今日计入欠账", () => {
    // 09-08 16:00 NY 前 = 0；17:00 NY（POST）= 1
    expect(sessionsSinceClose("2026-09-04", new Date("2026-09-08T19:59:00Z"))).toBe(0);
    expect(sessionsSinceClose("2026-09-04", new Date("2026-09-08T21:00:00Z"))).toBe(1);
  });
  it("半日市按 13:00 收盘计（2026-11-27 感恩节次日，EST）", () => {
    expect(sessionsSinceClose("2026-11-25", new Date("2026-11-27T17:00:00Z"))).toBe(0); // 12:00 NY
    expect(sessionsSinceClose("2026-11-25", new Date("2026-11-27T18:05:00Z"))).toBe(1); // 13:05 NY
  });
  it("生产事故回归：2026-08-26 收盘冻结至 09-20 → 16 个交易日欠账", () => {
    // Pyth equity 断供后全站收盘日一起冻结，相对判据（D-065）恒为假，
    // 必须由本绝对判据抓出——16 ≥ REF_CLOSE_STALE_SESSIONS(2)
    expect(sessionsSinceClose("2026-08-26", new Date("2026-09-20T07:00:00Z"))).toBe(16);
  });
});
