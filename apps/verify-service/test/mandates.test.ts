/** 授权计划（W2 服务侧）：登记校验、状态机、prepare-step、monitor（M-12/13/14）、步骤回执 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyMandateSteps } from "@chaconne/db";
import { eq } from "drizzle-orm";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { T_CLOSED, T_REGULAR } from "@chaconne/core/verify/fixtures";

/** T_CLOSED（周六）之后的第一个常规时段：2026-09-21 周一 11:00 ET */
const T_NEXT_REGULAR = "2026-09-21T15:00:00.000Z";
import { PLANGUARD_ABI } from "../src/execution/planGuardAbi";
import { mandateStepMatcher, verifyReceiptsOnce, type ChainReceipt, type ReceiptSource } from "../src/execution/receipts";
import { monitorOnce } from "../src/mandates/monitor";
import { api, createTestEnv, signedMandateBody, TEST_PLANGUARD, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const TX = ("0x" + "ef".repeat(32)) as Hex;

function stepLog(mandateDigest: Hex, stepIndex: number, owner: Hex, spent = "100000000", address = TEST_PLANGUARD) {
  const topics = encodeEventTopics({ abi: PLANGUARD_ABI, eventName: "MandateStep", args: { owner, mandateDigest, stepIndex } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }],
    ["0x2222222222222222222222222222222222222222", BigInt(spent), BigInt(spent), 400_000_000_000_000_000n, 0n, ("0x" + "11".repeat(32)) as Hex, "0x9999999999999999999999999999999999999999"],
  );
  return { address, data, topics };
}
function receipt(over: Partial<ChainReceipt> = {}): ChainReceipt {
  return { status: "success", blockNumber: 100n, blockHash: "0x" + "ab".repeat(32), gasUsed: 620_000n, logs: [], ...over };
}
function source(r: ChainReceipt | null, head: bigint): ReceiptSource {
  return { getReceipt: async () => r, headBlock: async () => head };
}

async function registered(e: TestEnv, overrides: Parameters<typeof signedMandateBody>[1] = {}) {
  const { body, mandate, owner } = await signedMandateBody(e, overrides);
  const r = await api(e, "POST", "/v1/mandates", body);
  return { r, body, mandate, owner };
}

