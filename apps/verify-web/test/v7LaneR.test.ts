/**
 * 与 Lane R 合并后的对齐（main 9eeee1c）：活动流 type 名、公开看板类别与操作者类别、recap.agent（AgentJournalDay）→ 夜班四段。
 */
import { describe, expect, it } from "vitest";
import { activityCategory } from "../components/agent/tasks/v7/runtimeModel";
import { actorLabel, boardLabel } from "../components/live/AgentWatchBoard";
import { nightFromJournal, agentNightOf } from "../components/agent/journal/AgentNight";
import { normalizePublicActivity, type AgentJournalDayView } from "../lib/api-v2";

describe("Lane R 时间线 type → 活动类别", () => {
  it.each([
    ["agent_tool", "research"], ["agent_turn", "research"], ["run_completed", "decision"], ["intent_certified", "certified"], ["intent_rejected", "intent_rejected"],
    ["step_confirmed", "fill_confirmed"], ["sell_confirmed", "fill_confirmed"], ["job_confirmed", "fill_confirmed"], ["job_sent", "tx_sent"], ["job_expired", "exec_failed"],
    ["execution_failed", "exec_failed"], ["recertified", "recovered"], ["agent_waiting", "waiting"], ["agent_needs_evidence", "waiting_data"], ["data_arrived", "data_arrived"],
    ["agent_plan_revised", "plan_revised"], ["agent_ended", "ended"], ["authorized", "delegation"], ["handover", "control"],
  ])("%s → %s", (type, cat) => {
    expect(activityCategory({ type, actor: "system", data: null })).toBe(cat);
  });
});

describe("公开看板：Lane R 类别与操作者类别", () => {
  it("十一个类别都有固定标签；操作者只认四种", () => {
    for (const c of ["task", "authorization", "decision", "wait", "trade", "execution", "data", "fault", "recovery", "owner_action", "other"]) expect(boardLabel(c, "zh")).not.toBe("");
    expect(boardLabel("trade", "zh")).toBe("成交确认");
    expect(boardLabel("wait", "en")).toBe("Waiting");
    expect(actorLabel("agent", "zh")).toBe("Agent");
    expect(actorLabel("0xabc", "zh")).toBeNull();
  });
  it("归一化保留 actor（枚举内），丢掉 counts / privacy 以外的一切行字段", () => {
    const v = normalizePublicActivity({ shareId: "s", kind: "task_activity", generatedAt: "2026-10-05T23:59:00.000Z", items: [{ at: "2026-10-05T23:40:00.000Z", category: "trade", actor: "executor" }, { at: "2026-10-05T23:41:00.000Z", category: "decision", actor: "web:0xabc" }] });
    expect(v?.items).toEqual([{ at: "2026-10-05T23:40:00.000Z", category: "trade", actor: "executor" }, { at: "2026-10-05T23:41:00.000Z", category: "decision" }]);
  });
});

describe("recap.agent（AgentJournalDay）→ 夜班四段", () => {
  const day: AgentJournalDayView = {
    date: "2026-10-05", tz: "America/New_York", window: { startUtc: "2026-10-05T04:00:00.000Z", endUtc: "2026-10-06T04:00:00.000Z" }, taskIds: ["tsk_1"],
    runs: { total: 4, byState: { COMPLETED: 4 }, byReason: { scheduled: 2, data_arrived: 2 }, byMode: { LIVE: 4 }, items: [
      { taskId: "tsk_1", runId: "r1", turnVersion: 1, reason: "authorized", mode: "LIVE", state: "COMPLETED", at: "2026-10-05T23:40:00.000Z", model: "m", action: { kind: "intent", ref: "i1", status: "certified" }, decisionSummary: "数据前买一小笔 AAPLx", nextCheckAt: "2026-10-06T02:35:00.000Z", costUsdMicros: "50000" },
      { taskId: "tsk_1", runId: "r2", turnVersion: 2, reason: "scheduled", mode: "LIVE", state: "COMPLETED", at: "2026-10-06T02:35:00.000Z", model: "m", action: { kind: "status", ref: "s2", status: "waiting" }, decisionSummary: "实际值未到", nextCheckAt: "2026-10-06T02:50:00.000Z", costUsdMicros: "40000" },
    ] },
    actions: { total: 2, byType: { agent_tool: 2 }, items: [{ taskId: "tsk_1", at: "2026-10-05T23:39:00.000Z", type: "agent_tool", actor: "agent:hosted", note: "查询事件日历" }, { taskId: "tsk_1", at: "2026-10-05T23:39:30.000Z", type: "agent_tool", actor: "agent:hosted", note: "询价 AAPLx" }] },
    waits: [{ taskId: "tsk_1", at: "2026-10-06T02:35:00.000Z", type: "agent_waiting", actor: "agent:hosted", note: "非农实际值未到，不交易", source: "run", nextCheckAt: "2026-10-06T02:50:00.000Z", invalidation: "实际值低于上期则放弃第二笔" }],
    fills: [{ taskId: "tsk_1", mandateId: "m1", side: "buy", stepIndex: 0, at: "2026-10-05T23:42:00.000Z", spentRaw: "2000000", receivedRaw: "1", txHash: null }, { taskId: "tsk_1", mandateId: "m2", side: "sell", stepIndex: 0, at: "2026-10-06T03:00:00.000Z", spentRaw: "1", receivedRaw: "1", txHash: null }],
    cost: { totalUsdMicros: "90000", byMode: { LIVE: "90000" }, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, runsWithoutCost: 0 },
    faults: [{ taskId: "tsk_1", at: "2026-10-06T00:41:00.000Z", type: "execution_failed", actor: "executor:hosted", note: "证书在发送前作废" }],
    recoveries: [{ taskId: "tsk_1", at: "2026-10-06T00:42:00.000Z", type: "recertified", actor: "system", note: "自动重签一次" }],
  };
  it("四段、轮次、买卖数、成本、故障与恢复按时间排列", () => {
    const n = nightFromJournal(day, "zh");
    expect(n.runs).toBe(4);
    expect(n.fills).toEqual({ buy: 1, sell: 1 });
    expect(n.costUsdMicros).toBe("90000");
    expect(n.sections.looked).toEqual(["查询事件日历", "询价 AAPLx"]);
    expect(n.sections.did[0]).toMatch(/^买入 · 第 1 步/);
    expect(n.sections.did).toContain("数据前买一小笔 AAPLx");
    expect(n.sections.skipped).toEqual(["非农实际值未到，不交易"]);
    expect(n.sections.next).toContain("实际值低于上期则放弃第二笔");
    expect(n.faults.map((f) => f.event)).toEqual(["fault", "recovery"]);
  });
  it("agentNightOf 认出 AgentJournalDay 形状", () => {
    expect(agentNightOf({ date: "2026-10-05", agent: day }, "zh")?.runs).toBe(4);
  });
});
