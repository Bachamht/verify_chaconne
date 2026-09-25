/** v6 Lane B · C3 任务：Y-01～Y-06、K-02/K-03/K-09/K-10、D-088 停止语义、monitor 阻塞快照 */
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, verifyMessage, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTaskBlockers } from "@chaconne/db";
import { eq } from "drizzle-orm";
import { conditionsHash, verifyBundleOffline, verifyTaskBundleExtras, type ConditionSet, type EvidenceRecord, type TaskEvidenceBundle, type TypedDataLike } from "@chaconne/core/verify";
import { fixtureEvent } from "@chaconne/core/verify/context/fixture";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { PLANGUARD_ABI } from "../src/execution/planGuardAbi";
import { mandateStepMatcher, verifyReceiptsOnce, type ChainReceipt, type ReceiptSource } from "../src/execution/receipts";
import { monitorOnce } from "../src/mandates/monitor";
import { api, createTestEnv, TEST_OWNER_KEY, TEST_PLANGUARD, type TestEnv } from "./helpers";
import { confirmRevocationsOnce, type RevokedLogReader } from "../src/tasks/revocations";
import { verifyMandates } from "@chaconne/db";
import { signedContext, testKeypair, type TestKeypair } from "./contextHelpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const AT = "2026-09-18T14:58:00.000Z";
const OWNER = privateKeyToAccount(TEST_OWNER_KEY);
const owner = OWNER.address.toLowerCase();
const STABLE_KEY = FIXTURE_STABLE_KEY;
const STOCK_KEY = FIXTURE_STOCK_KEY;
const TX = ("0x" + "ef".repeat(32)) as Hex;

async function envWithContext(opts: Parameters<typeof createTestEnv>[0] = {}, ctx: Parameters<typeof signedContext>[1] = { at: AT }) {
  const kp = testKeypair();
  const e = await createTestEnv({ ...opts, crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
  const r = await e.crowsnest.ingest(signedContext(kp, ctx), { endpoint: "test", mode: "LIVE" });
  if (!r.ok) throw new Error(`ingest failed ${r.reason}`);
  return { e, kp };
}
function dcaBody(over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return { clientRequestId: `t-${Math.random().toString(16).slice(2, 10)}`, playbookId: "session_dca", mode: "SIMULATION", ownerAddress: owner, params: { steps: 2, perStepAmountRaw: "100000000", inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY, ...params }, ...over };
}
async function authorize(e: TestEnv, taskId: string) {
  const v = await api(e, "GET", `/v1/tasks/${taskId}`);
  const draft = v.json["mandateDraft"] as { typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Hex }; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, string> }; mandate: Record<string, string> };
  const m = draft.mandate;
  const signature = await OWNER.signTypedData({ domain: draft.typedData.domain, types: draft.typedData.types, primaryType: "TradeMandate", message: { ...m, budgetCap: BigInt(m["budgetCap"]!), perStepCap: BigInt(m["perStepCap"]!), maxSteps: Number(m["maxSteps"]), validFrom: BigInt(m["validFrom"]!), deadline: BigInt(m["deadline"]!), nonce: BigInt(m["nonce"]!) } });
  return { signature, r: await api(e, "POST", `/v1/tasks/${taskId}/authorize`, { signature }) };
}
function stepLog(mandateDigest: Hex, stepIndex: number, spent = "100000000") {
  const topics = encodeEventTopics({ abi: PLANGUARD_ABI, eventName: "MandateStep", args: { owner: OWNER.address, mandateDigest, stepIndex } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }], [FIXTURE_STOCK, BigInt(spent), BigInt(spent), 200_000_000_000_000_000n, 0n, ("0x" + "11".repeat(32)) as Hex, "0x9999999999999999999999999999999999999999"]);
  return { address: TEST_PLANGUARD, data, topics };
}
const source = (r: ChainReceipt | null, head: bigint): ReceiptSource => ({ getReceipt: async () => r, headBlock: async () => head });
const receiptOpts = (e: TestEnv) => ({ guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(e.cfgNow()) });
async function confirmStep(e: TestEnv, mandateId: string, stepIndex: number) {
  const m = await api(e, "GET", `/v1/mandates/${mandateId}`);
  await api(e, "POST", `/v1/mandates/${mandateId}/steps/${stepIndex}/submissions`, { txHash: ("0x" + (stepIndex + 1).toString(16).padStart(2, "0").repeat(32)) as Hex });
  await verifyReceiptsOnce(e.mandates, source({ status: "success", blockNumber: 100n, blockHash: "0x" + "ab".repeat(32), gasUsed: 620_000n, logs: [stepLog(m.json["mandateDigest"] as Hex, stepIndex)] }, 200n), receiptOpts(e));
}
const codes = (j: Record<string, unknown>) => ((j["task"] as { blockers: Array<{ code: string }> })?.blockers ?? (j["blockers"] as Array<{ code: string }>)).map((b) => b.code);

