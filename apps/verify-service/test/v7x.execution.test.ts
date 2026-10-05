/** v7 Lane X · 执行作业与步骤生命周期（pglite + 假链）：X-09、X-10、X-12～X-16（服务侧）、X-18（服务侧）、X-21、X-22、签发闸门、清扫器补建、SEC-03（执行者路由） */
import { afterEach, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { eq } from "drizzle-orm";
import { verifyExecutionJobs, verifyMandateSteps } from "@chaconne/db";
import { api, TEST_PLANGUARD } from "./helpers";
import { mandateStepMatcher, verifyReceiptsOnce, type ReceiptSource } from "../src/execution/receipts";
import { MandatesService } from "../src/mandates/service";
import { checklist, createV7Env, delegateFully, ex, EXEC_ADDR, EXEC_ADDR_2, EXEC_KEY, goalBody, intent, owner, rawTx, signMandates, signPermit, STABLE, type V7Env } from "./v7xHelpers";

let v: V7Env | null = null;
afterEach(async () => {
  await v?.e.close();
  v = null;
});

type ClaimedJob = { id: string; kind: string; attempt: number; state: string; stepId: string; validUntil: string; fault: { kind: string } | null; rawTxHash: string | null; recover?: boolean };

async function hostedTask(env: V7Env, over: Record<string, unknown> = {}) {
  const r = await api(env.e, "POST", "/v1/tasks", goalBody(over, { allowSell: false }));
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
  const taskId = (r.json["task"] as { id: string }).id;
  await delegateFully(env, taskId);
  return taskId;
}
async function submit(env: V7Env, taskId: string, over: Record<string, unknown> = {}) {
  return api(env.e, "POST", `/v1/tasks/${taskId}/intents`, intent(over));
}
async function claimOne(env: V7Env, executor = EXEC_ADDR, instance = "inst-aaaaaaaa"): Promise<ClaimedJob> {
  const c = await ex.claim(env, executor, instance);
  expect(c.status, JSON.stringify(c.json).slice(0, 300)).toBe(200);
  return (c.json["jobs"] as ClaimedJob[])[0]!;
}
async function jobRow(env: V7Env, id: string) {
  return (await env.e.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.id, id)))[0]!;
}
async function stepRow(env: V7Env, id: string) {
  return (await env.e.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.id, id)))[0]!;
}
async function sendAndLand(env: V7Env, job: ClaimedJob, opts: { land?: boolean } = {}) {
  const raw = rawTx(`${job.id}:${job.attempt}`);
  const h = keccak256(raw);
  const s = await ex.event(env, job.id, { attempt: job.attempt, type: "sending", rawTxHash: h, nonce: "7", rawTx: raw });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  if (opts.land !== false) await landFromStep(env, job.stepId, h);
  const sent = await ex.event(env, job.id, { attempt: job.attempt, type: "sent", txHash: h });
  expect(sent.status).toBe(200);
  return h;
}
/** 在假链上执行这一步（MandateStep 事件字段取自该步骤行的证书） */
async function landFromStep(env: V7Env, stepId: string, txHash: Hex) {
  const st = await stepRow(env, stepId);
  const s = (st.stepJson as { step: { mandateDigest: string; outputToken: string; amountIn: string; evidenceHash: string } }).step;
  env.chain.landStep(txHash, { digest: s.mandateDigest, stepIndex: st.stepIndex, outputToken: s.outputToken, amountIn: s.amountIn, evidenceHash: s.evidenceHash });
}
const source = (env: V7Env): ReceiptSource => ({ getReceipt: (h) => env.chain.getReceipt(h), headBlock: async () => env.chain.head_.number });
async function confirmReceipts(env: V7Env) {
  env.chain.mine(10n);
  return verifyReceiptsOnce(env.e.stepReceipts, source(env), { guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(env.e.cfgNow()) });
}
function setNow(env: V7Env, iso: string) {
  env.e.setNow(iso);
  env.chain.setNow(iso);
}
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("X-22 作业制任务不交出 READY 体；挂任务授权不可绕过", () => {
  it("意图响应带 execution.jobId 无 guardCall；?step=1 → 409 platform_executes；/v1/mandates/:id/prepare-step 与 /resume → 409 task_bound_mandate", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    const r = await submit(v, taskId);
    expect(r.status, JSON.stringify(r.json).slice(0, 500)).toBe(201);
    expect(r.json["guardCall"]).toBeUndefined();
    expect(r.json["certificate"]).toBeUndefined();
    const exec = r.json["execution"] as { mode: string; jobId: string };
    expect(exec.mode).toBe("hosted");
    expect(exec.jobId).toMatch(/^exj_/);
    const it1 = r.json["intent"] as { id: string; step: { mandateId: string } };
    const withStep = await api(v.e, "GET", `/v1/tasks/${taskId}/intents/${it1.id}?step=1`);
    expect(withStep.status).toBe(409);
    expect(withStep.json["error"]).toBe("platform_executes");
    const mid = it1.step.mandateId;
    expect((await api(v.e, "POST", `/v1/mandates/${mid}/prepare-step`, {})).json["error"]).toBe("task_bound_mandate");
    expect((await api(v.e, "POST", `/v1/mandates/${mid}/resume`, {})).json["error"]).toBe("task_bound_mandate");
    // 停止永远可以
    expect((await api(v.e, "POST", `/v1/mandates/${mid}/pause`, {})).status).toBe(200);
    // 步骤此刻未被取走（只有执行身份领取时才原子取走）
    const job = await jobRow(v, exec.jobId);
    expect((await stepRow(v, job.stepId!)).pulledAt).toBeNull();
  });
});

