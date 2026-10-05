/**
 * v7 Lane R · R4：夜班日志 Agent 段按纽约交易日聚合（轮次 / 动作 / 等待理由 / 成交 / 成本 / 故障与恢复），只含当日窗口内的数据；
 * 经 RecapsService.forOwner 出现在 owner 的 Recap 里（recap.agent），公开视图不含。
 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyAgentRuns, verifyMandateSteps, verifyMandates } from "@chaconne/db";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, type TestEnv } from "./helpers";
import { appendTimeline } from "../src/records/timeline";
import { buildAgentJournal } from "../src/recaps/agentJournal";
import { recapWindow } from "../src/recaps/window";
import { publicRecapView } from "../src/recaps/build";
import { goalTaskBody, owner, WEB_KEYS, WEB_KEY, webHeaders } from "./v7rHelpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const DAY = "2026-09-18"; // 周五，常规交易日
const IN = (hhmmZ: string) => new Date(`${DAY}T${hhmmZ}:00.000Z`);

async function seed(e: TestEnv): Promise<string> {
  const created = await api(e, "POST", "/v1/tasks", goalTaskBody(), webHeaders, WEB_KEY);
  expect(created.status).toBe(201);
  const taskId = (created.json["task"] as { id: string }).id;
  const h = (c: string) => `0x${c.repeat(64)}`;
  const run = (id: string, turnVersion: number, state: string, endedAt: Date, mode: string, cost: string | null, action: unknown) => ({ id, taskId, turnVersion, reason: "scheduled", mode, state, attempt: 1, model: "model-x", promptHash: h("a"), actionJson: action, decisionSummary: `d${turnVersion}`, nextCheckAt: new Date(endedAt.getTime() + 3_600_000), invalidation: state === "COMPLETED" ? "if payrolls slip" : null, usageJson: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 }, costUsdMicros: cost, startedAt: endedAt, endedAt, createdAt: endedAt, updatedAt: endedAt });
  await e.db.insert(verifyAgentRuns).values([
    run("run_j1", 1, "COMPLETED", IN("14:00"), "LIVE", "1500", { kind: "intent", ref: "int_x", status: "certified" }),
    run("run_j2", 2, "COMPLETED", IN("15:00"), "LIVE", "2500", { kind: "status", ref: "turn:2", status: "waiting" }),
    run("run_j3", 3, "FAILED", IN("16:00"), "LIVE", null, null),
    // 前一天：不计入
    run("run_j0", 9, "COMPLETED", new Date("2026-09-17T15:00:00.000Z"), "LIVE", "99999", { kind: "status", ref: "turn:9", status: "waiting" }),
  ]);
  await appendTimeline(e.db, taskId, [
    { at: IN("14:00").toISOString(), type: "intent_certified", ref: "int_x", note: "buy 50" },
    { at: IN("14:30").toISOString(), type: "agent_needs_evidence", note: "wants the payrolls print" },
    { at: IN("15:30").toISOString(), type: "execution_failed", note: "cert expired" },
    { at: IN("15:31").toISOString(), type: "recertified", note: "new certificate" },
    { at: "2026-09-19T05:00:00.000Z", type: "execution_failed", note: "next NY day: excluded" },
  ], "system");
  // 成交：任务的授权 + 当日确认的步骤
  const base = { callerId: `web:${owner}`, ownerAddress: owner, chainId: 196, planGuardAddress: "0x7777777777777777777777777777777777777777", mandateJson: { side: "buy", sku: "task_bundle", inputAssetKey: FIXTURE_STABLE_KEY, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10000 }], outputSet: [], planId: null }, signature: "0x", policyDefinitionHash: h("1"), effectivePolicyHash: h("2"), policySnapshot: {}, registryHash: h("3"), state: "ACTIVE", budgetCap: "100", maxSteps: 3, validFrom: IN("00:00"), deadline: IN("23:00"), createdAt: IN("00:00"), updatedAt: IN("00:00"), taskId };
  await e.db.insert(verifyMandates).values([{ ...base, id: "mnd_jbuy", clientRequestId: "jb", mandateDigest: h("4"), side: "buy" }, { ...base, id: "mnd_jsell", clientRequestId: "js", mandateDigest: h("5"), side: "sell" }]);
  const step = (id: string, mandateId: string, idx: number, confirmedAt: string) => ({ id, mandateId, stepIndex: idx, state: "CONFIRMED", stepJson: {}, stepDigest: h("6"), certificateJson: {}, certificateSignature: "0x", validUntil: IN("23:00"), txHash: h(String(idx + 7)), receiptJson: { confirmedAt, event: { spent: "50000000", received: "250000000000000000" } }, createdAt: IN("00:00"), updatedAt: IN("00:00") });
  await e.db.insert(verifyMandateSteps).values([step("stp_j1", "mnd_jbuy", 0, IN("14:05").toISOString()), step("stp_j2", "mnd_jsell", 0, IN("19:00").toISOString()), step("stp_j3", "mnd_jbuy", 1, "2026-09-19T14:00:00.000Z")]);
  return taskId;
}

describe("R4 · 夜班日志 Agent 段（纽约交易日）", () => {
  it("聚合当日轮次 / 动作 / 等待 / 成交 / 成本 / 故障与恢复；前后两天的数据不计入", async () => {
    env = await createTestEnv({ extraKeys: WEB_KEYS });
    const taskId = await seed(env);
    const w = recapWindow(DAY);
    const j = await buildAgentJournal(env.db, owner, DAY, w.dayStartUtc, w.dayEndUtc);
    expect(j.taskIds).toContain(taskId);
    expect(j.runs.total).toBe(3);
    expect(j.runs.byState).toEqual({ COMPLETED: 2, FAILED: 1 });
    expect(j.cost).toMatchObject({ totalUsdMicros: "4000", byMode: { LIVE: "4000" }, inputTokens: 300, outputTokens: 60, cacheReadTokens: 15, runsWithoutCost: 1 });
    expect(j.actions.byType).toEqual({ intent_certified: 1 });
    expect(j.waits.map((x) => [x.source, x.type])).toEqual([["timeline", "agent_needs_evidence"], ["run", "agent_waiting"]]);
    expect(j.waits[1]).toMatchObject({ invalidation: "if payrolls slip" });
    expect(j.fills.map((f) => [f.mandateId, f.side, f.stepIndex])).toEqual([["mnd_jbuy", "buy", 0], ["mnd_jsell", "sell", 0]]);
    expect(j.fills[0]).toMatchObject({ spentRaw: "50000000", receivedRaw: "250000000000000000" });
    expect(j.faults.map((f) => f.type)).toEqual(["execution_failed", "run_failed"]);
    expect(j.recoveries.map((f) => f.type)).toEqual(["recertified"]);
    // 另一个 owner：空
    const other = await buildAgentJournal(env.db, "0x000000000000000000000000000000000000dead", DAY, w.dayStartUtc, w.dayEndUtc);
    expect(other.runs.total).toBe(0);
  });

  it("经 RecapsService 出现在 owner 的 Recap（recap.agent），公开视图不含", async () => {
    env = await createTestEnv({ extraKeys: WEB_KEYS, now: "2026-09-18T21:30:00.000Z" });
    await seed(env);
    const recap = await env.recaps.forOwner(`web:${owner}`, owner, DAY);
    expect("status" in recap && recap.status === "pending").toBe(false);
    const r = recap as Exclude<typeof recap, { status: "pending" }>;
    expect(r.agent?.runs.total).toBe(3);
    expect(r.agent?.fills.length).toBe(2);
    const pub = publicRecapView({ ...r, share: { ...r.share, public: true, shareId: "rsh_x" } });
    expect(JSON.stringify(pub)).not.toContain("run_j1");
    expect(pub["agent"]).toBeUndefined();
  });
});
