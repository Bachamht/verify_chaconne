/**
 * v7 · D-089 修订（运营者确认 2026-10-02 14:00）：执行身份费用预算（pglite + 假链）。
 *   预留（发送提交点）/ 结算（回执实际费用）/ 结果不明继续占用；三个预算（owner/日、任务累计、平台/日）；每笔上限；
 *   permit 代付限频与预留同事务（并发不越限）；连续付费失败暂停自动重签；RPC 超时恢复不算新尝试；permit 发放值复核修正；/v1/ops/status。
 */
import { afterEach, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { verifyExecutionJobs, verifyFeeLedger, verifyMandates, verifyMandateSteps } from "@chaconne/db";
import { api, TEST_PLANGUARD } from "./helpers";
import { mandateStepMatcher, verifyReceiptsOnce } from "../src/execution/receipts";
import { checklist, createV7Env, delegateFully, ex, EXEC_ADDR, goalBody, intent, OPERATOR_KEY, owner, rawTx, runPermitJob, signMandates, signPermit, STABLE, STOCK, type V7Env } from "./v7xHelpers";

let v: V7Env | null = null;
afterEach(async () => {
  await v?.e.close();
  v = null;
});

type ClaimedJob = { id: string; kind: string; attempt: number; state: string; stepId: string; validUntil: string; rawTxHash: string | null; recover?: boolean };
/** 公开的 anvil 测试账户 #2（仅测试）：用来签一笔结构真实的交易，让服务端能解析 gas × maxFeePerGas */
const SIGNER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
async function realRaw(gas: bigint, maxFeePerGas: bigint, nonce = 0): Promise<Hex> {
  return SIGNER.signTransaction({ chainId: 196, type: "eip1559", to: TEST_PLANGUARD, data: "0x", value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: 1n, nonce });
}

async function createTask(env: V7Env, scope: Record<string, unknown> = {}) {
  const r = await api(env.e, "POST", "/v1/tasks", goalBody({}, { allowSell: false, ...scope }));
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
  return (r.json["task"] as { id: string }).id;
}
async function hostedTask(env: V7Env) {
  const taskId = await createTask(env);
  await delegateFully(env, taskId);
  return taskId;
}
async function claimOne(env: V7Env, instance = "inst-aaaaaaaa"): Promise<ClaimedJob> {
  const c = await ex.claim(env, EXEC_ADDR, instance);
  expect(c.status, JSON.stringify(c.json).slice(0, 300)).toBe(200);
  return (c.json["jobs"] as ClaimedJob[])[0]!;
}
const jobRow = async (env: V7Env, id: string) => (await env.e.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.id, id)))[0]!;
const feeRow = async (env: V7Env, jobId: string) => (await env.e.db.select().from(verifyFeeLedger).where(eq(verifyFeeLedger.jobId, jobId)))[0] ?? null;
async function landFromStep(env: V7Env, stepId: string, txHash: Hex) {
  const st = (await env.e.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.id, stepId)))[0]!;
  const s = (st.stepJson as { step: { mandateDigest: string; outputToken: string; amountIn: string; evidenceHash: string } }).step;
  env.chain.landStep(txHash, { digest: s.mandateDigest, stepIndex: st.stepIndex, outputToken: s.outputToken, amountIn: s.amountIn, evidenceHash: s.evidenceHash });
}
async function confirmReceipts(env: V7Env) {
  env.chain.mine(10n);
  return verifyReceiptsOnce(env.e.stepReceipts, { getReceipt: (h) => env.chain.getReceipt(h), headBlock: async () => env.chain.head_.number }, { guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(env.e.cfgNow()) });
}
function setNow(env: V7Env, iso: string) {
  env.e.setNow(iso);
  env.chain.setNow(iso);
}
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const submit = (env: V7Env, taskId: string, over: Record<string, unknown> = {}) => api(env.e, "POST", `/v1/tasks/${taskId}/intents`, intent(over));
const timelineOf = async (env: V7Env, taskId: string) => JSON.stringify((await api(env.e, "GET", `/v1/tasks/${taskId}`)).json["timeline"]);

