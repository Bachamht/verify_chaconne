/** CV-D16 批次 2：agent 交易意图 + 决策记录 → 四道核验 → 步骤证书 */
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, TEST_OWNER_KEY, type TestEnv } from "./helpers";
import { monitorOnce } from "../src/mandates/monitor";
import { signedContext, testKeypair, type TestKeypair } from "./contextHelpers";
import { fixtureEvent } from "@chaconne/core/verify/context/fixture";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const AT = "2026-09-18T14:58:00.000Z";
const OWNER = privateKeyToAccount(TEST_OWNER_KEY);
const owner = OWNER.address.toLowerCase();

let kpCur: TestKeypair | null = null;
async function envWithContext() {
  const kp = testKeypair();
  kpCur = kp;
  const e = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
  const r = await e.crowsnest.ingest(signedContext(kp, { at: AT }), { endpoint: "test", mode: "LIVE" });
  if (!r.ok) throw new Error(`ingest failed ${r.reason}`);
  return e;
}
function body(over: Record<string, unknown> = {}) {
  return { clientRequestId: `t-${Math.random().toString(16).slice(2, 10)}`, playbookId: "session_dca", mode: "LIVE", ownerAddress: owner, params: { steps: 2, perStepAmountRaw: "100000000", inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKey: FIXTURE_STOCK_KEY }, scope: { objective: "分批建仓；agent 自己挑时机", budgetCapRaw: "500000000", perStepCapRaw: "100000000", maxSteps: 5, trustTier: "agent_data", issuance: "agent", hardConditions: [{ type: "session", allow: ["US_REGULAR"] }] }, ...over };
}
async function authorize(e: TestEnv, taskId: string) {
  const v = await api(e, "GET", `/v1/tasks/${taskId}`);
  const draft = v.json["mandateDraft"] as { typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Hex }; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, string> }; mandate: Record<string, string> };
  const m = draft.mandate;
  const signature = await OWNER.signTypedData({ domain: draft.typedData.domain, types: draft.typedData.types, primaryType: "TradeMandate", message: { ...m, budgetCap: BigInt(m["budgetCap"]!), perStepCap: BigInt(m["perStepCap"]!), maxSteps: Number(m["maxSteps"]), validFrom: BigInt(m["validFrom"]!), deadline: BigInt(m["deadline"]!), nonce: BigInt(m["nonce"]!) } });
  return api(e, "POST", `/v1/tasks/${taskId}/authorize`, { signature });
}
const decision = (claims: unknown[] = [{ kind: "agent_data", text: "另一家行情显示溢价 0.2%", source: { name: "other-feed" } }]) => ({ rationale: "常规时段、溢价低、预算有余，先买一小笔", claims, alternatives: ["等收盘后再看"] });
const intent = (over: Record<string, unknown> = {}) => ({ clientRequestId: `i-${Math.random().toString(16).slice(2, 10)}`, kind: "buy", outputAssetKey: FIXTURE_STOCK_KEY, amountInRaw: "50000000", decision: decision(), ...over });
const checkOf = (j: Record<string, unknown>, id: string) => ((j["intent"] as { checks: Array<{ id: string; ok: boolean; reasons: Array<{ code: string }> }> }).checks.find((c) => c.id === id))!;

