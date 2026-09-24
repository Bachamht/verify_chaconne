/** V-30 · 「最近一个」只取未来且未取消的事件；过去的、已取消的、已发布的都不算。 */
import { describe, expect, it } from "vitest";
import { nextUpcomingEvent } from "../components/agent/crew/nextEvent";
import { LINES, templateVars } from "../components/agent/crew/lines";

const now = Date.parse("2026-09-24T02:45:00Z");
const ev = (dateLocal: string, status: "confirmed" | "estimated" | "cancelled" | "released", scheduledAtUtc: string | null = null) => ({ dateLocal, status, scheduledAtUtc });

describe("nextUpcomingEvent", () => {
  it("跳过已取消 / 已发布 / 过去的事件，取最早的未来事件", () => {
    const list = [ev("2026-09-23", "cancelled"), ev("2026-09-22", "confirmed", "2026-09-22T12:30:00Z"), ev("2026-09-26", "estimated"), ev("2026-09-25", "confirmed", "2026-09-25T12:30:00Z"), ev("2026-09-24", "released", "2026-09-24T00:30:00Z")];
    expect(nextUpcomingEvent(list, now)).toEqual(ev("2026-09-25", "confirmed", "2026-09-25T12:30:00Z"));
  });
  it("只有日期的事件按当天算未来；全部过去 → null", () => {
    expect(nextUpcomingEvent([ev("2026-09-24", "estimated")], now)?.dateLocal).toBe("2026-09-24");
    expect(nextUpcomingEvent([ev("2026-09-20", "confirmed")], now)).toBeNull();
    expect(nextUpcomingEvent([], now)).toBeNull();
  });
  it("瞭望员的事件数与相关数来自同一份 impacts（events.length / impacts.length 同句）", () => {
    const line = LINES.find((l) => l.id === "events")!;
    expect(templateVars(line)).toEqual(["events.length", "impacts.length"]);
  });
});