describe("预留 → 结算（发送提交点按 gasLimit × maxFeePerGas 预留，回执按 gasUsed × effectiveGasPrice 结算）", () => {
  it("可解析的签名交易：预留 = gas × maxFeePerGas；确认后结算为实际费用；permit 代付同样计入", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    // 委托过程中的 permit 代付已经记账（假 rawTx 解析不了 → 按每笔上限预留，回执后按实际结算：50 000 gas × 0.02 gwei）
    const permitFees = await v.e.db.select().from(verifyFeeLedger).where(eq(verifyFeeLedger.kind, "permit"));
    expect(permitFees).toHaveLength(1);
    expect(permitFees[0]).toMatchObject({ state: "SETTLED", reserveBasis: "per_tx_cap", reservedWei: "200000000000000", actualWei: String(50_000n * 20_000_000n), outcome: "confirmed", taskId, ownerAddress: owner });
    await submit(v, taskId);
    const j = await claimOne(v);
    const raw = await realRaw(780_000n, 24_000_000n);
    const h = keccak256(raw);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: h, nonce: "0", rawTx: raw })).status).toBe(200);
    expect(await feeRow(v, j.id)).toMatchObject({ state: "RESERVED", reserveBasis: "raw_tx", gasLimit: "780000", maxFeePerGas: "24000000", reservedWei: String(780_000n * 24_000_000n), kind: "execute_step" });
    await landFromStep(v, j.stepId, h);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sent", txHash: h })).status).toBe(200);
    expect((await feeRow(v, j.id))!.state).toBe("RESERVED"); // 结果未定：继续占用
    await confirmReceipts(v);
    expect((await jobRow(v, j.id)).state).toBe("CONFIRMED");
    expect(await feeRow(v, j.id)).toMatchObject({ state: "SETTLED", actualWei: String(600_000n * 20_000_000n), gasUsed: "600000", effectiveGasPrice: "20000000", outcome: "confirmed" });
  });
  it("rawTxHash ≠ keccak256(rawTx) → 400，不预留", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    const r = await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: keccak256(rawTx("other")), nonce: "0", rawTx: rawTx("mine") });
    expect(r.status).toBe(400);
    expect(r.json["error"]).toBe("raw_tx_hash_mismatch");
    expect(await feeRow(v, j.id)).toBeNull();
  });
  it("链上回退（REVERTED）也计费；广播后结果不明（对账判 EXPIRED）→ HELD，按预留额继续计入", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    const raw = rawTx("rv");
    const h = keccak256(raw);
    await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: h, nonce: "0", rawTx: raw });
    await ex.event(v, j.id, { attempt: j.attempt, type: "sent", txHash: h });
    v.chain.receipts.set(h, { status: "reverted", blockNumber: v.chain.head_.number, blockHash: `0x${"ee".repeat(32)}`, gasUsed: 300_000n, effectiveGasPrice: 20_000_000n, logs: [] });
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, j.id)).state).toBe("REVERTED");
    expect(await feeRow(v, j.id)).toMatchObject({ state: "SETTLED", actualWei: String(300_000n * 20_000_000n), outcome: "reverted" });
    await confirmReceipts(v); // 回执核实器把步骤行记为 REVERTED，下一步才能签发
    // 新意图 → 广播 → 不上链 → 过了签名 validUntil + 15 → EXPIRED → HELD
    setNow(v, new Date((sec(j.validUntil) + 16) * 1000).toISOString()); // 闸门 3：被取走的旧证书过了签名 validUntil + margin
    expect((await submit(v, taskId)).status).toBe(201);
    const j2 = await claimOne(v);
    const raw2 = rawTx("held");
    await ex.event(v, j2.id, { attempt: j2.attempt, type: "sending", rawTxHash: keccak256(raw2), nonce: "1", rawTx: raw2 });
    await ex.event(v, j2.id, { attempt: j2.attempt, type: "sent", txHash: keccak256(raw2) });
    setNow(v, new Date((sec(j2.validUntil) + 16) * 1000).toISOString());
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, j2.id)).state).toBe("EXPIRED");
    expect(await feeRow(v, j2.id)).toMatchObject({ state: "HELD", outcome: "unknown_after_send", reservedWei: "200000000000000" });
    // 之后这笔交易其实上链了（回执出现）→ 清扫器按实际结算
    v.chain.receipts.set(keccak256(raw2), { status: "reverted", blockNumber: v.chain.head_.number, blockHash: `0x${"ef".repeat(32)}`, gasUsed: 100_000n, effectiveGasPrice: 20_000_000n, logs: [] });
    await v.wiring.handles.jobs!.sweep();
    expect((await feeRow(v, j2.id))!.state).toBe("HELD"); // HELD 行每 30 s 才查一次回执
    setNow(v, new Date((sec(j2.validUntil) + 47) * 1000).toISOString());
    await v.wiring.handles.jobs!.sweep();
    expect(await feeRow(v, j2.id)).toMatchObject({ state: "SETTLED", actualWei: String(100_000n * 20_000_000n) });
  });
});