describe("X-09 围栏与租约；SEC-03 执行者路由", () => {
  it("旧 attempt 的事件 409；abandoned / 租约过期回队后新 attempt 正常；同地址第二实例 409；普通 key 403", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    expect((await submit(v, taskId)).status).toBe(201);
    const j1 = await claimOne(v);
    expect(j1.attempt).toBe(1);
    expect((await stepRow(v, j1.stepId)).pulledAt).not.toBeNull();
    expect((await ex.event(v, j1.id, { attempt: 2, type: "abandoned", reason: "x" })).json["error"]).toBe("stale_attempt");
    expect((await ex.claim(v, EXEC_ADDR, "inst-bbbbbbbb")).json["error"]).toBe("executor_instance_conflict");
    expect((await api(v.e, "POST", "/v1/executor/claim", { executor: EXEC_ADDR, instanceId: "inst-aaaaaaaa" })).status).toBe(403);
    expect((await ex.event(v, j1.id, { attempt: 1, type: "abandoned", reason: "restart" })).status).toBe(200);
    expect((await jobRow(v, j1.id)).state).toBe("QUEUED");
    const j2 = await claimOne(v);
    expect(j2.id).toBe(j1.id);
    expect(j2.attempt).toBe(2);
    // 租约过期 → 清扫器回队 → attempt 3；attempt 2 的事件被拒
    await v.e.db.update(verifyExecutionJobs).set({ leaseUntil: new Date(Date.parse(v.e.cfgNow()) - 1000) }).where(eq(verifyExecutionJobs.id, j1.id));
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, j1.id)).state).toBe("QUEUED");
    const j3 = await claimOne(v);
    expect(j3.attempt).toBe(3);
    const raw = rawTx("old");
    expect((await ex.event(v, j1.id, { attempt: 2, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw })).json["error"]).toBe("stale_attempt");
  });
});

describe("X-10 发送提交点", () => {
  it("暂停后 sending 被拒（作业 CANCELLED）；撤回后被拒；证书剩余 < 8 s 被拒且作业当场 EXPIRED", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    expect((await submit(v, taskId)).status).toBe(201);
    const j = await claimOne(v);
    const pause = await api(v.e, "POST", `/v1/tasks/${taskId}/pause`, {});
    expect(String(pause.json["note"])).toMatch(/Hosted execution: pause takes effect before sending/);
    const raw = rawTx("p");
    const r1 = await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw });
    expect(r1.status).toBe(409);
    expect(r1.json["error"]).toBe("not_allowed_now");
    expect((await jobRow(v, j.id)).state).toBe("CANCELLED");
    // 恢复 → 新意图；撤回后 sending 被拒
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/resume`, {})).status).toBe(200);
    // 被取走的旧证书在签名 validUntil + margin 之前挡住重签
    const blocked = await submit(v, taskId);
    expect(JSON.stringify(blocked.json)).toMatch(/EXECUTION_IN_FLIGHT/);
    setNow(v, new Date((sec(j.validUntil) + 16) * 1000).toISOString());
    const r2 = await submit(v, taskId);
    expect(r2.status, JSON.stringify(r2.json).slice(0, 400)).toBe(201);
    const it2 = r2.json["intent"] as { id: string };
    const j2 = await claimOne(v);
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/intents/${it2.id}/withdraw`, {})).status).toBe(200);
    const r3 = await ex.event(v, j2.id, { attempt: j2.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw });
    expect(r3.status).toBe(409);
    // 证书剩余不足
    setNow(v, new Date((sec(j2.validUntil) + 16) * 1000).toISOString());
    expect((await submit(v, taskId)).status).toBe(201);
    const j3 = await claimOne(v);
    setNow(v, new Date((sec(j3.validUntil) - 5) * 1000).toISOString());
    const r4 = await ex.event(v, j3.id, { attempt: j3.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw });
    expect(r4.status).toBe(409);
    expect((r4.json["details"] as { code: string }).code).toBe("cert_remaining_low");
    expect((await jobRow(v, j3.id)).state).toBe("EXPIRED");
    // 从未广播：链上没有任何成交
    expect(v.chain.logs).toHaveLength(0);
  });
});

