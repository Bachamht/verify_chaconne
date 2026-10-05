/**
 * v7 Lane R · 任务证据包 v3（CV-D18）：
 *   R-03 包含全部授权（买 + 卖）、全部步骤与证书（含 SUPERSEDED）、permit、意图、轮次摘要与 runHash 链、时间线摘要；
 *   R-04 离线复算全过；改任一数字（授权 / 步骤 / permit / 轮次 / 时间线 / 成交事件）→ 对应检查失败；
 *   R-05 CLI（verify-mcp verifyBundle）与页面（core verifyEvidenceBundle，同一入口）结论一致；v2 包回归可验。
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, verifyTypedData, type Hex } from "viem";
import { verifyAgentRuns, verifyMandateSteps, verifyMandates, verifyPermits, verifyTaskTimeline, verifyTasks } from "@chaconne/db";
import { agentRunHash, bundleHash, EIP712_TYPES_V2, makePlanGuardDomain, mandateDigest, verifyEvidenceBundle, type AgentRunSummary, type BundleCheck, type EvidenceBundle, type TaskEvidenceBundle, type TradeMandate, type VerifyBundleOptions } from "@chaconne/core/verify";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, TEST_ATTESTATION_KEY, TEST_OWNER_KEY, TEST_PLANGUARD, type TestEnv } from "./helpers";
import { signedContext, testKeypair } from "./contextHelpers";
import { verifyBundle } from "../../../packages/verify-mcp/src/bundleVerify";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const AT = "2026-09-18T14:58:00.000Z";
const OWNER = privateKeyToAccount(TEST_OWNER_KEY);
const owner = OWNER.address.toLowerCase();
const SIGNER = privateKeyToAccount(TEST_ATTESTATION_KEY);
const verifiers: VerifyBundleOptions = {
  verifyTypedData: (a) => verifyTypedData({ address: a.address, domain: a.typedData.domain, types: a.typedData.types, primaryType: a.typedData.primaryType, message: a.typedData.message, signature: a.signature } as never),
  verifyMessage: (a) => verifyMessage({ address: a.address, message: { raw: a.raw }, signature: a.signature }),
  expectedSigner: SIGNER.address,
};
const big = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, keys.includes(k) ? BigInt(String(x)) : x]));

async function envWithContext() {
  const kp = testKeypair();
  const e = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
  const r = await e.crowsnest.ingest(signedContext(kp, { at: AT }), { endpoint: "test", mode: "LIVE" });
  if (!r.ok) throw new Error(`ingest failed ${r.reason}`);
  return e;
}
function taskBody() {
  return { clientRequestId: `b-${Math.random().toString(16).slice(2, 10)}`, playbookId: "session_dca", mode: "LIVE", ownerAddress: owner, params: { steps: 2, perStepAmountRaw: "100000000", inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKey: FIXTURE_STOCK_KEY }, scope: { objective: "v3 bundle", budgetCapRaw: "500000000", perStepCapRaw: "100000000", maxSteps: 5, trustTier: "agent_data", issuance: "agent", hardConditions: [{ type: "session", allow: ["US_REGULAR"] }] } };
}
async function authorize(e: TestEnv, taskId: string) {
  const v = await api(e, "GET", `/v1/tasks/${taskId}`);
  const draft = v.json["mandateDraft"] as { typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Hex }; types: Record<string, Array<{ name: string; type: string }>> }; mandate: Record<string, string> };
  const m = draft.mandate;
  const signature = await OWNER.signTypedData({ domain: draft.typedData.domain, types: draft.typedData.types, primaryType: "TradeMandate", message: big(m, ["budgetCap", "perStepCap", "validFrom", "deadline", "nonce"]) as never });
  return api(e, "POST", `/v1/tasks/${taskId}/authorize`, { signature });
}
const intentBody = () => ({ clientRequestId: `i-${Math.random().toString(16).slice(2, 10)}`, kind: "buy", outputAssetKey: FIXTURE_STOCK_KEY, amountInRaw: "50000000", decision: { rationale: "常规时段、溢价低，先买一小笔", claims: [{ kind: "agent_data", text: "另一家行情显示溢价 0.2%", source: { name: "other-feed" } }], alternatives: ["等收盘后"] } });

/** 搭一个「买 + 卖 + permit + 轮次 + 成交 + SUPERSEDED 步骤」的任务，返回 v3 包 */
async function richTask(e: TestEnv): Promise<{ taskId: string; bundle: TaskEvidenceBundle; buyId: string; sellId: string; intentId: string }> {
  const created = await api(e, "POST", "/v1/tasks", taskBody());
  expect(created.status, JSON.stringify(created.json).slice(0, 300)).toBe(201);
  const taskId = (created.json["task"] as { id: string }).id;
  const auth = await authorize(e, taskId);
  expect(auth.status, JSON.stringify(auth.json).slice(0, 300)).toBe(201);
  const buyId = auth.json["mandateId"] as string;
  await api(e, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "accepted", note: "taking over", agent: { name: "demo-agent" } });
  const it1 = await api(e, "POST", `/v1/tasks/${taskId}/intents`, intentBody());
  expect(it1.status, JSON.stringify(it1.json).slice(0, 300)).toBe(201);
  const intentId = (it1.json["intent"] as { id: string }).id;
  const now = new Date(e.cfgNow());

  // 成交：活步骤 → CONFIRMED（回执事件字段 = 步骤字段）；再放一条同 index 的 SUPERSEDED 旧证书
  const [step] = await e.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.mandateId, buyId));
  const s = (step!.stepJson as { step: Record<string, string> }).step;
  await e.db.insert(verifyMandateSteps).values({ ...step!, id: "stp_superseded_old", state: "SUPERSEDED", createdAt: new Date(now.getTime() - 60_000) });
  const event = { owner, mandateDigest: s["mandateDigest"]!.toLowerCase(), stepIndex: s["stepIndex"], outputToken: s["outputToken"]!.toLowerCase(), amountIn: s["amountIn"], spent: s["amountIn"], received: (BigInt(s["minAmountOut"]!) + 5n).toString(), refunded: "0", evidenceHash: s["evidenceHash"]!.toLowerCase(), executor: "0x9999999999999999999999999999999999999999" };
  await e.db.update(verifyMandateSteps).set({ state: "CONFIRMED", txHash: `0x${"12".repeat(32)}`, receiptJson: { txHash: `0x${"12".repeat(32)}`, status: "success", blockNumber: "100", confirmations: 6, event } }).where(eq(verifyMandateSteps.id, step!.id));

  // 卖出授权（同一 owner 签名，side = sell；Lane X 正式登记前用直接写库模拟）
  const [buyRow] = await e.db.select().from(verifyMandates).where(eq(verifyMandates.id, buyId));
  const mj = buyRow!.mandateJson as { mandate: TradeMandate; domain: { name: string; version: string; chainId: number; verifyingContract: Hex } };
  const sellMandate: TradeMandate = { ...mj.mandate, inputToken: "0x2222222222222222222222222222222222222222", nonce: String(BigInt(mj.mandate.nonce) + 1n) };
  const sellSig = await OWNER.signTypedData({ domain: mj.domain, types: { TradeMandate: [...EIP712_TYPES_V2.TradeMandate] }, primaryType: "TradeMandate", message: big(sellMandate as unknown as Record<string, unknown>, ["budgetCap", "perStepCap", "validFrom", "deadline", "nonce"]) as never });
  const sellDigest = mandateDigest(makePlanGuardDomain(mj.domain.chainId, mj.domain.verifyingContract), sellMandate);
  await e.db.insert(verifyMandates).values({ ...buyRow!, id: "mnd_sell_v3", clientRequestId: "sell-v3", mandateJson: { ...mj, mandate: sellMandate, side: "sell" }, mandateDigest: sellDigest, signature: sellSig, side: "sell", assetKey: FIXTURE_STOCK_KEY, taskId, stepsDone: 0, spent: "0" });

  // permit（EIP-2612，owner 签名；执行身份代付后 CONFIRMED）
  const permitMsg = { owner: OWNER.address, spender: TEST_PLANGUARD, value: "502500000", nonce: "0", deadline: String(Math.floor(now.getTime() / 1000) + 1800) };
  const permitTd = { domain: { name: "USD Global", version: "1", chainId: mj.domain.chainId, verifyingContract: "0x1111111111111111111111111111111111111111" as Hex }, types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, primaryType: "Permit", message: permitMsg };
  const permitSig = await OWNER.signTypedData({ domain: permitTd.domain, types: permitTd.types, primaryType: "Permit", message: big(permitMsg, ["value", "nonce", "deadline"]) as never });
  await e.db.insert(verifyPermits).values({ id: "prm_v3", taskId, itemId: "permit:0x1111111111111111111111111111111111111111", ownerAddress: owner, tokenAddress: "0x1111111111111111111111111111111111111111", spender: TEST_PLANGUARD, value: permitMsg.value, nonce: "0", deadline: permitMsg.deadline, typedDataJson: permitTd, signature: permitSig, purpose: "delegation", state: "CONFIRMED", txHash: `0x${"34".repeat(32)}`, allowanceAfter: "502500000", createdAt: now, updatedAt: now });

  // 轮次：run1 → 意图；run2 → 状态（accepted 的时间线行 ref = turn:<v>）；run3 FAILED（不进链）
  const accepted = (await e.db.select().from(verifyTaskTimeline).where(and(eq(verifyTaskTimeline.taskId, taskId), eq(verifyTaskTimeline.type, "agent_accepted"))))[0]!;
  const zero = `0x${"0".repeat(64)}` as Hex;
  const mk = (turnVersion: number, endedAt: string, action: AgentRunSummary["action"], prevRunHash: Hex | null): AgentRunSummary => {
    const r = { runId: `run_v3_${turnVersion}`, taskId, turnVersion, attempt: 1, turnReason: "authorized", mode: "LIVE" as const, model: "model-x", promptHash: `0x${"aa".repeat(32)}` as Hex, startedAt: endedAt, endedAt, state: "COMPLETED" as const, action, decisionSummary: `decision ${turnVersion}`, nextCheckAt: null, invalidation: null, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsdMicros: "100" }, prevRunHash, runHash: zero };
    return { ...r, runHash: agentRunHash(r) };
  };
  const r1 = mk(1, "2026-09-18T15:00:00.000Z", { kind: "intent", ref: intentId, status: "certified" }, null);
  const r2 = mk(2, "2026-09-18T15:10:00.000Z", { kind: "status", ref: accepted.ref!, status: "accepted" }, r1.runHash);
  for (const r of [r1, r2]) await e.db.insert(verifyAgentRuns).values({ id: r.runId, taskId, turnVersion: r.turnVersion, reason: r.turnReason, mode: r.mode, state: r.state, attempt: r.attempt, model: r.model, promptHash: r.promptHash, messagesJson: [{ role: "user", content: "not exported" }], actionJson: r.action, decisionSummary: r.decisionSummary, usageJson: r.usage, costUsdMicros: r.usage.costUsdMicros, prevRunHash: r.prevRunHash, runHash: r.runHash, startedAt: new Date(r.startedAt), endedAt: new Date(r.endedAt!), createdAt: now, updatedAt: now });
  await e.db.insert(verifyAgentRuns).values({ id: "run_v3_3", taskId, turnVersion: 3, reason: "scheduled", mode: "LIVE", state: "FAILED", attempt: 3, model: "model-x", createdAt: now, updatedAt: now });

  const b = await api(e, "GET", `/v1/tasks/${taskId}/bundle`);
  expect(b.status, JSON.stringify(b.json).slice(0, 300)).toBe(200);
  return { taskId, bundle: b.json as unknown as TaskEvidenceBundle, buyId, sellId: "mnd_sell_v3", intentId };
}