describe("超预算 / 超每笔上限 → 发送提交点 409，作业终止，运营者处理", () => {
  it("任务累计预算不够 → 409 fee_budget_exhausted、作业 FAILED、无账本行、needsOperator、时间线如实、执行者不得广播", async () => {
    // permit 结算后实际 1e12；任务预算 2e14：一笔按每笔上限 2e14 预留就会超
    v = await createV7Env({ env: { FEE_BUDGET_PER_TASK_WEI: "200000000000000" } });
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    const raw = rawTx("over");
    const r = await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "0", rawTx: raw });
    expect(r.status).toBe(409);
    expect(r.json["error"]).toBe("fee_budget_exhausted");
    expect((r.json["details"] as { scope: string }).scope).toBe("task_total");
    const row = await jobRow(v, j.id);
    expect(row.state).toBe("FAILED");
    expect(row.errorCode).toBe("fee_budget_exhausted");
    expect(row.rawTxHash).toBeNull();
    expect(await feeRow(v, j.id)).toBeNull();
    const view = await api(v.e, "GET", `/v1/tasks/${taskId}`);
    const rt = view.json["runtime"] as { needsOperator: string[]; needsOwner: Array<{ code: string }> };
    expect(rt.needsOperator).toContain("fee_budget_exhausted");
    expect(rt.needsOperator).not.toContain("integrity_alert");
    expect(rt.needsOwner.map((n) => n.code)).not.toContain("permit_failed");
    const tl = await timelineOf(v, taskId);
    expect(tl).toMatch(/execution_blocked_fee/);
    expect(tl).toMatch(/no gas was spent/);
    expect(tl).not.toMatch(/"execution_failed"/); // 不开 Agent 轮次
  });
  it("owner 当日预算、平台当日预算分别生效", async () => {
    v = await createV7Env({ env: { FEE_BUDGET_PER_OWNER_DAY_WEI: "300000000000000" } });
    const taskId = await hostedTask(v); // permit 已用 1e12
    await submit(v, taskId);
    const j = await claimOne(v);
    const raw1 = await realRaw(1_000_000n, 200_000_000n); // 2e14：1e12 + 2e14 ≤ 3e14
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: keccak256(raw1), nonce: "0", rawTx: raw1 })).status).toBe(200);
    await v.e.close();
    v = await createV7Env({ env: { FEE_BUDGET_PLATFORM_DAY_WEI: "300000000000000", FEE_MAX_PER_TX_WEI: "300000000000000" } });
    const t2 = await hostedTask(v);
    await submit(v, t2);
    const j2 = await claimOne(v);
    const raw2 = await realRaw(1_500_000n, 200_000_000n); // 3e14 + 已用 1e12 > 3e14
    const r = await ex.event(v, j2.id, { attempt: j2.attempt, type: "sending", rawTxHash: keccak256(raw2), nonce: "0", rawTx: raw2 });
    expect(r.status).toBe(409);
    expect((r.json["details"] as { scope: string }).scope).toBe("platform_day");
  });
  it("签名交易的 gas × maxFeePerGas 超过 FEE_MAX_PER_TX_WEI → 409 fee_cap_exceeded，作业 FAILED", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    const raw = await realRaw(1_500_000n, 200_000_000n); // 3e14 > 2e14
    const r = await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "0", rawTx: raw });
    expect(r.status).toBe(409);
    expect(r.json["error"]).toBe("fee_cap_exceeded");
    expect((await jobRow(v, j.id)).state).toBe("FAILED");
    expect(((await api(v.e, "GET", `/v1/tasks/${taskId}`)).json["runtime"] as { needsOperator: string[] }).needsOperator).toContain("fee_cap_exceeded");
  });
  it("执行者预检报 fee_cap_exceeded（RPC 费率超上限）→ 同样走运营者路径", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "preflight_failed", code: "fee_cap_exceeded", detail: "fee cap exceeded: max_fee_per_gas 1000000000000 > cap 200000000" })).status).toBe(200);
    expect(((await api(v.e, "GET", `/v1/tasks/${taskId}`)).json["runtime"] as { needsOperator: string[] }).needsOperator).toContain("fee_cap_exceeded");
    expect(await timelineOf(v, taskId)).toMatch(/execution_blocked_fee/);
  });
  it("并发发送提交点：预算只够一笔 → 恰好一个 200、一个 409（预留在咨询锁下串行）", async () => {
    v = await createV7Env({ env: { FEE_BUDGET_PER_OWNER_DAY_WEI: "300000000000000" } });
    const r = await api(v.e, "POST", "/v1/tasks", goalBody({}, { allowSell: true }));
    const taskId = (r.json["task"] as { id: string }).id;
    await signMandates(v, taskId);
    const c = await checklist(v, taskId);
    for (const p of c.items.filter((i) => i.kind === "permit")) expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: await signPermit(p.typedData!) })).status).toBe(202);
    const cl = await api(v.e, "POST", "/v1/executor/claim", { executor: EXEC_ADDR, instanceId: "inst-aaaaaaaa", max: 2 }, {}, "vk_test_exec");
    const jobs = cl.json["jobs"] as ClaimedJob[];
    expect(jobs.map((j) => j.kind)).toEqual(["permit", "permit"]);
    const res = await Promise.all(jobs.map((j, i) => {
      const raw = rawTx(`cc${i}`);
      return ex.event(v!, j.id, { attempt: j.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: String(i), rawTx: raw });
    }));
    expect(res.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(res.find((x) => x.status === 409)!.json["error"]).toBe("fee_budget_exhausted");
    expect(await v.e.db.select().from(verifyFeeLedger)).toHaveLength(1);
  });
});