describe("Y-01 参数校验 / Y-02 全部可 SIMULATION", () => {
  it("Y-01 缺 steps / 未知参数 / 范围外 / 资产角色错 → 400 带字段；portfolio_rebalance → 501（Lane C）；mode 非法 → 400", async () => {
    env = (await envWithContext()).e;
    const missing = await api(env, "POST", "/v1/tasks", dcaBody({}, { steps: undefined }));
    expect(missing.status).toBe(400);
    expect(missing.json["error"]).toBe("invalid_playbook_params");
    expect((missing.json["details"] as Array<{ field: string }>).some((d) => d.field === "steps")).toBe(true);
    const unknown = await api(env, "POST", "/v1/tasks", dcaBody({}, { leverage: 3 }));
    expect((unknown.json["details"] as Array<{ field: string; code: string }>)[0]).toEqual({ field: "leverage", code: "unknown_param" });
    expect((await api(env, "POST", "/v1/tasks", dcaBody({}, { steps: 999 }))).status).toBe(400);
    const wrongRole = await api(env, "POST", "/v1/tasks", dcaBody({}, { inputAssetKey: STOCK_KEY, outputAssetKey: STABLE_KEY }));
    expect(wrongRole.status).toBe(400);
    expect(wrongRole.json["error"]).toBe("asset_unsupported");
    expect((await api(env, "POST", "/v1/tasks", { ...dcaBody(), playbookId: "portfolio_rebalance", params: {} })).status).toBe(501);
    expect((await api(env, "POST", "/v1/tasks", dcaBody({ mode: "PAPER" }))).status).toBe(400);
    const sell = await api(env, "POST", "/v1/tasks", { ...dcaBody(), playbookId: "target_sell", params: { amountRaw: "400000000000000000", inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY } });
    expect(sell.status).toBe(400);
    expect((sell.json["details"] as Array<{ code: string }>)[0]!.code).toBe("require_one_of");
    const catalog = await api(env, "GET", "/v1/playbooks");
    expect((catalog.json["playbooks"] as Array<{ id: string }>).map((p) => p.id)).toEqual(["session_dca", "event_aware_accumulate", "discount_watch", "target_sell", "portfolio_rebalance", "agent_goal"]); // agent_goal 内置（CV-D16 批次 6）
    expect(JSON.stringify(catalog.json)).not.toMatch(/not_in_fed_blackout/); // K-07：模板默认不含
  });

  it("Y-02 四个模板 SIMULATION 建任务 → 201、ACTIVE/WAITING、条件求值与阻塞项全量、无授权草案；理由卡随任务生成；同 clientRequestId 重放 200", async () => {
    env = (await envWithContext()).e;
    const bodies = [
      dcaBody({ clientRequestId: "sim-dca" }),
      { ...dcaBody({ clientRequestId: "sim-event" }), playbookId: "event_aware_accumulate" },
      { ...dcaBody({ clientRequestId: "sim-disc" }), playbookId: "discount_watch", params: { amountRaw: "50000000", maxPremiumBps: 100, inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY } },
      { ...dcaBody({ clientRequestId: "sim-sell" }), playbookId: "target_sell", params: { amountRaw: "400000000000000000", targetPriceUsd: "240", inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY } },
    ];
    for (const b of bodies) {
      const r = await api(env, "POST", "/v1/tasks", b);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const task = r.json["task"] as { status: string; blockers: unknown[]; conditions: ConditionSet; thesisId: string };
      expect(["ACTIVE", "WAITING"]).toContain(task.status);
      expect(Array.isArray(task.blockers)).toBe(true);
      expect(task.conditions.hash).toBe(conditionsHash(task.conditions.items));
      expect(task.conditions.items.some((i) => i.type === "thesis_holds")).toBe(true);
      expect(r.json["mandateDraft"]).toBeNull();
      expect(r.json["evidenceMode"]).toBe("SIMULATION");
      expect((r.json["thesis"] as { premises: unknown[] }).premises.length).toBeGreaterThan(0);
      const replay = await api(env, "POST", "/v1/tasks", b);
      expect(replay.status).toBe(200);
    }
    const list = await api(env, "GET", `/v1/tasks?owner=${owner}`);
    expect((list.json["tasks"] as unknown[]).length).toBe(4);
  });
});