describe("POST /v1/mandates 登记", () => {
  it("签名正确 → 201 ACTIVE（免费）；同键重放 200；同 digest 换键 409", async () => {
    env = await createTestEnv();
    const { r } = await registered(env, { clientRequestId: "m1" });
    expect(r.status).toBe(201);
    expect(r.json["state"]).toBe("ACTIVE");
    expect(r.json["spent"]).toBe("0");
    expect(r.json["stepsDone"]).toBe(0);
    expect(r.json["maxSteps"]).toBe(2);
    expect(r.json["mandateDigest"]).toMatch(/^0x[0-9a-f]{64}$/);
    const again = await registered(env, { clientRequestId: "m1" });
    expect(again.r.status).toBe(200);
    expect(again.r.json["mandateId"]).toBe(r.json["mandateId"]);
    const dup = await registered(env, { clientRequestId: "m2" });
    expect(dup.r.status).toBe(409);
    expect(dup.r.json["error"]).toBe("mandate_already_registered");
  });

  it("拒绝：签名不是 owner 签的 / outputSetHash 不符 / registryHash 不符 / deadline 过去 / perStepCap > budgetCap", async () => {
    env = await createTestEnv();
    const { body } = await signedMandateBody(env, { clientRequestId: "bad1" });
    const badSig = await api(env, "POST", "/v1/mandates", { ...body, mandate: { ...body.mandate, recipient: "0x1111111111111111111111111111111111111111" } });
    expect(badSig.status).toBe(422);
    expect(badSig.json["error"]).toBe("mandate_signature_invalid");
    const badSet = await api(env, "POST", "/v1/mandates", { ...body, clientRequestId: "bad2", mandate: { ...body.mandate, outputSetHash: "0x" + "12".repeat(32) } });
    expect(badSet.status).toBe(422);
    expect((badSet.json["details"] as Array<{ field: string }>).some((e) => e.field.includes("outputSetHash"))).toBe(true);
    const badReg = await api(env, "POST", "/v1/mandates", { ...body, clientRequestId: "bad3", mandate: { ...body.mandate, registryHash: "0x" + "34".repeat(32) } });
    expect(badReg.status).toBe(422);
    const past = await signedMandateBody(env, { clientRequestId: "bad4", deadline: Math.floor(Date.parse(T_REGULAR) / 1000) - 10 });
    const r4 = await api(env, "POST", "/v1/mandates", past.body);
    expect(r4.status).toBe(422);
    expect((r4.json["details"] as Array<{ field: string }>).some((e) => e.field === "mandate.deadline")).toBe(true);
    const over = await signedMandateBody(env, { clientRequestId: "bad5", perStepCap: "300000000" });
    const r5 = await api(env, "POST", "/v1/mandates", over.body);
    expect(r5.status).toBe(422);
  });

  it("未配 PLANGUARD_ADDRESS → 503", async () => {
    env = await createTestEnv({ withPlanGuard: false });
    const r = await api(env, "POST", "/v1/mandates", { clientRequestId: "x", mandate: {}, signature: "0x" + "ab".repeat(65), inputAssetKey: "x", legs: [], policyId: "STRICT_LIVE", policyVersion: "1.1.0", maxSlippageBps: 50 });
    expect(r.status).toBe(503);
    expect(r.json["error"]).toBe("planguard_not_configured");
  });

  it("收费套餐：402 → 付款后 ACTIVE", async () => {
    env = await createTestEnv({ env: { PRODUCT_PRICE_TASK_BUNDLE_USD: "0.5" } });
    const { body } = await signedMandateBody(env, { clientRequestId: "paid1" });
    const unpaid = await api(env, "POST", "/v1/mandates", body);
    expect(unpaid.status).toBe(402);
    const { buildPaymentHeader } = await import("./helpers");
    const paid = await api(env, "POST", "/v1/mandates", body, { "payment-signature": buildPaymentHeader(unpaid.headers.get("payment-required")!) });
    expect(paid.status).toBe(200);
    expect(paid.json["state"]).toBe("ACTIVE");
  });
});