describe("permit 代付限频：计数与入队同一事务（修正先查后写的并发漏洞）", () => {
  async function twoPermits(env: V7Env) {
    const r = await api(env.e, "POST", "/v1/tasks", goalBody({}, { allowSell: true }));
    const taskId = (r.json["task"] as { id: string }).id;
    await signMandates(env, taskId);
    const c = await checklist(env, taskId);
    const ps = c.items.filter((i) => i.kind === "permit");
    expect(ps.map((p) => p.id).sort()).toEqual([`permit:${STABLE}`, `permit:${STOCK}`].sort());
    return { taskId, bodies: await Promise.all(ps.map(async (p) => ({ permitRequestId: p.permitRequestId, signature: await signPermit(p.typedData!) }))) };
  }
  it("每 owner 每小时 1 笔：两个不同代币的 permit 并发提交 → 恰好一个 202、一个 429", async () => {
    v = await createV7Env({ env: { PERMIT_RELAY_PER_OWNER_PER_HOUR: "1" } });
    const { taskId, bodies } = await twoPermits(v);
    const res = await Promise.all(bodies.map((b) => api(v!.e, "POST", `/v1/tasks/${taskId}/allowances`, b)));
    expect(res.map((x) => x.status).sort()).toEqual([202, 429]);
    expect(res.find((x) => x.status === 429)!.json["error"]).toBe("permit_relay_limited");
    const jobs = await v.e.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.kind, "permit"));
    expect(jobs).toHaveLength(1);
    // 被拒的那份仍是 ISSUED（整笔回滚），可在限频窗口后重交
    const c = await checklist(v, taskId);
    expect(c.items.filter((i) => i.kind === "permit").map((i) => i.status).sort()).toEqual(["submitted", "todo"]);
  });
  it("全局每天 1 笔：并发同样只放行一个", async () => {
    v = await createV7Env({ env: { PERMIT_RELAY_DAILY_MAX: "1" } });
    const { taskId, bodies } = await twoPermits(v);
    const res = await Promise.all(bodies.map((b) => api(v!.e, "POST", `/v1/tasks/${taskId}/allowances`, b)));
    expect(res.map((x) => x.status).sort()).toEqual([202, 429]);
  });
  it("费用预算没有余量 → permit 受理时 409 fee_budget_exhausted（不入队，owner 无需重签）", async () => {
    v = await createV7Env({ env: { FEE_BUDGET_PLATFORM_DAY_WEI: "100000000000000" } }); // < 每笔上限 2e14
    const taskId = await createTask(v);
    await signMandates(v, taskId);
    const p = (await checklist(v, taskId)).items.find((i) => i.kind === "permit")!;
    const r = await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: await signPermit(p.typedData!) });
    expect(r.status).toBe(409);
    expect(r.json["error"]).toBe("fee_budget_exhausted");
    expect(String(r.json["message"])).toMatch(/do not need to sign again/);
    expect(await v.e.db.select().from(verifyExecutionJobs)).toHaveLength(0);
  });
});