describe("Y-03 Session DCA 跨交易日推进、错过不合并（LIVE：授权 → prepare-step → 回执 → 下一交易日）", () => {
  it("Y-03 / K-03 / K-10：条件通过才签发；同日第二步 STEP_GAP_NOT_ELAPSED 且 nextCheckAt=下一交易日开盘；每步金额 = perStep；证书 effectivePolicyHash 展开 scopeHash（CV-D16），证据包可复算", async () => {
    env = (await envWithContext()).e;
    const created = await api(env, "POST", "/v1/tasks", dcaBody({ mode: "LIVE" }));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const task = created.json["task"] as { id: string; status: string; conditions: ConditionSet };
    expect(task.status).toBe("AWAITING_AUTHORIZATION");
    const draft = created.json["mandateDraft"] as { mandate: { perStepCap: string; budgetCap: string; maxSteps: string; effectivePolicyHash: string }; conditionsHash: string; scopeHash: string };
    expect(draft.mandate.perStepCap).toBe("100000000");
    expect(draft.mandate.budgetCap).toBe("200000000");
    expect(draft.mandate.maxSteps).toBe("2");
    // CV-D16：签名绑定的是 scopeHash（范围），不是计划条件的 conditionsHash
    const task2 = created.json["task"] as { scope: { outputAssetKeys: string[]; budgetCapRaw: string; issuance: string }; scopeHash: string };
    expect(task2.scope).toMatchObject({ outputAssetKeys: [STOCK_KEY], budgetCapRaw: "200000000", perStepCapRaw: "100000000", maxSteps: 2, allowSell: false, trustTier: "platform_only", issuance: "auto", hardConditions: [] });
    expect(draft.scopeHash).toBe(task2.scopeHash);
    expect(draft.conditionsHash).toBe(task2.scopeHash);
    expect(created.json["bindingHash"]).toBe(task2.scopeHash);
    // 未授权就 prepare → 409
    expect((await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {})).status).toBe(409);
    const { r: auth } = await authorize(env, task.id);
    expect(auth.status, JSON.stringify(auth.json)).toBe(201);
    expect((auth.json["task"] as { status: string }).status).toBe("ACTIVE");
    const mandateId = ((auth.json["mandates"] as Array<{ mandateId: string; conditionsHash: string }>)[0]!).mandateId;
    expect((auth.json["mandates"] as Array<{ conditionsHash: string; current: boolean }>)[0]).toMatchObject({ conditionsHash: task2.scopeHash, current: true });

    const p = await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {});
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json["status"]).toBe("READY");
    expect((p.json["step"] as { amountIn: string }).amountIn).toBe("100000000");
    expect((p.json["certificate"] as { effectivePolicyHash: string }).effectivePolicyHash.toLowerCase()).toBe(draft.mandate.effectivePolicyHash.toLowerCase());
    expect((p.json["conditionEvaluation"] as { outcome: string }).outcome).toBe("SATISFIED");
    expect((await api(env, "GET", `/v1/tasks/${task.id}`)).json["task"]).toMatchObject({ status: "STEP_PREPARED" });

    // 回执确认 → PARTIAL，同日再 prepare → STEP_GAP_NOT_ELAPSED
    await confirmStep(env, mandateId, 0);
    const afterConfirm = await api(env, "GET", `/v1/tasks/${task.id}`);
    expect((afterConfirm.json["task"] as { status: string }).status).toBe("PARTIAL");
    expect((afterConfirm.json["steps"] as { confirmed: number }).confirmed).toBe(1);
    env.setNow("2026-09-18T18:00:00.000Z"); // 同日 14:00 ET
    const sameDay = await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {});
    expect(sameDay.status).toBe(409);
    expect(codes(sameDay.json)).toContain("STEP_GAP_NOT_ELAPSED");
    expect(sameDay.json["nextCheckAt"]).toBe("2026-09-21T13:30:00.000Z");
    // 周一常规时段 → 第二步；金额仍是 perStep（错过的窗口不合并）
    env.setNow("2026-09-21T15:00:00.000Z");
    const mon = await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {});
    expect(mon.status, JSON.stringify(mon.json)).toBe(200);
    expect(mon.json["stepIndex"]).toBe(1);
    expect((mon.json["step"] as { amountIn: string }).amountIn).toBe("100000000");

    // K-10 证据包：conditionsHash 在 params 里、证书绑定、求值可重放；篡改条件 → 复算失败
    const b = await api(env, "GET", `/v1/tasks/${task.id}/bundle`);
    expect(b.status, JSON.stringify(b.json).slice(0, 300)).toBe(200);
    const bundle = b.json as unknown as TaskEvidenceBundle;
    expect((bundle.effectivePolicy.params as { conditionsHash?: string }).conditionsHash).toBe(task2.scopeHash);
    expect(bundle.thesis?.taskId).toBe(task.id);
    expect(bundle.certificates.length).toBeGreaterThan(0);
    const checks = await verifyBundleOffline(bundle, {
      verifyTypedData: (a) => verifyTypedData({ address: a.address, domain: a.typedData.domain, types: a.typedData.types, primaryType: a.typedData.primaryType, message: a.typedData.message, signature: a.signature }),
      verifyMessage: (a) => verifyMessage({ address: a.address, message: { raw: a.raw }, signature: a.signature }),
    });
    const failed = checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const extras = verifyTaskBundleExtras(bundle);
    expect(extras.filter((c) => !c.ok), JSON.stringify(extras)).toEqual([]);
    expect(extras.some((c) => c.id.startsWith("condition_eval_") && c.ok)).toBe(true);
    const tampered = structuredClone(bundle);
    (tampered.conditions.items[1] as { days: number }).days = 0;
    expect(verifyTaskBundleExtras(tampered).find((c) => c.id === "conditions_hash")!.ok).toBe(false);
    const tamperedScope = structuredClone(bundle);
    (tamperedScope.task.scope as { budgetCapRaw: string }).budgetCapRaw = "999999999999";
    expect(verifyTaskBundleExtras(tamperedScope).find((c) => c.id === "scope_hash")!.ok).toBe(false);
    const cert = bundle.certificates[0]!.typedData as TypedDataLike;
    expect((cert.message as { effectivePolicyHash: string }).effectivePolicyHash).toBe(bundle.effectivePolicy.effectivePolicyHash);
    void (bundle.evidence as EvidenceRecord[]);
  });
});