describe("POST /v1/tasks/:id/intents", () => {
  it("LIVE：意图在范围内 + 依据可采信 → 四道全过、签证书交出 guardCall、任务 STEP_PREPARED；幂等；列表 / 单条；撤回作废证书", async () => {
    env = await envWithContext();
    const created = await api(env, "POST", "/v1/tasks", body());
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const taskId = (created.json["task"] as { id: string }).id;
    // 未授权 → 409
    expect((await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent())).status).toBe(409);
    const auth = await authorize(env, taskId);
    expect(auth.status, JSON.stringify(auth.json)).toBe(201);
    const mandateHash = String((created.json["mandateDraft"] as { effectivePolicyHash: string }).effectivePolicyHash).toLowerCase();
    // issuance=agent：prepare-step 不按计划签发
    expect((await api(env, "POST", `/v1/tasks/${taskId}/prepare-step`, {})).json["error"]).toBe("issuance_by_agent");
    const req = intent();
    const r = await api(env, "POST", `/v1/tasks/${taskId}/intents`, req);
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(201);
    const it1 = r.json["intent"] as { id: string; status: string; step: { stepIndex: number } | null; triage: Array<{ label: string }>; planDeviations: unknown[] };
    expect(it1.status).toBe("certified");
    expect(it1.step).toMatchObject({ stepIndex: 0 });
    expect(it1.triage).toEqual([{ index: 0, kind: "agent_data", admissible: true, verified: false, label: "agent_provided_unverified" }]);
    for (const id of ["facts", "scope", "execution", "binding"]) expect(checkOf(r.json, id).ok, id).toBe(true);
    expect(r.json["status"]).toBe("READY");
    expect((r.json["step"] as { amountIn: string }).amountIn).toBe("50000000");
    expect(String((r.json["certificate"] as { effectivePolicyHash: string }).effectivePolicyHash).toLowerCase()).toBe(mandateHash);
    expect((r.json["guardCall"] as { functionName: string }).functionName).toBe("executeStep");
    expect(r.json["taskStatus"]).toBe("STEP_PREPARED");
    expect(String(r.json["scopeBoundary"])).toMatch(/does not constrain/);
    // 通知入 outbox（version 是 int4，不是 id 的十六进制）
    expect((await env.notify.outbox(taskId)).some((n) => n.type === "task.intent_certified" && Number.isInteger(n.version) && n.version < 2 ** 31)).toBe(true);
    // 幂等：同 clientRequestId → 200 同一意图
    const again = await api(env, "POST", `/v1/tasks/${taskId}/intents`, req);
    expect(again.status).toBe(200);
    expect((again.json["intent"] as { id: string }).id).toBe(it1.id);
    // 列表 / 单条 / 时间线
    const list = await api(env, "GET", `/v1/tasks/${taskId}/intents`);
    expect((list.json["intents"] as unknown[]).length).toBe(1);
    expect(((await api(env, "GET", `/v1/tasks/${taskId}/intents/${it1.id}`)).json as { id: string }).id).toBe(it1.id);
    const view = await api(env, "GET", `/v1/tasks/${taskId}`);
    expect((view.json["timeline"] as Array<{ type: string }>).some((e) => e.type === "intent_certified")).toBe(true);
    // 撤回 → 证书作废、任务离开 STEP_PREPARED
    const w = await api(env, "POST", `/v1/tasks/${taskId}/intents/${it1.id}/withdraw`, {});
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    expect(w.json["stepVoided"]).toBe(true);
    expect((w.json["intent"] as { status: string }).status).toBe("withdrawn");
    expect(w.json["taskStatus"]).not.toBe("STEP_PREPARED");
    expect((await api(env, "POST", `/v1/tasks/${taskId}/intents/${it1.id}/withdraw`, {})).status).toBe(409);
  });

  it("拒绝：依据不可采信（platform_only 下引用研究结论）→ facts 不过且不取报价；资产不在范围 / 金额超每笔上限 / 卖出未允许 → scope 不过；决策记录照样保存", async () => {
    env = await envWithContext();
    const created = await api(env, "POST", "/v1/tasks", body({ scope: { budgetCapRaw: "500000000", perStepCapRaw: "100000000", maxSteps: 5 } }));
    const taskId = (created.json["task"] as { id: string }).id;
    expect((created.json["task"] as { scope: { trustTier: string; issuance: string } }).scope).toMatchObject({ trustTier: "platform_only", issuance: "auto" });
    expect((await authorize(env, taskId)).status).toBe(201);
    const research = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent({ decision: decision([{ kind: "agent_research", text: "我认为会涨" }]) }));
    expect(research.status).toBe(422);
    expect((research.json["intent"] as { status: string }).status).toBe("rejected");
    expect(checkOf(research.json, "facts")).toMatchObject({ ok: false });
    expect(checkOf(research.json, "facts").reasons.map((x) => x.code)).toEqual(["DECISION_BASIS_NOT_ADMISSIBLE"]);
    expect(checkOf(research.json, "execution").ok).toBe(false);
    expect(research.json["certificate"]).toBeUndefined();
    expect(((research.json["intent"] as { decision: { rationale: string } }).decision.rationale)).toMatch(/常规时段/);
    const bigAmount = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent({ amountInRaw: "100000001", decision: decision([]) }));
    expect(bigAmount.status).toBe(422);
    expect(checkOf(bigAmount.json, "scope").reasons.map((x) => x.code)).toContain("INTENT_OUT_OF_SCOPE");
    const wrongAsset = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent({ outputAssetKey: "eip155:196:0x3333333333333333333333333333333333333333", decision: decision([]) }));
    expect(wrongAsset.status).toBe(422);
    expect(checkOf(wrongAsset.json, "scope").reasons.map((x) => x.code)).toContain("INTENT_OUT_OF_SCOPE");
    const sell = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent({ kind: "sell", decision: decision([]) }));
    expect(sell.status).toBe(422);
    expect(checkOf(sell.json, "scope").reasons.map((x) => x.code)).toContain("INTENT_OUT_OF_SCOPE");
    // 平台事实：引用了本次核验没有的证据 id → 可采信但标 unknown（不阻塞）；结构错误 → 400
    const unknownEvidence = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent({ decision: decision([{ kind: "platform_fact", text: "VIX 低", source: { evidenceId: "nope" } }]) }));
    expect([201, 422]).toContain(unknownEvidence.status);
    expect((unknownEvidence.json["intent"] as { triage: Array<{ label: string }> }).triage[0]!.label).toBe("platform_unknown_evidence");
    expect((await api(env, "POST", `/v1/tasks/${taskId}/intents`, { clientRequestId: "x", amountInRaw: "0", decision: { rationale: "" } })).status).toBe(400);
    expect((await api(env, "GET", `/v1/tasks/${taskId}/intents`)).json["intents"]).toHaveLength(5);
  });

  it("硬约束（session US_REGULAR）在盘后不满足 → scope 不过 HARD_CONSTRAINT_BLOCK；SIMULATION 任务的意图只核验不签（simulated）", async () => {
    env = await envWithContext();
    const created = await api(env, "POST", "/v1/tasks", body());
    const taskId = (created.json["task"] as { id: string }).id;
    expect((await authorize(env, taskId)).status).toBe(201);
    env.setNow("2026-09-18T21:00:00.000Z"); // 17:00 ET 盘后
    const post = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent());
    expect(post.status, JSON.stringify(post.json).slice(0, 500)).toBe(422);
    expect(checkOf(post.json, "scope").ok).toBe(false);
    expect(checkOf(post.json, "scope").reasons.map((x) => x.code)).toContain("HARD_CONSTRAINT_BLOCK");
    expect(checkOf(post.json, "scope").reasons.map((x) => x.code)).toContain("SESSION_RULE_BLOCK");
    env.setNow(AT);
    const sim = await api(env, "POST", "/v1/tasks", body({ mode: "SIMULATION", scope: { budgetCapRaw: "500000000", perStepCapRaw: "100000000", maxSteps: 5, trustTier: "agent_research" } }));
    expect(sim.status, JSON.stringify(sim.json)).toBe(201);
    const simId = (sim.json["task"] as { id: string }).id;
    const r = await api(env, "POST", `/v1/tasks/${simId}/intents`, intent({ decision: decision([{ kind: "agent_research", text: "我认为会涨", source: { url: "https://example.com/note" } }]) }));
    expect(r.status, JSON.stringify(r.json).slice(0, 500)).toBe(201);
    expect((r.json["intent"] as { status: string; step: unknown }).status).toBe("simulated");
    expect((r.json["intent"] as { step: unknown }).step).toBeNull();
    expect(r.json["certificate"]).toBeUndefined();
    expect(checkOf(r.json, "binding")).toMatchObject({ ok: true });
  });
});