describe("permit 发放值复核（修正永远不会触发的比较）：value ≤ permitValue(当前需要量)", () => {
  it("发放后需要量下降、发放值超出当前需要量 + 0.5% → 422 permit_value_too_high；需要量未变 → 202", async () => {
    v = await createV7Env();
    const taskId = await createTask(v);
    await signMandates(v, taskId);
    const p = (await checklist(v, taskId)).items.find((i) => i.kind === "permit")!;
    expect((p.typedData!.message as Record<string, string>)["value"]).toBe("502500000"); // 500 USDG + 0.5%
    const sig = await signPermit(p.typedData!);
    const buy = (await v.e.db.select().from(verifyMandates).where(eq(verifyMandates.ownerAddress, owner)))[0]!;
    // 买入授权已花掉 100 USDG（例如别的路径成交）→ 需要量 400 → 上限 402
    await v.e.db.update(verifyMandates).set({ spent: "100000000" }).where(eq(verifyMandates.id, buy.id));
    const r = await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: sig });
    expect(r.status).toBe(422);
    expect(r.json["error"]).toBe("permit_value_too_high");
    expect(r.json["details"]).toMatchObject({ valueRaw: "502500000", requiredRaw: "400000000", maxRaw: "402000000" });
    await v.e.db.update(verifyMandates).set({ spent: "0" }).where(eq(verifyMandates.id, buy.id));
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: sig })).status).toBe(202);
  });
});

describe("连续付费失败暂停；RPC 超时恢复不算新尝试", () => {
  it("同一步连续 2 次付费失败（广播后未成交）→ 不再自动重签、开 execution_failed（附暂停说明）；新意图重新计数", async () => {
    v = await createV7Env({ env: { AUTO_RECERTIFY_MAX: "5", AUTO_RECERTIFY_WINDOW_S: "3600" } });
    const taskId = await hostedTask(v);
    const r = await submit(v, taskId);
    const intentId = (r.json["intent"] as { id: string }).id;
    const outcomes = v.wiring.handles.outcomes!;
    // 第 1 次：广播 → 不上链 → 过期 → 付费失败 1 → 仍自动重签
    const j1 = await claimOne(v);
    const raw1 = rawTx("p1");
    await ex.event(v, j1.id, { attempt: j1.attempt, type: "sending", rawTxHash: keccak256(raw1), nonce: "0", rawTx: raw1 });
    await ex.event(v, j1.id, { attempt: j1.attempt, type: "sent", txHash: keccak256(raw1) });
    setNow(v, new Date((sec(j1.validUntil) + 16) * 1000).toISOString());
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, j1.id)).state).toBe("EXPIRED");
    expect(outcomes.pendingIntents()).toEqual([intentId]);
    expect(await outcomes.tick()).toBe(1);
    const it1 = await v.e.tasks.intents.byId(intentId);
    expect(it1!.status).toBe("certified");
    // 第 2 次：同样失败 → 付费失败 2 → 暂停
    const j2 = await claimOne(v);
    expect(j2.id).toBe(it1!.jobId);
    const raw2 = rawTx("p2");
    await ex.event(v, j2.id, { attempt: j2.attempt, type: "sending", rawTxHash: keccak256(raw2), nonce: "1", rawTx: raw2 });
    await ex.event(v, j2.id, { attempt: j2.attempt, type: "sent", txHash: keccak256(raw2) });
    setNow(v, new Date((sec(j2.validUntil) + 16) * 1000).toISOString());
    await v.wiring.handles.jobs!.sweep();
    expect((await jobRow(v, j2.id)).state).toBe("EXPIRED");
    expect(outcomes.pendingIntents()).toEqual([]);
    const tl = await timelineOf(v, taskId);
    expect(tl).toMatch(/execution_retry_paused/);
    expect(tl).toMatch(/automatic retries paused after 2 paid failures/);
    const step = (await jobRow(v, j2.id));
    expect(await outcomes.paidFailures(step.mandateId, step.stepIndex, it1!.createdAt)).toBe(2);
    // Agent 的新意图：重新计数
    const r2 = await submit(v, taskId);
    expect(r2.status, JSON.stringify(r2.json).slice(0, 400)).toBe(201);
    const it2 = await v.e.tasks.intents.byId((r2.json["intent"] as { id: string }).id);
    expect(await outcomes.paidFailures(step.mandateId, step.stepIndex, it2!.createdAt)).toBe(0);
  });
  it("RPC 超时后查询 / 原样重播同一笔已签名交易：不建新作业、不重复预留、不计付费失败，结算一次", async () => {
    v = await createV7Env();
    const taskId = await hostedTask(v);
    await submit(v, taskId);
    const j = await claimOne(v);
    const raw = rawTx("rt");
    const h = keccak256(raw);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: h, nonce: "3", rawTx: raw })).status).toBe(200);
    const reserved = await feeRow(v, j.id);
    // 广播超时：执行者再次领取，服务端按地址带回 SENDING 作业；证书仍有效 → 同一 rawTxHash 再确认（原样重播）→ 200，不新增预留
    const rec = await claimOne(v);
    expect(rec.recover).toBe(true);
    expect(rec.id).toBe(j.id);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sending", rawTxHash: h, nonce: null, rawTx: raw })).status).toBe(200);
    expect(await v.e.db.select().from(verifyFeeLedger).where(eq(verifyFeeLedger.kind, "execute_step"))).toHaveLength(1);
    expect(await feeRow(v, j.id)).toMatchObject({ id: reserved!.id, reservedWei: reserved!.reservedWei, state: "RESERVED" });
    await landFromStep(v, j.stepId, h);
    expect((await ex.event(v, j.id, { attempt: j.attempt, type: "sent", txHash: h })).status).toBe(200);
    await confirmReceipts(v);
    expect((await jobRow(v, j.id)).state).toBe("CONFIRMED");
    expect(v.chain.logs).toHaveLength(1);
    expect(await v.e.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.kind, "execute_step"))).toHaveLength(1);
    expect(await feeRow(v, j.id)).toMatchObject({ state: "SETTLED", actualWei: String(600_000n * 20_000_000n) });
    const row = await jobRow(v, j.id);
    expect(await v.wiring.handles.outcomes!.paidFailures(row.mandateId, row.stepIndex, null)).toBe(0);
  });
});

