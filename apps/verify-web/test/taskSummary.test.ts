/** 任务详情摘要：进度 / 执行者 / 缺什么 / 下一步，全部来自服务端字段；模拟任务不要求执行者。 */
import { describe, expect, it } from "vitest";
import type { TaskCreated } from "../lib/api-v2";
import { taskSummary } from "../components/agent/tasks/taskSummary";

const owner = "0x0000000000000000000000000000000000000001";
const time = "2026-09-25T01:00:00.000Z";
function view(over: Partial<TaskCreated["task"]> = {}, extra: Partial<TaskCreated> = {}): TaskCreated {
  const task: TaskCreated["task"] = {
    id: "tsk_sum", owner, playbookId: "session_dca", status: "WAITING", blockers: [], nextCheckAt: null,
    mandateIds: [], executorPresence: "offline", createdAt: time, updatedAt: time,
    conditions: { version: "conditions/1", items: [], hash: `0x${"0".repeat(64)}` },
    goal: { ownerAddress: owner, recipientAddress: owner, executionChainId: 196, legs: [], budget: { inputAssetKeys: [], amountInRaw: "0" }, side: "buy", policyId: "STRICT_LIVE", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: null, deadline: time },
    ...over,
  };
  return { task, mandateDraft: null, thesisDraft: null, budgetAllocation: null, mode: "SIMULATION", ...extra };
}

describe("taskSummary", () => {
  it("模拟任务：不需要执行者，等待原因与下次检查进「下一步」", () => {
    const s = taskSummary(view({ blockers: [{ code: "SESSION_RULE_BLOCK", evidenceIds: [], evidenceAt: time, nextCheckAt: time, userActionRequired: false, text: "x" }, { code: "CONTEXT_UNAVAILABLE", evidenceIds: [], evidenceAt: time, nextCheckAt: time, userActionRequired: false, text: "y" }], nextCheckAt: "2026-09-25T13:30:00.000Z" }, { steps: { planned: 3, confirmed: 0, lastConfirmedAt: null } }), "zh");
    expect(s.progress).toBe("已确认 0 / 3 步 · 等待中");
    expect(s.executor).toContain("不需要执行者");
    expect(s.missing).toBeNull();
    expect(s.next).toContain("现在不在你允许的美股时段");
    expect(s.next).toContain("还有 1 项");
    expect(s.next).toContain("下次检查");
  });
  it("真实任务待授权：缺签名，下一步是签署", () => {
    const s = taskSummary(view({ status: "AWAITING_AUTHORIZATION" }, { mode: "LIVE" }), "en");
    expect(s.missing).toContain("authorization signature");
    expect(s.next).toContain("Sign the authorization");
    expect(s.executor).toContain("No executor is online");
  });
  it("真实任务执行者离线时标出缺执行者；在线时不缺", () => {
    expect(taskSummary(view({ status: "ACTIVE" }, { mode: "LIVE" }), "zh").missing).toBe("缺一个在线的执行者。");
    expect(taskSummary(view({ status: "ACTIVE", executorPresence: "online" }, { mode: "LIVE" }), "zh").missing).toBeNull();
  });
  it("mode 缺失时按 mandate 推断，结束态不再给下一步动作", () => {
    const s = taskSummary(view({ status: "COMPLETED", mandateIds: ["mnd_1"] }, { mode: undefined }), "en");
    expect(s.executor).not.toContain("simulation");
    expect(s.missing).toBeNull();
    expect(s.next).toContain("has ended");
  });
});