describe("唤醒通路（CV-D16 批次 3）：观察 → 通知 agent → 等 agent 状态", () => {
  it("授权后条件清空 → 轮次 awaiting_agent(ready_for_intent) + task.agent_turn 通知；同一观察不重复开轮；needs_evidence / plan_revised / intent / ended 都是正常结果；过期记 no_response", async () => {
    env = await envWithContext();
    const created = await api(env, "POST", "/v1/tasks", body());
    const taskId = (created.json["task"] as { id: string }).id;
    expect(created.json["agentTurn"]).toBeNull(); // 未授权不开轮
    expect((await authorize(env, taskId)).status).toBe(201);
    const v1 = await api(env, "GET", `/v1/tasks/${taskId}`);
    const turn1 = v1.json["agentTurn"] as { version: number; state: string; reason: string; observationKey: string; respondBy: string };
    expect(turn1).toMatchObject({ version: 1, state: "awaiting_agent", reason: "ready_for_intent", observationKey: "clear" });
    expect((v1.json["timeline"] as Array<{ type: string }>).some((e) => e.type === "agent_turn")).toBe(true);
    const outbox = await env.notify.outbox(taskId);
    expect(outbox.some((n) => n.type === "task.agent_turn")).toBe(true);
    // 同一观察：monitor 再跑不开新轮
    await monitorOnce(env.mandates, env.tasks);
    expect(((await api(env, "GET", `/v1/tasks/${taskId}`)).json["agentTurn"] as { version: number }).version).toBe(1);
    // needs_evidence
    const ne = await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "needs_evidence", note: "想先看财报覆盖", requestedEvidence: ["earnings coverage for the next 5 days"] });
    expect(ne.status, JSON.stringify(ne.json).slice(0, 300)).toBe(200);
    expect((ne.json["agentTurn"] as { state: string; response: { status: string } }).state).toBe("needs_evidence");
    // plan_revised：计划条件改了、范围与授权不变
    const pr = await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "plan_revised", note: "拉开间隔到 3 个交易日", plan: { conditions: [{ type: "min_gap_trading_days", days: 3 }] } });
    expect(pr.status, JSON.stringify(pr.json).slice(0, 300)).toBe(200);
    expect(((pr.json["task"] as { conditions: { items: Array<{ type: string; days?: number }> } }).conditions.items.find((c) => c.type === "min_gap_trading_days"))).toMatchObject({ days: 3 });
    expect((pr.json["mandates"] as Array<{ current: boolean }>)[0]!.current).toBe(true);
    expect((pr.json["agentTurn"] as { state: string }).state).toBe("plan_revised");
    // 触碰硬约束 → 409 scope_locked
    expect((await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "plan_revised", note: "x", plan: { conditions: [{ type: "session", allow: ["US_REGULAR", "US_POST"] }] } })).json["error"]).toBe("scope_locked");
    // 提交意图 → intent_received
    const r = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent());
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
    const afterIntent = (await api(env, "GET", `/v1/tasks/${taskId}`)).json["agentTurn"] as { state: string; intentId: string | null };
    expect(afterIntent.state).toBe("intent_received");
    expect(afterIntent.intentId).toBe((r.json["intent"] as { id: string }).id);
    // 结构错误 → 400
    expect((await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "maybe", note: "" })).status).toBe(400);
    // ended → 服务侧暂停（不撤销）
    const end = await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "ended", note: "目标达成，不再买" });
    expect(end.status, JSON.stringify(end.json).slice(0, 300)).toBe(200);
    expect((end.json["task"] as { status: string }).status).toBe("PAUSED");
    expect(String(end.json["note"])).toMatch(/paused/);
  });
  it("no_response：过了 respondBy 没回应 → 轮次记 no_response、时间线有记录、任务不动", async () => {
    env = await envWithContext();
    const created = await api(env, "POST", "/v1/tasks", body());
    const taskId = (created.json["task"] as { id: string }).id;
    expect((await authorize(env, taskId)).status).toBe(201);
    env.setNow("2026-09-18T15:40:00.000Z"); // 42 分钟后，仍是常规时段（观察不变）
    await monitorOnce(env.mandates, env.tasks);
    const v = await api(env, "GET", `/v1/tasks/${taskId}`);
    expect((v.json["agentTurn"] as { version: number; state: string })).toMatchObject({ version: 1, state: "no_response" });
    expect((v.json["timeline"] as Array<{ type: string }>).some((e) => e.type === "agent_no_response")).toBe(true);
    expect(["ACTIVE", "WAITING"]).toContain((v.json["task"] as { status: string }).status);
  });
});