describe("清扫器补建 / X-16 链上超前回填 / X-21 回执归因", () => {
  it("作业缺失 → 清扫器补建（step_id 唯一，幂等）", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    const r = await submit(v, taskId);
    const jobId = (r.json["execution"] as { jobId: string }).jobId;
    const stepId = (await jobRow(v, jobId)).stepId!;
    await v.e.db.delete(verifyExecutionJobs).where(eq(verifyExecutionJobs.id, jobId));
    expect((await v.wiring.handles.jobs!.sweep()).created).toBe(1);
    expect((await v.wiring.handles.jobs!.sweep()).created).toBe(0);
    expect((await v.wiring.handles.jobs!.byStep(stepId))!.state).toBe("QUEUED");
  });
  it("X-16 别人执行了这一步 → 回填 CONFIRMED，spent / stepsDone 一致；再跑一次不变；未发送作业取消；不重签", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    const r = await submit(v, taskId);
    const jobId = (r.json["execution"] as { jobId: string }).jobId;
    const job = await jobRow(v, jobId);
    await landFromStep(v, job.stepId!, `0x${"77".repeat(32)}`);
    v.chain.mine(10n);
    const m = (await v.e.mandates.byId(job.mandateId!))!;
    expect((await v.e.mandates.backfillMandate(m)).backfilled).toBe(1);
    const m2 = (await v.e.mandates.byId(job.mandateId!))!;
    expect(m2.stepsDone).toBe(1);
    expect(m2.spent).toBe("50000000");
    expect((await stepRow(v, job.stepId!)).state).toBe("CONFIRMED");
    expect((await jobRow(v, jobId)).state).toBe("CANCELLED");
    expect((await v.e.mandates.backfillMandate(m2)).backfilled).toBe(0);
    expect((await v.e.mandates.byId(job.mandateId!))!.spent).toBe("50000000");
    expect(v.wiring.handles.ops.recentAlerts()).toHaveLength(0);
  });
  it("X-16 回填与回执核实器同一确认深度：成交不足 RECEIPT_CONFIRMATIONS 个确认 → 本轮不记 CONFIRMED、新意图仍被闸门挡住；够了再回填（e2e 分叉上发现：1 个确认就记了 CONFIRMED）", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    const r = await submit(v, taskId);
    const jobId = (r.json["execution"] as { jobId: string }).jobId;
    const job = await jobRow(v, jobId);
    await landFromStep(v, job.stepId!, `0x${"78".repeat(32)}`);
    v.chain.mine(2n); // 3 个确认 < 6
    const m = (await v.e.mandates.byId(job.mandateId!))!;
    expect((await v.e.mandates.backfillMandate(m)).backfilled).toBe(0);
    expect((await v.e.mandates.byId(job.mandateId!))!.stepsDone).toBe(0);
    expect((await stepRow(v, job.stepId!)).state).not.toBe("CONFIRMED");
    const again = await submit(v, taskId);
    expect(again.status).toBe(422);
    expect(JSON.stringify(again.json)).toMatch(/STEP_AWAITING_CONFIRMATION|EXECUTION_IN_FLIGHT/);
    v.chain.mine(10n);
    expect((await v.e.mandates.backfillMandate(m)).backfilled).toBe(1);
    expect((await stepRow(v, job.stepId!)).state).toBe("CONFIRMED");
    expect((await v.e.mandates.byId(job.mandateId!))!.stepsDone).toBe(1);
  });
  it("X-21 同 index 新旧证书：旧证书（已取走、被 SUPERSEDED）在链上成交 → 成交记旧意图名下、活行转 SUPERSEDED、无告警；字段都不匹配 → integrity_alert", async () => {
    v = await createV7Env();
    v.chain.setAllowance(STABLE, 10_000_000_000n); // agent-wallet：用户自己的额度（不走代付）
    const taskId = await hostedTask(v, { executor: { mode: "agent_wallet" } });
    const r1 = await submit(v, taskId, { amountInRaw: "40000000" });
    expect(r1.status, JSON.stringify(r1.json).slice(0, 300)).toBe(201);
    expect(r1.json["guardCall"]).toBeDefined(); // agent-wallet：READY 体照旧交出（已取走）
    const old = r1.json["intent"] as { id: string; step: { mandateId: string; stepIndex: number; validUntil: string } };
    const rowsBefore = await v.e.mandates.rowsAt(old.step.mandateId, 0);
    const oldStep = rowsBefore[0]!;
    // 窗口内：重签被挡
    expect(JSON.stringify((await submit(v, taskId, { amountInRaw: "60000000" })).json)).toMatch(/EXECUTION_IN_FLIGHT/);
    setNow(v, new Date((MandatesService.signedValidUntil(oldStep) + 16) * 1000).toISOString());
    const r2 = await submit(v, taskId, { amountInRaw: "60000000" });
    expect(r2.status, JSON.stringify(r2.json).slice(0, 300)).toBe(201);
    const rows = await v.e.mandates.rowsAt(old.step.mandateId, 0);
    expect(rows.find((x) => x.id === oldStep.id)!.state).toBe("SUPERSEDED");
    const live = MandatesService.liveRow(rows)!;
    expect(live.id).not.toBe(oldStep.id);
    // 链上真正执行的是旧证书；执行者按 index 报了 tx
    const h = `0x${"aa".repeat(32)}` as Hex;
    await landFromStep(v, oldStep.id, h);
    expect((await api(v.e, "POST", `/v1/mandates/${old.step.mandateId}/steps/0/submissions`, { txHash: h })).status).toBe(202);
    await confirmReceipts(v);
    const after = await v.e.mandates.rowsAt(old.step.mandateId, 0);
    expect(after.find((x) => x.id === oldStep.id)!.state).toBe("CONFIRMED");
    expect(after.find((x) => x.id === live.id)!.state).toBe("SUPERSEDED");
    expect(v.wiring.handles.ops.recentAlerts()).toHaveLength(0);
    expect((await v.e.mandates.byId(old.step.mandateId))!.spent).toBe("40000000");
    // 字段都不匹配 → integrity_alert（步骤记 UNKNOWN，不记成交）
    setNow(v, new Date((MandatesService.signedValidUntil(live) + 600) * 1000).toISOString());
    const r3 = await submit(v, taskId, { amountInRaw: "30000000" });
    expect(r3.status, JSON.stringify(r3.json).slice(0, 300)).toBe(201);
    const s3 = MandatesService.liveRow(await v.e.mandates.rowsAt(old.step.mandateId, 1))!;
    const h2 = `0x${"bb".repeat(32)}` as Hex;
    v.chain.landStep(h2, { digest: (s3.stepJson as { step: { mandateDigest: string } }).step.mandateDigest, stepIndex: 1, outputToken: "0x2222222222222222222222222222222222222222", amountIn: "12345", evidenceHash: `0x${"ee".repeat(32)}` });
    await api(v.e, "POST", `/v1/mandates/${old.step.mandateId}/steps/1/submissions`, { txHash: h2 });
    await confirmReceipts(v);
    expect((await stepRow(v, s3.id)).state).toBe("UNKNOWN");
    expect(v.wiring.handles.ops.recentAlerts().some((a) => a.code === "integrity_alert")).toBe(true);
  });
});