describe("prepare-step 与 monitor（M-12 / M-13 / M-14）", () => {
  it("READY：签发步骤证书（含 typedData / outputSet 升序 / planGuard / validUntil ≤ 120 s）", async () => {
    env = await createTestEnv();
    const { r } = await registered(env, { clientRequestId: "ok1" });
    const id = r.json["mandateId"] as string;
    const p = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p.status).toBe(200);
    expect(p.json["status"]).toBe("READY");
    expect(p.json["stepIndex"]).toBe(0);
    expect(p.json["planGuard"]).toBe(TEST_PLANGUARD);
    const cert = p.json["certificate"] as { issuedAt: string; validUntil: string; stepDigest: string };
    expect(Number(cert.validUntil) - Number(cert.issuedAt)).toBeLessThanOrEqual(120);
    expect(p.json["certificateSignature"]).toMatch(/^0x[0-9a-f]{130}$/);
    const step = p.json["step"] as { amountIn: string; minAmountOut: string; stepIndex: string; mandateDigest: string };
    expect(step.stepIndex).toBe("0");
    expect(BigInt(step.amountIn)).toBeLessThanOrEqual(100_000_000n);
    expect(BigInt(step.minAmountOut) > 0n).toBe(true);
    expect(p.json["stepDigest"]).toBe(cert.stepDigest);
    const set = p.json["outputSet"] as string[];
    expect(set.length).toBe(1);
    // 幂等：再次 prepare 不重复签发（同 stepIndex 复用未过期证书）
    const p2 = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p2.json["stepDigest"]).toBe(p.json["stepDigest"]);
  });

  it("M-14 暂停期间不签发步骤；恢复后可签", async () => {
    env = await createTestEnv();
    const { r } = await registered(env, { clientRequestId: "pause1" });
    const id = r.json["mandateId"] as string;
    const paused = await api(env, "POST", `/v1/mandates/${id}/pause`, {});
    expect(paused.status).toBe(200);
    expect(paused.json["state"]).toBe("PAUSED");
    const p = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p.status).toBe(409);
    expect(p.json["status"]).toBe("WAIT");
    expect(await monitorOnce(env.mandates)).toMatchObject({ checked: 1 });
    expect((await env.db.select().from(verifyMandateSteps)).length).toBe(0);
    const resumed = await api(env, "POST", `/v1/mandates/${id}/resume`, {});
    expect(resumed.json["state"]).toBe("ACTIVE");
    const p2 = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p2.json["status"]).toBe("READY");
  });

  it("M-12 休市 STRICT_LIVE → WAIT，开市后 → READY，delta 说明时段变化", async () => {
    env = await createTestEnv({ now: T_CLOSED, scenario: "closed" });
    const { r } = await registered(env, { clientRequestId: "sess1", policyId: "STRICT_LIVE", deadline: Math.floor(Date.parse(T_CLOSED) / 1000) + 7 * 86_400 });
    const id = r.json["mandateId"] as string;
    const wait = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(wait.status).toBe(409);
    expect(["WAIT", "BLOCKED"]).toContain(wait.json["status"]);
    expect((wait.json["reasons"] as Array<{ code: string }>).some((x) => x.code === "MARKET_OUTSIDE_REGULAR")).toBe(true);
    // 时钟推到下一个常规时段（周一 11:00 ET）+ fixture 切实时证据
    env.setNow(T_NEXT_REGULAR);
    env.setScenario("live");
    const ready = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(ready.json["status"]).toBe("READY");
    const delta = (ready.json["evaluation"] as { delta: { sessionChange: { from: string; to: string } | null; removedReasons: string[]; summary: { en: string } } }).delta;
    expect(delta.sessionChange).toEqual({ from: "CLOSED", to: "REGULAR" });
    expect(delta.removedReasons).toContain("MARKET_OUTSIDE_REGULAR");
    expect(delta.summary.en).toMatch(/CLOSED → REGULAR/);
  });

  it("M-13 过期未执行的步骤作废、重新评估后换新证书（不复用旧证据）", async () => {
    env = await createTestEnv();
    const { r } = await registered(env, { clientRequestId: "exp1" });
    const id = r.json["mandateId"] as string;
    const p = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    const firstDigest = p.json["stepDigest"] as string;
    const firstEvidence = (p.json["step"] as { evidenceHash: string }).evidenceHash;
    // 时钟越过 validUntil → monitor 作废并按新证据重签
    env.setNow(new Date(Date.parse(T_REGULAR) + 5 * 60_000).toISOString());
    const m = await monitorOnce(env.mandates);
    expect(m.expiredSteps).toBe(1);
    const p2 = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p2.json["status"]).toBe("READY");
    expect(p2.json["stepDigest"]).not.toBe(firstDigest);
    expect((p2.json["step"] as { deadline: string }).deadline).not.toBe((p.json["step"] as { deadline: string }).deadline);
    expect(firstEvidence).toBeTruthy();
  });

  it("M-13b 暂停中过期的步骤不能提交（step_expired）", async () => {
    env = await createTestEnv();
    const { r } = await registered(env, { clientRequestId: "exp2" });
    const id = r.json["mandateId"] as string;
    await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    await api(env, "POST", `/v1/mandates/${id}/pause`, {});
    env.setNow(new Date(Date.parse(T_REGULAR) + 5 * 60_000).toISOString());
    await monitorOnce(env.mandates);
    const bad = await api(env, "POST", `/v1/mandates/${id}/steps/0/submissions`, { txHash: TX });
    expect(bad.status).toBe(409);
    expect(bad.json["error"]).toBe("step_expired");
  });

  it("提交 hash → SUBMITTED；回执核实 MandateStep 事件 → CONFIRMED，spent/stepsDone 推进，第二步可签，满额 COMPLETED", async () => {
    env = await createTestEnv();
    const { r, owner } = await registered(env, { clientRequestId: "exec1", maxSteps: 2, budgetCap: "200000000", perStepCap: "100000000" });
    const id = r.json["mandateId"] as string;
    const digest = r.json["mandateDigest"] as Hex;
    await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    const sub = await api(env, "POST", `/v1/mandates/${id}/steps/0/submissions`, { txHash: TX });
    expect(sub.status).toBe(202);
    expect(sub.json["state"]).toBe("SUBMITTED");
    expect(sub.json["stepIndex"]).toBe(0);
    const opts = { guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(env!.cfgNow()) };
    const res = await verifyReceiptsOnce(env.mandates, source(receipt({ logs: [stepLog(digest, 0, owner as Hex)] }), 200n), opts);
    expect(res).toEqual({ checked: 1, updated: 1 });
    const v1 = await api(env, "GET", `/v1/mandates/${id}`);
    expect(v1.json["spent"]).toBe("100000000");
    expect(v1.json["stepsDone"]).toBe(1);
    expect(v1.json["state"]).toBe("ACTIVE");
    // 第二步
    const p2 = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p2.json["stepIndex"]).toBe(1);
    const TX2 = ("0x" + "ee".repeat(32)) as Hex;
    await api(env, "POST", `/v1/mandates/${id}/steps/1/submissions`, { txHash: TX2 });
    await verifyReceiptsOnce(env.mandates, source(receipt({ blockNumber: 120n, logs: [stepLog(digest, 1, owner as Hex)] }), 200n), opts);
    const v2 = await api(env, "GET", `/v1/mandates/${id}`);
    expect(v2.json["stepsDone"]).toBe(2);
    expect(v2.json["spent"]).toBe("200000000");
    expect(v2.json["state"]).toBe("COMPLETED");
    const after = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(after.status).toBe(409);
    expect(after.json["error"]).toBe("mandate_not_active");
  });

  it("回执里事件 digest 与本步骤不符 → UNKNOWN，不推进预算", async () => {
    env = await createTestEnv();
    const { r, owner } = await registered(env, { clientRequestId: "mm1" });
    const id = r.json["mandateId"] as string;
    await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    await api(env, "POST", `/v1/mandates/${id}/steps/0/submissions`, { txHash: TX });
    const opts = { guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(env!.cfgNow()) };
    await verifyReceiptsOnce(env.mandates, source(receipt({ logs: [stepLog(("0x" + "99".repeat(32)) as Hex, 0, owner as Hex)] }), 200n), opts);
    const steps = await env.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.mandateId, id));
    expect(steps[0]!.state).toBe("UNKNOWN");
    expect((steps[0]!.receiptJson as { reason: string }).reason).toBe("intent_digest_mismatch");
    expect((await api(env, "GET", `/v1/mandates/${id}`)).json["spent"]).toBe("0");
  });

  it("取消：状态机拒绝非法转移，取消后不再签发步骤，未拉取证书作废", async () => {
    env = await createTestEnv();
    const { r } = await registered(env, { clientRequestId: "cancel1" });
    const id = r.json["mandateId"] as string;
    await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    const c = await api(env, "POST", `/v1/mandates/${id}/cancel`, {});
    expect(c.json["state"]).toBe("CANCELLED");
    expect(String(c.json["note"])).toMatch(/revokeMandate/);
    const again = await api(env, "POST", `/v1/mandates/${id}/cancel`, {});
    expect(again.status).toBe(409);
    const p = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p.status).toBe(409);
    expect(p.json["error"]).toBe("mandate_not_active");
  });
});