describe("CV-D16 批次 6：目标式任务（没有模板）、简报、事件驱动唤醒、agent 接管", () => {
  it("不传 playbookId → agent_goal：参数由范围合成、无计划条件、trustTier/issuance 缺省 agent_data/agent；策略文本留版本；关注事件缺省；缺范围字段 → 400", async () => {
    env = await envWithContext();
    // 嵌套写法 brief: { strategy, watch } 同样采纳
    const nested = await api(env, "POST", "/v1/tasks", { clientRequestId: "g-nested", mode: "SIMULATION", ownerAddress: owner, brief: { strategy: "嵌套写法", watch: { kinds: ["EARNINGS"] } }, scope: { objective: "n", outputAssetKeys: [FIXTURE_STOCK_KEY], budgetCapRaw: "1000000", perStepCapRaw: "500000" } });
    expect(nested.status, JSON.stringify(nested.json).slice(0, 300)).toBe(201);
    expect((nested.json["task"] as { brief: { strategy: { version: number; text: string }; watch: { kinds: string[] } } }).brief).toMatchObject({ strategy: { version: 1, text: "嵌套写法" }, watch: { kinds: ["EARNINGS"] } });
    const bad = await api(env, "POST", "/v1/tasks", { clientRequestId: "g0", mode: "SIMULATION", ownerAddress: owner, scope: { objective: "x" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json["details"])).toMatch(/required_for_goal_task/);
    const created = await api(env, "POST", "/v1/tasks", { clientRequestId: "g1", mode: "LIVE", ownerAddress: owner, strategy: "未来五个交易日结合 CPI 与利率变化找加仓机会；依据不足就持币。", exampleId: "macro_research", scope: { objective: "未来五个交易日研究 FAKEx 的加仓机会", outputAssetKeys: [FIXTURE_STOCK_KEY], budgetCapRaw: "500000000", perStepCapRaw: "100000000" }, params: { maxPriceImpactBps: 80 } });
    expect(created.status, JSON.stringify(created.json).slice(0, 400)).toBe(201);
    const task = created.json["task"] as { playbookId: string; scope: Record<string, unknown>; conditions: { items: Array<{ type: string }> }; brief: { strategy: { version: number; by: string }; watch: { kinds: string[] }; exampleId: string; agent: unknown } };
    expect(task.playbookId).toBe("agent_goal");
    expect(task.scope).toMatchObject({ inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKeys: [FIXTURE_STOCK_KEY], maxSteps: 5, trustTier: "agent_data", issuance: "agent" });
    expect(task.conditions.items.map((c) => c.type)).toEqual(["thesis_holds"]);
    expect(created.json["params"]).toMatchObject({ steps: 5, perStepAmountRaw: "100000000", maxPriceImpactBps: 80, policyId: "QUOTE_ONLY" });
    expect(task.brief).toMatchObject({ strategy: { version: 1, by: "owner" }, watch: { kinds: ["MACRO_TIER1", "EARNINGS", "FED_SPEECH"] }, exampleId: "macro_research", agent: null });
    expect((created.json["mandateDraft"] as { mandate: { budgetCap: string; maxSteps: string } }).mandate).toMatchObject({ budgetCap: "500000000", maxSteps: "5" });
    // owner 改简报：策略 v2、关注事件收窄；签名不变
    const taskId = (created.json["task"] as { id: string }).id;
    const b = await api(env, "POST", `/v1/tasks/${taskId}/brief`, { strategy: "只看 CPI；其它先不管", watchEvents: { kinds: ["MACRO_TIER1"] } });
    expect(b.status, JSON.stringify(b.json).slice(0, 300)).toBe(200);
    const brief = (b.json["task"] as { brief: { strategy: { version: number }; strategyHistory: unknown[]; watch: { kinds: string[] } }; scopeHash: string }).brief;
    expect(brief.strategy.version).toBe(2);
    expect(brief.strategyHistory).toHaveLength(2);
    expect(brief.watch.kinds).toEqual(["MACRO_TIER1"]);
    expect((b.json["task"] as { scopeHash: string }).scopeHash).toBe((created.json["task"] as { scopeHash: string }).scopeHash);
    expect((await api(env, "POST", `/v1/tasks/${taskId}/brief`, { watchEvents: { kinds: ["NOPE"] } })).status).toBe(400);
  });
  it("接管与事件唤醒：accepted 记下 agent 名字（不关闭轮次）；关注的事件临近 → reason=event 的新轮次；到点后再开一轮说「预定时间已到，自己核实实际值」；agent 用 plan.text / strategy 回报 → 简报更新", async () => {
    env = await envWithContext();
    const created = await api(env, "POST", "/v1/tasks", { clientRequestId: "g2", mode: "LIVE", ownerAddress: owner, scope: { objective: "CPI 后加仓", outputAssetKeys: [FIXTURE_STOCK_KEY], budgetCapRaw: "500000000", perStepCapRaw: "100000000" } });
    const taskId = (created.json["task"] as { id: string }).id;
    expect((await authorize(env, taskId)).status).toBe(201);
    let v = await api(env, "GET", `/v1/tasks/${taskId}`);
    expect((v.json["agentTurn"] as { version: number; reason: string; state: string })).toMatchObject({ version: 1, reason: "ready_for_intent", state: "awaiting_agent" });
    // 接管
    const acc = await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "accepted", note: "我来处理", agent: { name: "demo-agent" }, plan: { text: "先看 CPI，再决定是否分两笔买" } });
    expect(acc.status, JSON.stringify(acc.json).slice(0, 300)).toBe(200);
    expect((acc.json["agentTurn"] as { state: string; version: number })).toMatchObject({ state: "awaiting_agent", version: 1 });
    expect((acc.json["task"] as { brief: { agent: { name: string }; currentPlan: { text: string } } }).brief).toMatchObject({ agent: { name: "demo-agent" }, currentPlan: { text: "先看 CPI，再决定是否分两笔买" } });
    expect((await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "accepted", note: "x" })).status).toBe(400);
    // 一个 2 小时后的 CPI 进入观察窗 → 事件轮次
    const cpi = fixtureEvent({ id: "crowsnest:MACRO_TIER1:2026-09-18:cpi", kind: "MACRO_TIER1", name: "CPI", dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T17:00:00.000Z" });
    const r = await env.crowsnest.ingest(signedContext(kpCur!, { at: "2026-09-18T15:00:00.000Z", events: [cpi] }), { endpoint: "test", mode: "LIVE" });
    expect(r.ok).toBe(true);
    env.setNow("2026-09-18T15:01:00.000Z");
    await monitorOnce(env.mandates, env.tasks);
    v = await api(env, "GET", `/v1/tasks/${taskId}`);
    const t2 = v.json["agentTurn"] as { version: number; reason: string; summary: string; eventsKey: string };
    expect(t2).toMatchObject({ version: 2, reason: "event" });
    expect(t2.summary).toMatch(/CPI \(MACRO_TIER1\) upcoming/);
    expect(t2.eventsKey).toMatch(/cpi@\d+:upcoming/);
    // 到点 → 再开一轮：说的是「预定时间已到，自己核实」，不是「已根据结果判断」
    env.setNow("2026-09-18T17:05:00.000Z");
    await monitorOnce(env.mandates, env.tasks);
    v = await api(env, "GET", `/v1/tasks/${taskId}`);
    const t3 = v.json["agentTurn"] as { version: number; reason: string; summary: string };
    expect(t3).toMatchObject({ version: 3, reason: "event" });
    expect(t3.summary).toMatch(/scheduled time passed — verify the actual value yourself/);
    // 同一观察不重复
    await monitorOnce(env.mandates, env.tasks);
    expect(((await api(env, "GET", `/v1/tasks/${taskId}`)).json["agentTurn"] as { version: number }).version).toBe(3);
    // agent 修订策略与计划文本（不带条件）→ plan_revised、简报策略 v1 by agent
    const pr = await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "plan_revised", note: "CPI 高于预期，缩小首笔", plan: { text: "首笔改成 50，看两天再加" }, strategy: "CPI 高于预期时首笔减半" });
    expect(pr.status, JSON.stringify(pr.json).slice(0, 300)).toBe(200);
    const brief = (pr.json["task"] as { brief: { strategy: { version: number; by: string }; currentPlan: { text: string }; agent: { name: string; lastResponseAt: string } } }).brief;
    expect(brief.strategy).toMatchObject({ version: 1, by: "agent" });
    expect(brief.currentPlan.text).toBe("首笔改成 50，看两天再加");
    expect(brief.agent.name).toBe("demo-agent");
    expect((pr.json["timeline"] as Array<{ type: string }>).some((e) => e.type === "agent_plan_revised")).toBe(true);
  });
});