describe("故障演练（服务侧）", () => {
  it("X-12 cert_void：提交点被拒并当场 EXPIRED → 闸门等到签名 validUntil + margin → 自动重签一次 → 成交一次；时间线 recertified", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    const f = await api(v.e, "POST", "/v1/ops/faults", { kind: "cert_void", taskId });
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    const r = await submit(v, taskId);
    const intentId = (r.json["intent"] as { id: string }).id;
    const j = await claimOne(v);
    expect(j.fault?.kind).toBe("cert_void");
    setNow(v, new Date((sec(j.validUntil) - 5) * 1000).toISOString());
    const raw = rawTx("cv");
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw })).status).toBe(409);
    expect((await jobRow(v, j.id)).state).toBe("EXPIRED");
    expect(v.wiring.handles.outcomes!.pendingIntents()).toEqual([intentId]);
    expect(await v.wiring.handles.outcomes!.tick()).toBe(0); // 闸门 3：被取走的证书还在窗口内
    setNow(v, new Date((sec(j.validUntil) + 16) * 1000).toISOString());
    expect(await v.wiring.handles.outcomes!.tick()).toBe(1);
    const it = await v.e.tasks.intents.byId(intentId);
    expect(it!.attempts).toBe(2);
    expect(it!.status).toBe("certified");
    expect(it!.jobId).not.toBe(j.id);
    const j2 = await claimOne(v);
    expect(j2.id).toBe(it!.jobId);
    expect(j2.fault).toBeNull(); // 一次性
    await sendAndLand(v, j2);
    await confirmReceipts(v);
    expect((await jobRow(v, j2.id)).state).toBe("CONFIRMED");
    expect(v.chain.logs).toHaveLength(1);
    const tl = await api(v.e, "GET", `/v1/tasks/${taskId}`);
    expect(JSON.stringify(tl.json["timeline"])).toMatch(/recertified/);
  });
  it("X-13 receipt_delay：广播后不报回执 → 新意图被闸门挡（步骤已提交）→ 回执核实器确认 → 成交一次", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    await sendAndLand(v, j);
    expect((await stepRow(v, j.stepId)).state).toBe("SUBMITTED");
    const again = await submit(v, taskId);
    expect(JSON.stringify(again.json), JSON.stringify((again.json["intent"] as { checks: unknown }).checks).slice(0, 1500)).toMatch(/STEP_AWAITING_CONFIRMATION/);
    await confirmReceipts(v);
    expect((await jobRow(v, j.id)).state).toBe("CONFIRMED");
    expect(v.chain.logs).toHaveLength(1);
  });
  it("X-14 rpc_timeout：sending 后断连 → 重启领取带回 SENDING 作业（recover）→ 同一 rawTxHash 再确认 → sent → 不重发", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    const raw = rawTx("rt");
    const h = keccak256(raw);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: h, nonce: "3", rawTx: raw })).status).toBe(200);
    await landFromStep(v, j.stepId, h);
    // 新进程（新 instanceId，旧实例租约仍在 → 要等它过期；这里模拟旧实例已退出：租约过期）
    v.e.setNow(new Date(Date.parse(v.e.cfgNow()) + 91_000).toISOString());
    const rec = await claimOne(v, EXEC_ADDR, "inst-cccccccc");
    expect(rec.recover).toBe(true);
    expect(rec.state).toBe("SENDING");
    expect(rec.rawTxHash).toBe(h);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sent", txHash: h })).status).toBe(200);
    await confirmReceipts(v);
    expect((await jobRow(v, j.id)).state).toBe("CONFIRMED");
    expect(v.chain.logs).toHaveLength(1);
  });
  it("X-15 double_claim：租约立即过期 → 第二个执行者领取（attempt 2）→ 第一个的事件 409", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    expect((await api(v.e, "POST", "/v1/ops/faults", { kind: "double_claim", taskId })).status).toBe(201);
    await submit(v, taskId);
    const j1 = await claimOne(v, EXEC_ADDR, "inst-aaaaaaaa");
    await v.wiring.handles.jobs!.sweep();
    const j2 = await claimOne(v, EXEC_ADDR_2, "inst-dddddddd");
    expect(j2.id).toBe(j1.id);
    expect(j2.attempt).toBe(2);
    const raw = rawTx("dc");
    expect((await ex.event(v, j1.id, { attempt: 1, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw })).json["error"]).toBe("stale_attempt");
    await sendAndLand(v, j2);
    await confirmReceipts(v);
    expect((await jobRow(v, j1.id)).state).toBe("CONFIRMED");
    expect(v.chain.logs).toHaveLength(1);
  });
  it("未挂故障时作业的 fault 恒为 null；FAULT_INJECTION 关闭 → /v1/ops/faults 403；执行者 key 不是运营者", async () => {
    v = await createV7Env({ env: { FAULT_INJECTION_ENABLED: "false" } });
    expect((await api(v.e, "POST", "/v1/ops/faults", { kind: "cert_void" })).status).toBe(403);
    expect((await api(v.e, "GET", "/v1/ops/status", undefined, {}, EXEC_KEY)).status).toBe(403);
    expect((await api(v.e, "GET", "/v1/ops/status")).status).toBe(200);
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    expect((await claimOne(v)).fault).toBeNull();
  });
});