describe("Y-04 / K-02 事件前等待、事件后重估；阻塞项全量", () => {
  it("Y-04 event_aware_accumulate：一级事件窗口内 → WAITING(EVENT_WINDOW_ACTIVE) 且 nextCheckAt=窗口结束；财报覆盖未知同时列出（K-02 全量）；事件过后 + 财报覆盖 → 放行（SIMULATION READY）", async () => {
    const events = [fixtureEvent({ kind: "MACRO_TIER1", name: "PCE", dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T15:10:00.000Z" })];
    const { e, kp } = await envWithContext({}, { at: AT, events });
    env = e;
    const r = await api(env, "POST", "/v1/tasks", { ...dcaBody(), playbookId: "event_aware_accumulate" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const task = r.json["task"] as { id: string; status: string; nextCheckAt: string | null };
    expect(task.status).toBe("WAITING");
    expect(codes(r.json)).toEqual(expect.arrayContaining(["EVENT_WINDOW_ACTIVE", "EARNINGS_COVERAGE_UNKNOWN"]));
    expect(task.nextCheckAt).toBe("2026-09-18T15:30:00.000Z");
    const p = await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {});
    expect(p.status).toBe(409);
    expect(p.json["status"]).toBe("WAIT");
    // 事件过后：新快照（含远期财报 → 覆盖已知）
    env.setNow("2026-09-18T15:35:00.000Z");
    const later = [...events, fixtureEvent({ kind: "EARNINGS", name: "FAKE Q3", dateLocal: "2026-10-29", underlyingIds: ["us-equity:FAKE"], sessionHint: "amc" })];
    await env.crowsnest.ingest(signedContext(kp, { at: "2026-09-18T15:34:00.000Z", events: later }), { endpoint: "test", mode: "LIVE" });
    const p2 = await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {});
    expect(p2.status, JSON.stringify(p2.json)).toBe(200);
    expect(p2.json["mode"]).toBe("SIMULATION");
    expect(p2.json["certificate"]).toBeNull();
    const blockersRows = await env.db.select().from(verifyTaskBlockers).where(eq(verifyTaskBlockers.taskId, task.id));
    expect(blockersRows.length).toBe(2); // 阻塞集合变化两次：创建时阻塞、放行后空集
  });
});

describe("Y-05 / Y-06", () => {
  it("Y-05 discount_watch：LIVE + official_close 口径 → 400；SIMULATION 允许；LIVE + live 口径可建", async () => {
    env = (await envWithContext()).e;
    const body = (mode: string, referenceKind: string) => ({ ...dcaBody({ mode }), playbookId: "discount_watch", params: { amountRaw: "50000000", maxPremiumBps: 100, referenceKind, inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY } });
    const bad = await api(env, "POST", "/v1/tasks", body("LIVE", "official_close"));
    expect(bad.status).toBe(400);
    expect(bad.json["error"]).toBe("invalid_conditions");
    expect(JSON.stringify(bad.json["details"])).toMatch(/close_reference_not_allowed_for_live_execution/);
    expect((await api(env, "POST", "/v1/tasks", body("SIMULATION", "official_close"))).status).toBe(201);
    const live = await api(env, "POST", "/v1/tasks", body("LIVE", "live"));
    expect(live.status, JSON.stringify(live.json)).toBe(201);
  });
  it("Y-06 target_sell：只给成本止盈 → TRACKED_COST_UNKNOWN（userActionRequired）；只给目标价 → 目标价条件独立判定（240 ≤ 参考 250 → 满足）", async () => {
    // 卖出方向：fixture 证据把参考价挂在输出侧，这里对齐到股票侧（sell 的 stockEntry = 输入侧）
    const decorator = (c: import("../src/evidence/provider").CollectedEvidence) => {
      for (const ev of c.evidence) {
        const p = ev.payload;
        if (p.kind === "pyth_reference" || p.kind === "ref_close") p.underlyingId = "us-equity:FAKE";
        if (p.kind === "okx_rwa_token" || p.kind === "token_meta") p.tokenAddress = FIXTURE_STOCK;
        if (p.kind === "okx_quote") p.expectedOutRaw = "100000000"; // 0.4 股 → 100 USD = 250/股
      }
      return c;
    };
    env = (await envWithContext({ evidenceDecorator: decorator })).e;
    const cost = await api(env, "POST", "/v1/tasks", { ...dcaBody(), playbookId: "target_sell", params: { amountRaw: "400000000000000000", trackedCostPnlPctGte: 10, policyId: "STRICT_LIVE", inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY } });
    expect(cost.status, JSON.stringify(cost.json)).toBe(201);
    const p = await api(env, "POST", `/v1/tasks/${(cost.json["task"] as { id: string }).id}/prepare-step`, {});
    expect(p.status).toBe(409);
    const blocker = (p.json["blockers"] as Array<{ code: string; userActionRequired: boolean; text: string }>).find((b) => b.code === "TRACKED_COST_UNKNOWN")!;
    expect(blocker.userActionRequired).toBe(true);
    expect(blocker.text).toMatch(/target price/);
    const target = await api(env, "POST", "/v1/tasks", { ...dcaBody(), playbookId: "target_sell", params: { amountRaw: "400000000000000000", targetPriceUsd: "240", policyId: "STRICT_LIVE", inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY } });
    expect(target.status, JSON.stringify(target.json)).toBe(201);
    const p2 = await api(env, "POST", `/v1/tasks/${(target.json["task"] as { id: string }).id}/prepare-step`, {});
    const perItem = (p2.json["evaluation"] as { perItem: Array<{ item: { type: string }; outcome: string }> }).perItem;
    expect(perItem.find((x) => x.item.type === "target_price_gte")!.outcome).toBe("SATISFIED");
    expect(codes(p2.json)).not.toContain("TARGET_NOT_REACHED");
    const far = await api(env, "POST", "/v1/tasks", { ...dcaBody(), playbookId: "target_sell", params: { amountRaw: "400000000000000000", policyId: "STRICT_LIVE", targetPriceUsd: "300", inputAssetKey: STABLE_KEY, outputAssetKey: STOCK_KEY } });
    const p3 = await api(env, "POST", `/v1/tasks/${(far.json["task"] as { id: string }).id}/prepare-step`, {});
    expect(p3.status).toBe(409);
    expect(codes(p3.json)).toContain("TARGET_NOT_REACHED");
  });
});

describe("CV-D16 改计划条件不重签、范围锁定；D-088 停止语义；K-03 上下文不可达", () => {
  it("CV-D16 改计划条件 → 授权不变（current 仍 true、状态不回 AWAITING_AUTHORIZATION）、新 conditionsHash；触碰硬约束 → 409 scope_locked；旧范围签名再授权 → 422 scope_hash_mismatch", async () => {
    env = (await envWithContext()).e;
    const created = await api(env, "POST", "/v1/tasks", dcaBody({ mode: "LIVE", scope: { objective: "每个交易日买一点，别在开盘前后", hardConditions: [{ type: "session", allow: ["US_REGULAR"] }] } }));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const task = created.json["task"] as { id: string; conditions: ConditionSet; scope: { hardConditions: unknown[] }; scopeHash: string };
    expect(task.scope.hardConditions).toEqual([{ type: "session", allow: ["US_REGULAR"] }]);
    const { signature } = await authorize(env, task.id);
    const p = await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {});
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    // 计划条件（间隔）可改：不需要新授权
    const changed = await api(env, "POST", `/v1/tasks/${task.id}/conditions`, { items: [{ type: "min_gap_trading_days", days: 2 }] });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    const t2 = changed.json["task"] as { status: string; conditions: ConditionSet; scopeHash: string };
    expect(t2.status).not.toBe("AWAITING_AUTHORIZATION");
    expect(t2.conditions.hash).not.toBe(task.conditions.hash);
    expect(t2.scopeHash).toBe(task.scopeHash);
    expect(t2.conditions.items.find((c) => c.type === "min_gap_trading_days")).toMatchObject({ days: 2 });
    expect(t2.conditions.items.find((c) => c.type === "session")).toMatchObject({ allow: ["US_REGULAR"] });
    const same = (changed.json["mandates"] as Array<{ state: string; current: boolean; pulledUnexpiredSteps: number[] }>)[0]!;
    expect(same).toMatchObject({ state: "ACTIVE", current: true, pulledUnexpiredSteps: [0] });
    expect((changed.json["timeline"] as Array<{ type: string; note?: string }>).some((e) => e.type === "conditions_changed" && /authorization unchanged/.test(e.note ?? ""))).toBe(true);
    // 硬约束（session）不能被计划条件覆盖
    const locked = await api(env, "POST", `/v1/tasks/${task.id}/conditions`, { items: [{ type: "session", allow: ["US_REGULAR", "US_PRE", "US_POST"] }] });
    expect(locked.status).toBe(409);
    expect(locked.json["error"]).toBe("scope_locked");
    // 篡改过的 mandate（别的 effectivePolicyHash）+ 原签名 → 422 scope_hash_mismatch
    const oldMandate = (created.json["mandateDraft"] as { mandate: Record<string, string> }).mandate;
    const forged = await api(env, "POST", `/v1/tasks/${task.id}/authorize`, { signature, mandate: { ...oldMandate, effectivePolicyHash: "0x" + "ab".repeat(32) } });
    expect(forged.status).toBe(422);
    expect(JSON.stringify(forged.json["details"])).toMatch(/scope_hash_mismatch/);
  });
  it("CV-D16 范围：资产集合包住计划、总额/每笔/步数/期限 ≥ 计划；输出集 = 范围全部资产；issuance=agent 时 monitor 与 prepare-step 都不按计划签发；范围校验失败 → 400 invalid_scope", async () => {
    env = (await envWithContext()).e;
    const bad = await api(env, "POST", "/v1/tasks", dcaBody({ mode: "LIVE", scope: { budgetCapRaw: "100", perStepCapRaw: "50", trustTier: "nope" } }));
    expect(bad.status).toBe(400);
    expect(bad.json["error"]).toBe("invalid_scope");
    const badPlan = await api(env, "POST", "/v1/tasks", dcaBody({ mode: "LIVE", scope: { budgetCapRaw: "150000000" } }));
    expect(badPlan.status).toBe(400);
    expect(JSON.stringify(badPlan.json["details"])).toMatch(/must_be_gte_plan_total/);
    const created = await api(env, "POST", "/v1/tasks", dcaBody({ mode: "LIVE", scope: { objective: "分批建仓，最多 5 笔", budgetCapRaw: "500000000", perStepCapRaw: "100000000", maxSteps: 5, trustTier: "agent_data", issuance: "agent" } }));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const task = created.json["task"] as { id: string; scope: Record<string, unknown> };
    expect(task.scope).toMatchObject({ budgetCapRaw: "500000000", maxSteps: 5, trustTier: "agent_data", issuance: "agent" });
    const draft = created.json["mandateDraft"] as { mandate: { budgetCap: string; maxSteps: string }; outputSet: string[] };
    expect(draft.mandate).toMatchObject({ budgetCap: "500000000", maxSteps: "5" });
    expect(draft.outputSet).toEqual([FIXTURE_STOCK.toLowerCase()]);
    expect(String(created.json["scopeBoundary"])).toMatch(/does not constrain/);
    const { r: auth } = await authorize(env, task.id);
    expect(auth.status, JSON.stringify(auth.json)).toBe(201);
    const p = await api(env, "POST", `/v1/tasks/${task.id}/prepare-step`, {});
    expect(p.status).toBe(409);
    expect(p.json["error"]).toBe("issuance_by_agent");
    await monitorOnce(env.mandates, env.tasks);
    const after = await api(env, "GET", `/v1/tasks/${task.id}`);
    expect((after.json["task"] as { status: string }).status).not.toBe("STEP_PREPARED");
    expect(((after.json["lastEvaluation"] as { mandate: { status: string; preparedStepIndex: number | null } }).mandate)).toMatchObject({ preparedStepIndex: null });
  });
  it("D-088 pause/resume/cancel：响应体写明只阻止后续签发、已取走证书仍可能可执行、彻底停止以链上撤销为准；PAUSED 仍评估不签发；cancel 有授权 → REVOKE_PENDING", async () => {
    env = (await envWithContext()).e;
    const created = await api(env, "POST", "/v1/tasks", dcaBody({ mode: "LIVE" }));
    const id = (created.json["task"] as { id: string }).id;
    await authorize(env, id);
    const paused = await api(env, "POST", `/v1/tasks/${id}/pause`, {});
    expect(paused.status).toBe(200);
    expect((paused.json["task"] as { status: string }).status).toBe("PAUSED");
    expect(String(paused.json["note"])).toMatch(/only prevents issuing further step certificates/);
    expect(String(paused.json["note"])).toMatch(/revokeMandate/);
    const p = await api(env, "POST", `/v1/tasks/${id}/prepare-step`, {});
    expect(p.status).toBe(409);
    expect(p.json["taskStatus"]).toBe("PAUSED");
    const m = await monitorOnce(env.mandates, env.tasks);
    expect(m.tasks?.checked).toBe(1);
    expect(m.tasks?.issued).toBe(0);
    const resumed = await api(env, "POST", `/v1/tasks/${id}/resume`, {});
    expect(["ACTIVE", "WAITING"]).toContain((resumed.json["task"] as { status: string }).status);
    const cancelled = await api(env, "POST", `/v1/tasks/${id}/cancel`, {});
    expect((cancelled.json["task"] as { status: string }).status).toBe("REVOKE_PENDING");
    expect(String(cancelled.json["stopSemantics"])).toMatch(/REVOKE_PENDING/);
    expect((await api(env, "POST", `/v1/tasks/${id}/cancel`, {})).status).toBe(409);
    const revoked = await env.tasks.confirmRevoked(id, TX);
    expect(revoked?.status).toBe("REVOKED");
  });
  it("D-088 撤销确认（Lane I）：REVOKE_PENDING 只在链上出现 MandateRevoked 日志后才变 REVOKED，授权 state 同步 REVOKED；无日志则保持 pending", async () => {
    env = await createTestEnv();
    const created = await api(env, "POST", "/v1/tasks", dcaBody({ mode: "LIVE" }));
    const id = (created.json["task"] as { id: string }).id;
    const { r: auth } = await authorize(env, id);
    const mandateId = String(auth.json["mandateId"]);
    const cancelled = await api(env, "POST", `/v1/tasks/${id}/cancel`, {});
    expect((cancelled.json["task"] as { status: string }).status).toBe("REVOKE_PENDING");
    const digest = (await env.db.select({ d: verifyMandates.mandateDigest }).from(verifyMandates).where(eq(verifyMandates.id, mandateId)))[0]!.d.toLowerCase() as `0x${string}`;
    // ① 链上还没有撤销日志 → 什么都不改（按钮响应不算撤销完成）
    const none: RevokedLogReader = { revoked: async () => new Map() };
    expect(await confirmRevocationsOnce(env.tasks, env.db, none)).toEqual({ pending: 1, confirmed: 0 });
    expect(((await api(env, "GET", `/v1/tasks/${id}`)).json["task"] as { status: string }).status).toBe("REVOKE_PENDING");
    // ② 链上出现了该 digest 的 MandateRevoked → 任务 REVOKED、授权 state REVOKED、时间线带 txHash
    const tx = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const some: RevokedLogReader = { revoked: async (ds) => new Map(ds.filter((d) => d === digest).map((d) => [d, tx] as const)) };
    expect(await confirmRevocationsOnce(env.tasks, env.db, some)).toEqual({ pending: 1, confirmed: 1 });
    const after = (await api(env, "GET", `/v1/tasks/${id}`)).json["task"] as { status: string; revokeStatus?: string };
    expect(after.status).toBe("REVOKED");
    expect((await env.db.select({ s: verifyMandates.state }).from(verifyMandates).where(eq(verifyMandates.id, mandateId)))[0]!.s).toBe("REVOKED");
    // ③ 再跑一次 → 已无 pending，幂等
    expect(await confirmRevocationsOnce(env.tasks, env.db, some)).toEqual({ pending: 0, confirmed: 0 });
  });

  it("K-03 上下文不可达：依赖上下文的条件 CONTEXT_UNAVAILABLE → WAITING；不依赖的 session 仍 SATISFIED；owner 鉴权：其它调用方 403", async () => {
    env = await createTestEnv();
    // session 自 2026-09-25 起不再默认生成（24 小时交易），显式要求常规时段才加
    const r = await api(env, "POST", "/v1/tasks", { ...dcaBody({}, { regularSessionOnly: true }), playbookId: "event_aware_accumulate" });
    expect(r.status).toBe(201);
    expect((r.json["task"] as { status: string }).status).toBe("WAITING");
    expect(codes(r.json)).toContain("CONTEXT_UNAVAILABLE");
    const perItem = (r.json["lastEvaluation"] as { perItem: Array<{ item: { type: string }; outcome: string }> }).perItem;
    expect(perItem.find((x) => x.item.type === "session")!.outcome).toBe("SATISFIED");
    const id = (r.json["task"] as { id: string }).id;
    const { OTHER_API_KEY } = await import("./helpers");
    expect((await api(env, "GET", `/v1/tasks/${id}`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
    expect((await api(env, "POST", `/v1/tasks/${id}/pause`, {}, {}, OTHER_API_KEY)).status).toBe(403);
  });
});

void ((): TestKeypair | null => null);

describe("宏观事件修订传播（crowsnest 摄入 → Lane D 传播，2026-09-23 补接）", () => {
  it("事件改期 → 受影响任务 nextCheckAt / 阻塞重算 + event.revised 入 outbox；同一 revision 再摄入不重复；created 不传播", async () => {
    const kp = testKeypair();
    env = await createTestEnv({ now: "2026-09-18T15:00:00.000Z", crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}`, wire: "production" });
    const { verifyNotificationOutbox } = await import("@chaconne/db");
    const v0 = fixtureEvent({ id: "crowsnest.fred:MACRO_TIER1:2026-09-18:cpi", kind: "MACRO_TIER1", name: "CPI", dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T16:00:00.000Z", firstKnownAt: "2026-09-10T01:05:00.000Z" });
    await env.crowsnest.ingest(signedContext(kp, { at: "2026-09-18T14:59:00.000Z", events: [v0] }), { endpoint: "test", mode: "LIVE" });
    // 建一个避开 MACRO_TIER1 窗口的任务（SIMULATION，立即 ACTIVE/WAITING）
    const create = await api(env, "POST", "/v1/tasks", dcaBody({ conditions: { version: "conditions/1", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }] } }));
    expect(create.status).toBe(201);
    const taskId = (create.json["task"] as { id: string }).id;
    const e = env;
    const eventKeys = async () => (await e.db.select().from(verifyNotificationOutbox)).map((x) => x.idempotencyKey).filter((k) => k.startsWith("event."));
    expect(await eventKeys()).toEqual([]); // created 不传播（任务自身的 task.* 通知不算）
    // 改期到 15:20（当前 15:00 → 落入 30 分钟前窗）→ revision 1
    const v1 = { ...v0, revision: 1, scheduledAtUtc: "2026-09-18T15:20:00.000Z", status: "revised" as const, revisedFrom: { dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T16:00:00.000Z" } };
    const r = await env.crowsnest.ingest(signedContext(kp, { at: "2026-09-18T15:00:30.000Z", events: [v1] }), { endpoint: "test", mode: "LIVE" });
    expect(r.ok && r.events.revised).toEqual([v0.id]);
    expect(await eventKeys()).toEqual([`event.revised:${v0.id}:1`]);
    const t = await api(env, "GET", `/v1/tasks/${taskId}`);
    const task = t.json["task"] as { blockers: Array<{ code: string }>; nextCheckAt: string | null };
    expect(task.blockers.map((b) => b.code)).toContain("EVENT_WINDOW_ACTIVE");
    // 同一 revision 再来 → unchanged，不再入队
    await env.crowsnest.ingest(signedContext(kp, { at: "2026-09-18T15:01:00.000Z", events: [v1] }), { endpoint: "test", mode: "LIVE" });
    expect(await eventKeys()).toEqual([`event.revised:${v0.id}:1`]);
  });
});