describe("/v1/ops/status 费用预算（只给运营者）", () => {
  it("今日已用 / 上限 / 各状态；非运营者 403", async () => {
    v = await createV7Env();
    await hostedTask(v);
    const r = await api(v.e, "GET", "/v1/ops/status", undefined, {}, OPERATOR_KEY);
    expect(r.status).toBe(200);
    const fb = r.json["feeBudget"] as { limits: Record<string, string>; platformToday: { usedWei: string }; todayByState: Record<string, { count: number }>; ownersToday: Array<{ owner: string; usedWei: string }> };
    expect(fb.limits).toMatchObject({ perOwnerDayWei: "5000000000000000", perTaskWei: "2000000000000000", platformDayWei: "20000000000000000", maxPerTxWei: "200000000000000" });
    expect(fb.platformToday.usedWei).toBe(String(50_000n * 20_000_000n));
    expect(fb.todayByState["SETTLED"]!.count).toBe(1);
    expect(fb.ownersToday[0]).toMatchObject({ owner, usedWei: String(50_000n * 20_000_000n) });
    expect((await api(v.e, "GET", "/v1/ops/status", undefined, {}, "vk_test_exec")).status).toBe(403);
    void runPermitJob;
  });
});

describe("配置护栏", () => {
  it("费用预算缺省开启且偏小；设为 0 / 非整数 → 拒绝启动", async () => {
    const { loadConfig } = await import("../src/config");
    const c = loadConfig({ DATABASE_URL: "postgres://x" });
    expect(c.feeBudget).toEqual({ perOwnerDayWei: 5_000_000_000_000_000n, perTaskWei: 2_000_000_000_000_000n, platformDayWei: 20_000_000_000_000_000n, maxPerTxWei: 200_000_000_000_000n });
    expect(c.EXECUTION_PAID_FAILURE_PAUSE_N).toBe(2);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", FEE_BUDGET_PER_TASK_WEI: "0" })).toThrow(/FEE_BUDGET_PER_TASK_WEI/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", FEE_MAX_PER_TX_WEI: "1.5" })).toThrow();
  });
});