describe("X-18 gas 低（服务侧）", () => {
  it("心跳 gasLow → 运行态 needsOperator 含 executor_gas_low；无心跳 → executor_offline", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    const view0 = await api(v.e, "GET", `/v1/tasks/${taskId}`);
    expect((view0.json["runtime"] as { needsOperator: string[] }).needsOperator).toContain("executor_offline");
    expect((await ex.heartbeat(v, { executor: EXEC_ADDR, instanceId: "inst-aaaaaaaa", mode: "eoa", gasBalanceWei: "5", chainHead: "1", version: "t", gasLow: true })).status).toBe(204);
    const view = await api(v.e, "GET", `/v1/tasks/${taskId}`);
    const rt = view.json["runtime"] as { needsOperator: string[]; executor: { state: string; address: string } };
    expect(rt.needsOperator).toContain("executor_gas_low");
    expect(rt.executor.state).toBe("gas_low");
    expect(rt.executor.address).toBe(EXEC_ADDR);
    void STABLE;
  });
});

describe("X-11 预检失败 → 失败分类与 needsOwner", () => {
  it("allowance_low → 作业 FAILED（allowance 类）→ needsOwner allowance_low；replan 类 → 不重签、时间线 execution_failed", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "preflight_failed", code: "allowance_low" })).status).toBe(200);
    const row = await jobRow(v, j.id);
    expect(row.state).toBe("FAILED");
    expect((row.resultJson as { cls: string }).cls).toBe("allowance");
    const rt = (await api(v.e, "GET", `/v1/tasks/${taskId}`)).json["runtime"] as { needsOwner: Array<{ code: string; blocking: boolean }> };
    expect(rt.needsOwner.find((n) => n.code === "allowance_low")).toMatchObject({ blocking: true });
    setNow(v, new Date((sec(j.validUntil) + 16) * 1000).toISOString());
    await submit(v, taskId);
    const j2 = await claimOne(v);
    expect((await ex.event(v, j2.id, { attempt: j2.attempt, type: "preflight_failed", code: "would_revert", revert: { cls: "replan", error: "InsufficientOutput", message: "InsufficientOutput(1,2)" } })).status).toBe(200);
    expect(((await jobRow(v, j2.id)).resultJson as { cls: string }).cls).toBe("replan");
    expect(v.wiring.handles.outcomes!.pendingIntents()).toHaveLength(0);
    const tl = (await api(v.e, "GET", `/v1/tasks/${taskId}`)).json["timeline"];
    expect(JSON.stringify(tl)).toMatch(/execution_failed/);
  });
});