describe("批次 7：删除（归档）与任务级决策记录", () => {
  it("DELETE /v1/tasks/:id：运行中先取消再归档；列表与 /v1/records 不再出现，详情仍可开；证据包含简报 / 意图 / 时间线且离线复算通过", async () => {
    env = await envWithContext();
    const created = await api(env, "POST", "/v1/tasks", body());
    const taskId = (created.json["task"] as { id: string }).id;
    expect((await authorize(env, taskId)).status).toBe(201);
    await api(env, "POST", `/v1/tasks/${taskId}/agent-status`, { status: "accepted", note: "x", agent: { name: "demo-agent" } });
    const it1 = await api(env, "POST", `/v1/tasks/${taskId}/intents`, intent());
    expect(it1.status).toBe(201);
    const b = await api(env, "GET", `/v1/tasks/${taskId}/bundle`);
    expect(b.status, JSON.stringify(b.json).slice(0, 200)).toBe(200);
    const bundle = b.json as unknown as { agentIntents: Array<{ id: string }>; brief: { agent: { name: string } }; timeline: Array<{ type: string }>; agentTurn: { state: string } };
    expect(bundle.agentIntents.map((i) => i.id)).toEqual([(it1.json["intent"] as { id: string }).id]);
    expect(bundle.brief.agent.name).toBe("demo-agent");
    expect(bundle.timeline.some((e) => e.type === "intent_certified")).toBe(true);
    expect(bundle.agentTurn.state).toBe("intent_received");
    const { verifyTaskBundleExtras } = await import("@chaconne/core/verify");
    const extras = verifyTaskBundleExtras(b.json as never);
    expect(extras.filter((c) => !c.ok), JSON.stringify(extras)).toEqual([]);
    expect(extras.map((c) => c.id)).toEqual(expect.arrayContaining(["intents_belong_to_task", "certified_intents_have_certificates", "certified_intents_passed_all_checks"]));
    const del = await api(env, "DELETE", `/v1/tasks/${taskId}`);
    expect(del.status, JSON.stringify(del.json).slice(0, 300)).toBe(200);
    expect(del.json["archived"]).toBe(true);
    expect(del.json["cancelled"]).toBe(true);
    expect((del.json["task"] as { status: string }).status).toBe("REVOKE_PENDING");
    expect(((await api(env, "GET", `/v1/tasks?owner=${owner}`)).json["tasks"] as Array<{ id: string }>).some((t) => t.id === taskId)).toBe(false);
    const records = (await api(env, "GET", `/v1/records?owner=${owner}`)).json["items"] as Array<{ kind: string; id: string; taskId?: string | null }>;
    expect(records.some((t) => t.id === taskId)).toBe(false);
    // 归档任务的授权计划一并隐藏（服务器回执：删了任务，授权记录还在）
    expect(records.some((t) => t.kind === "mandate" && t.taskId === taskId)).toBe(false);
    expect((await api(env, "GET", `/v1/tasks/${taskId}`)).status).toBe(200);
    // 再删一次：已是 REVOKE_PENDING，不再取消
    const again = await api(env, "DELETE", `/v1/tasks/${taskId}`);
    expect(again.status).toBe(200);
    expect(again.json["cancelled"]).toBe(false);
  });
});