const failedIds = (cs: BundleCheck[]) => cs.filter((c) => !c.ok).map((c) => c.id);

describe("任务证据包 v3（CV-D18）", () => {
  it("R-03 / R-04 / R-05：内容齐全、离线复算全过；CLI 与页面同结论；篡改任一数字 → 对应检查失败", async () => {
    env = await envWithContext();
    const { taskId, bundle, buyId, sellId, intentId } = await richTask(env);
    // R-03 内容
    expect(bundle.bundleVersion).toBe("task/3");
    expect(bundle.mandates!.map((m) => `${m.side}:${m.mandateId}`).sort()).toEqual([`buy:${buyId}`, `sell:${sellId}`].sort());
    const buySeg = bundle.mandates!.find((m) => m.mandateId === buyId)!;
    expect(buySeg.steps.map((s) => s.state).sort()).toEqual(["CONFIRMED", "SUPERSEDED"]);
    expect(buySeg.certificates.length).toBe(2);
    expect(bundle.permits!.map((p) => p.id)).toEqual(["prm_v3"]);
    expect(bundle.agentIntents!.map((i) => i.id)).toEqual([intentId]);
    expect(bundle.agentRuns!.map((r) => r.state)).toEqual(["COMPLETED", "COMPLETED", "FAILED"]);
    expect(JSON.stringify(bundle)).not.toContain("not exported");
    const dbRows = await env.db.select().from(verifyTaskTimeline).where(eq(verifyTaskTimeline.taskId, taskId));
    expect(bundle.timelineDigest!.count).toBe(dbRows.length);
    expect(bundle.timeline!.every((r) => typeof r.actor === "string" && typeof r.id === "number")).toBe(true);

    // R-04 全过
    const checks = await verifyEvidenceBundle(bundle as EvidenceBundle, verifiers);
    expect(failedIds(checks), JSON.stringify(checks.filter((c) => !c.ok))).toEqual([]);
    const ids = checks.map((c) => c.id);
    for (const want of [`mandate_${buyId}_digest`, `mandate_${sellId}_digest`, `mandate_${buyId}_signature`, `mandate_${sellId}_signature`, "permit_prm_v3_fields", "permit_prm_v3_signature", "run_hash_chain", "run_1_action_recorded", "run_2_action_recorded", "timeline_digest", "timeline_rows_ordered"]) expect(ids, want).toContain(want);
    expect(ids.some((i) => i.endsWith("_fill_attribution"))).toBe(true);
    expect(ids.filter((i) => i.startsWith(`mandate_${buyId}_step_`) && i.endsWith("_cert_binding")).length).toBe(2);
    expect(ids.filter((i) => i.startsWith(`mandate_${buyId}_step_`) && i.endsWith("_cert_signature")).length).toBe(2);
    expect(checks.filter((c) => c.skipped)).toEqual([]);

    // R-05：CLI（verify-mcp）与页面（core 同一入口）结论一致
    const cli = await verifyBundle(bundle as EvidenceBundle, { expectedSigner: SIGNER.address });
    expect(cli.ok).toBe(true);
    expect(cli.checks.map((c) => `${c.id}:${c.ok}`)).toEqual(checks.map((c) => `${c.id}:${c.ok}`));

    // R-04 篡改：每类数字各改一处 → 对应 v3 检查失败（bundle_hash 也必然失败）
    const tamper = async (label: string, mutate: (b: TaskEvidenceBundle) => void, expectFail: (id: string) => boolean) => {
      const t = structuredClone(bundle);
      mutate(t);
      const f = failedIds(await verifyEvidenceBundle(t as EvidenceBundle, verifiers));
      expect(f, label).toContain("bundle_hash");
      expect(f.filter((id) => id !== "bundle_hash" && id !== "bundle_signature").some(expectFail), `${label}: ${f.join(",")}`).toBe(true);
    };
    const seg = (b: TaskEvidenceBundle, id: string) => b.mandates!.find((m) => m.mandateId === id)!;
    const msg = (x: unknown) => (x as { message: Record<string, string> }).message;
    await tamper("buy mandate budgetCap", (b) => { msg(seg(b, buyId).typedData)["budgetCap"] = "500000001"; }, (id) => id === `mandate_${buyId}_digest` || id === `mandate_${buyId}_signature`);
    await tamper("sell mandate perStepCap", (b) => { msg(seg(b, sellId).typedData)["perStepCap"] = "1"; }, (id) => id === `mandate_${sellId}_signature`);
    await tamper("step amountIn", (b) => { const st = seg(b, buyId).steps.find((s) => s.state === "CONFIRMED")!; st.step.amountIn = "50000001"; }, (id) => id.startsWith(`mandate_${buyId}_step_`) && (id.endsWith("_digest") || id.endsWith("_fill_attribution")));
    await tamper("superseded certificate validUntil", (b) => { const st = seg(b, buyId).steps.find((s) => s.state === "SUPERSEDED")!; st.certificate!.validUntil = String(Number(st.certificate!.validUntil) + 1); }, (id) => id.startsWith(`mandate_${buyId}_step_`) && id.endsWith("_cert_signature"));
    await tamper("fill event received", (b) => { const st = seg(b, buyId).steps.find((s) => s.state === "CONFIRMED")!; (st.receiptSummary as { event: Record<string, string> }).event["amountIn"] = "1"; }, (id) => id.endsWith("_fill_attribution"));
    await tamper("permit value", (b) => { b.permits![0]!.value = "999999999"; }, (id) => id === "permit_prm_v3_fields");
    await tamper("permit signed value", (b) => { msg(b.permits![0]!.typedData)["value"] = "999999999"; b.permits![0]!.value = "999999999"; }, (id) => id === "permit_prm_v3_signature");
    await tamper("run attempt", (b) => { b.agentRuns![0]!.attempt = 2; }, (id) => id === "run_hash_chain");
    // 成本不在 runHash 公式里（§2.6），但仍在 bundleHash 覆盖内：只有 bundle_hash 失败
    const costT = structuredClone(bundle);
    costT.agentRuns![1]!.usage.costUsdMicros = "1";
    expect(failedIds(await verifyEvidenceBundle(costT as EvidenceBundle, verifiers))).toEqual(["bundle_hash"]);
    await tamper("timeline row id", (b) => { b.timeline![0]!.id = b.timeline![0]!.id! + 1_000_000; }, (id) => id === "timeline_digest" || id === "timeline_rows_ordered");
    await tamper("timeline data number", (b) => { const r = b.timeline!.find((x) => x.data && typeof x.data["turnVersion"] === "number")!; r.data!["turnVersion"] = 99; }, (id) => id === "timeline_digest");
    await tamper("timeline count", (b) => { b.timeline!.pop(); }, (id) => id === "timeline_digest");
  });

  it("R-05 回归：v2 任务包（无 bundleVersion / mandates / permits / agentRuns / timelineDigest，timeline 为缓存形状）照旧可验", async () => {
    env = await envWithContext();
    const { taskId, bundle } = await richTask(env);
    const { bundleVersion: _v, mandates: _m, permits: _p, agentRuns: _r, timelineDigest: _d, bundleHash: _h, bundleSignature: _s, ...rest } = bundle;
    void [_v, _m, _p, _r, _d, _h, _s];
    const cache = (await env.db.select().from(verifyTasks).where(eq(verifyTasks.id, taskId)))[0]!.timelineJson as TaskEvidenceBundle["timeline"];
    const v2body = { ...rest, timeline: cache };
    const h = bundleHash(v2body as never);
    const v2 = { ...v2body, bundleHash: h, bundleSignature: await env.signer!.signBundleHash(h) } as unknown as EvidenceBundle;
    const checks = await verifyEvidenceBundle(v2, verifiers);
    expect(failedIds(checks), JSON.stringify(checks.filter((c) => !c.ok))).toEqual([]);
    expect(checks.some((c) => /^(permit_|run_|timeline_)/.test(c.id) || /^mandate_mnd_.*_step_/.test(c.id))).toBe(false);
    const cli = await verifyBundle(v2, { expectedSigner: SIGNER.address });
    expect(cli.ok).toBe(true);
    expect(cli.checks.length).toBe(checks.length);
  });
});