describe("对账器（reconcileStep）与 permit 抢跑", () => {
  it("SENT 作业：链上步序没动且链头时间 > 签名 validUntil + 15 → 作业 EXPIRED、步骤 EXPIRED（确定没执行）→ 进入自动重签队列", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    const r = await submit(v, taskId);
    const intentId = (r.json["intent"] as { id: string }).id;
    const j = await claimOne(v);
    await sendAndLand(v, j, { land: false });
    expect((await jobRow(v, j.id)).state).toBe("SENT");
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, j.id)).state).toBe("SENT"); // 窗口内：WAIT
    setNow(v, new Date((sec(j.validUntil) + 16) * 1000).toISOString());
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, j.id)).state).toBe("EXPIRED");
    expect((await stepRow(v, j.stepId)).state).toBe("EXPIRED");
    expect(v.wiring.handles.outcomes!.pendingIntents()).toContain(intentId);
  });
  it("permit 签名被别人抢先上链（nonce 已前进）且额度已设 → 视为确认", async () => {
    v = await createV7Env();
    const r = await api(v.e, "POST", "/v1/tasks", goalBody({}, { allowSell: false }));
    const taskId = (r.json["task"] as { id: string }).id;
    await signMandates(v, taskId);
    const c = await checklist(v, taskId);
    const p = c.items.find((i) => i.kind === "permit")!;
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: await signPermit(p.typedData!) })).status).toBe(202);
    const job = await claimOne(v);
    const raw = rawTx("pf");
    expect((await ex.event(v, job.id, { attempt: job.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw })).status).toBe(200);
    // 别人用同一签名先上链：nonce + 1、额度 = value；我们的交易没有回执
    v.chain.tokenNonces.set(`${STABLE}:${owner}`, 1n);
    v.chain.setAllowance(STABLE, 502_500_000n);
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, job.id)).state).toBe("CONFIRMED");
    expect((await checklist(v, taskId)).buyReady).toBe(true);
  });
});
