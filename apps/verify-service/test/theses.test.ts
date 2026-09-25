/** v6 Lane B · C7 理由卡：T-02 三路径不越权、T-03 研究前提只生成复核项、T-04 过期/续订、T-05 进证据包、T-06 联动 */
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, TEST_OWNER_KEY, type TestEnv } from "./helpers";
import { signedContext, testKeypair, type TestKeypair } from "./contextHelpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const AT = "2026-09-18T14:58:00.000Z";
const OWNER = privateKeyToAccount(TEST_OWNER_KEY);
const owner = OWNER.address.toLowerCase();

async function setup(vix = "17.85") {
  const kp = testKeypair();
  const e = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
  const r = await e.crowsnest.ingest(signedContext(kp, { at: AT, overrides: { vix } }), { endpoint: "test", mode: "LIVE" });
  if (!r.ok) throw new Error(r.reason);
  return { e, kp };
}
async function reingest(e: TestEnv, kp: TestKeypair, vix: string) {
  const at = new Date(Date.parse(e.cfgNow()) - 60_000).toISOString();
  const r = await e.crowsnest.ingest(signedContext(kp, { at, overrides: { vix } }), { endpoint: "test", mode: "LIVE" });
  if (!r.ok) throw new Error(r.reason);
}
function body(onInvalidation: string, mode = "SIMULATION", extra: Record<string, unknown> = {}) {
  return {
    clientRequestId: `th-${Math.random().toString(16).slice(2, 10)}`,
    playbookId: "session_dca",
    mode,
    ownerAddress: owner,
    params: { steps: 2, perStepAmountRaw: "100000000", inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKey: FIXTURE_STOCK_KEY },
    thesis: { goal: "accumulate FAKE while vol is calm", rationale: "user rationale", onInvalidation, validUntil: "2026-10-01T00:00:00.000Z", premises: [{ kind: "machine", text: "VIX ≤ 30", condition: { type: "max_vix", value: 30 } }, { kind: "research", text: "AI demand keeps growing" }] },
    ...extra,
  };
}
async function authorize(e: TestEnv, taskId: string) {
  const v = await api(e, "GET", `/v1/tasks/${taskId}`);
  const draft = v.json["mandateDraft"] as { typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Hex }; types: Record<string, Array<{ name: string; type: string }>> }; mandate: Record<string, string> };
  const m = draft.mandate;
  const signature = await OWNER.signTypedData({ domain: draft.typedData.domain, types: draft.typedData.types, primaryType: "TradeMandate", message: { ...m, budgetCap: BigInt(m["budgetCap"]!), perStepCap: BigInt(m["perStepCap"]!), maxSteps: Number(m["maxSteps"]), validFrom: BigInt(m["validFrom"]!), deadline: BigInt(m["deadline"]!), nonce: BigInt(m["nonce"]!) } });
  return api(e, "POST", `/v1/tasks/${taskId}/authorize`, { signature });
}
const codes = (j: Record<string, unknown>) => (j["task"] as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code);

describe("T-01 / T-06 前提三态与 thesis_holds 联动", () => {
  it("T-01 建任务时机器前提（VIX ≤ 30）holds、research 前提 unknown、卡片 holds；VIX 35 → invalidated → 任务 WAITING(THESIS_INVALIDATED)（T-06）", async () => {
    const { e, kp } = await setup();
    env = e;
    const r = await api(env, "POST", "/v1/tasks", body("notify"));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const thesis = r.json["thesis"] as { id: string; status: string; premises: Array<{ kind: string; status: string; text: string }> };
    expect(thesis.status).toBe("holds");
    expect(thesis.premises.find((p) => p.text === "VIX ≤ 30")!.status).toBe("holds");
    expect(thesis.premises.find((p) => p.kind === "research")!.status).toBe("unknown");
    expect((r.json["task"] as { status: string }).status).toBe("ACTIVE");
    await reingest(env, kp, "35");
    const chk = await api(env, "POST", `/v1/theses/${thesis.id}/check`, {});
    expect(chk.status).toBe(200);
    expect((chk.json["thesis"] as { status: string }).status).toBe("invalidated");
    expect((chk.json["task"] as { status: string; blockers: Array<{ code: string }> }).status).toBe("WAITING");
    expect((chk.json["task"] as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toContain("THESIS_INVALIDATED");
    // V-27：论点被推翻时给出下次复评时刻（monitor 周期），不是「下次检查点未知」
    const inv = (chk.json["task"] as { blockers: Array<{ code: string; nextCheckAt: string | null }> }).blockers.find((b) => b.code === "THESIS_INVALIDATED")!;
    expect(inv.nextCheckAt).not.toBeNull();
    expect(Date.parse(inv.nextCheckAt!)).toBeGreaterThan(Date.parse(env.cfgNow()));
    // 上下文缺失 → unknown → THESIS_UNKNOWN（证据不足，不放行）
    env.setNow("2026-09-18T16:30:00.000Z"); // 快照的 risk.vix 已过 20 分钟 → stale → 机器前提 unknown
    const chk2 = await api(env, "POST", `/v1/theses/${thesis.id}/check`, {});
    expect((chk2.json["thesis"] as { status: string }).status).toBe("unknown");
    expect((chk2.json["task"] as { blockers: Array<{ code: string }> }).blockers.map((b) => b.code)).toContain("THESIS_UNKNOWN");
  });
});

describe("V-27 休市建任务：时间门不是论点前提", () => {
  it("18:00 ET 建 session_dca：premises 里 session/min_gap 标 kind=timing，卡片 holds；任务 WAITING(SESSION_RULE_BLOCK) 且没有 THESIS_INVALIDATED；nextCheckAt = 下一常规时段开盘", async () => {
    const { e } = await setup();
    env = e;
    env.setNow("2026-09-18T22:00:00.000Z");
    // session 自 2026-09-25 起不再默认生成（24 小时交易），本例测时间门，显式要求常规时段
    const r = await api(env, "POST", "/v1/tasks", body("pause_issuance", "SIMULATION", { params: { steps: 2, perStepAmountRaw: "100000000", inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKey: FIXTURE_STOCK_KEY, regularSessionOnly: true } }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const thesis = r.json["thesis"] as { status: string; premises: Array<{ kind: string; status: string; text: string }> };
    expect(thesis.status).toBe("holds");
    const session = thesis.premises.find((p) => p.text.startsWith("Session is one of"))!;
    expect(session.kind).toBe("timing");
    expect(session.status).toBe("invalidated"); // 如实：此刻休市
    expect(thesis.premises.find((p) => p.text.startsWith("At least 1 trading day"))!.kind).toBe("timing");
    expect(thesis.premises.find((p) => p.text === "VIX ≤ 30")!.kind).toBe("machine");
    const task = r.json["task"] as { status: string; blockers: Array<{ code: string; nextCheckAt: string | null }> };
    expect(task.status).toBe("WAITING"); // pause_issuance 没有被触发（不是 PAUSED）
    const codes = task.blockers.map((b) => b.code);
    expect(codes).toContain("SESSION_RULE_BLOCK");
    expect(codes).not.toContain("THESIS_INVALIDATED");
    expect(task.blockers.find((b) => b.code === "SESSION_RULE_BLOCK")!.nextCheckAt).toBe("2026-09-21T13:30:00.000Z");
    expect(env.notifier.emitted.some((n) => n.type === "thesis.invalidated")).toBe(false);
  });
});

describe("T-02 失效三路径各生效且不越权", () => {
  it("T-02 notify：只发通知（thesis.invalidated），任务不暂停、不生成卖出", async () => {
    const { e, kp } = await setup();
    env = e;
    const r = await api(env, "POST", "/v1/tasks", body("notify"));
    const id = (r.json["task"] as { id: string }).id;
    await reingest(env, kp, "35");
    const chk = await api(env, "POST", `/v1/theses/${(r.json["thesis"] as { id: string }).id}/check`, {});
    expect((chk.json["task"] as { status: string }).status).toBe("WAITING");
    expect(env.notifier.emitted.some((n) => n.type === "thesis.invalidated")).toBe(true);
    const v = await api(env, "GET", `/v1/tasks/${id}`);
    expect(v.json["exitDraft"]).toBeNull();
    expect((v.json["thesis"] as { premises: Array<{ status: string; text: string }> }).premises.find((p) => p.text === "VIX ≤ 30")!.status).toBe("invalidated");
    // 通知载荷不含签名/证书/calldata（D-087）
    for (const n of env.notifier.emitted) expect(Object.keys(n).sort()).toEqual(["at", "entityId", "idempotencyKey", "summary", "type", "url", "version"]);
  });
  it("T-02 pause_issuance：LIVE 任务 → PAUSED、授权 PAUSED、prepare-step 409 并说明只是停止签发", async () => {
    const { e, kp } = await setup();
    env = e;
    const r = await api(env, "POST", "/v1/tasks", body("pause_issuance", "LIVE"));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = (r.json["task"] as { id: string }).id;
    const auth = await authorize(env, id);
    expect((auth.json["task"] as { status: string }).status).toBe("ACTIVE");
    await reingest(env, kp, "35");
    const chk = await api(env, "POST", `/v1/theses/${(r.json["thesis"] as { id: string }).id}/check`, {});
    expect((chk.json["task"] as { status: string }).status).toBe("PAUSED");
    const v = await api(env, "GET", `/v1/tasks/${id}`);
    expect((v.json["mandates"] as Array<{ state: string }>)[0]!.state).toBe("PAUSED");
    expect(JSON.stringify(v.json["timeline"])).toMatch(/pause_issuance \(service-side: stops issuance only/);
    const p = await api(env, "POST", `/v1/tasks/${id}/prepare-step`, {});
    expect(p.status).toBe(409);
    expect(String(p.json["message"])).toMatch(/paused/);
    expect((await api(env, "GET", `/v1/theses/${(r.json["thesis"] as { id: string }).id}`)).json["checks"]).toEqual(expect.arrayContaining([expect.objectContaining({ actionTaken: "pause_issuance" })]));
  });
  it("T-02 draft_exit：生成卖出草案（requiresNewAuthorization），不卖、不改授权；任务因 THESIS_INVALIDATED 等待", async () => {
    const { e, kp } = await setup();
    env = e;
    const r = await api(env, "POST", "/v1/tasks", body("draft_exit"));
    const id = (r.json["task"] as { id: string }).id;
    await reingest(env, kp, "35");
    await api(env, "POST", `/v1/theses/${(r.json["thesis"] as { id: string }).id}/check`, {});
    const v = await api(env, "GET", `/v1/tasks/${id}`);
    const draft = v.json["exitDraft"] as { kind: string; requiresNewAuthorization: boolean; goal: { side: string; budget: { inputAssetKeys: string[] } } };
    expect(draft.kind).toBe("sell_draft");
    expect(draft.requiresNewAuthorization).toBe(true);
    expect(draft.goal.side).toBe("sell");
    expect(draft.goal.budget.inputAssetKeys).toEqual([FIXTURE_STOCK_KEY]);
    expect((v.json["task"] as { status: string }).status).toBe("WAITING");
    expect(codes(v.json)).toContain("THESIS_INVALIDATED");
    expect((v.json["mandates"] as unknown[]).length).toBe(0);
  });
});

describe("T-03 research 前提只生成复核项", () => {
  it("T-03 review-items：sourceUrl 必填；只能挂 research 前提；追加后前提仍 unknown、任务状态不变；其它调用方 404；用户标记 research 前提不触发 onInvalidation", async () => {
    const { e } = await setup();
    env = e;
    const r = await api(env, "POST", "/v1/tasks", body("pause_issuance"));
    const thesisId = (r.json["thesis"] as { id: string }).id;
    const statusBefore = (r.json["task"] as { status: string }).status;
    expect((await api(env, "POST", `/v1/theses/${thesisId}/review-items`, { side: "support", text: "no url" })).status).toBe(400);
    const added = await api(env, "POST", `/v1/theses/${thesisId}/review-items`, { side: "counter", text: "capex guidance cut", sourceUrl: "https://example.com/ir/q3", addedBy: "agent" });
    expect(added.status).toBe(201);
    const research = (added.json["premises"] as Array<{ id: string; kind: string; status: string; reviewItems?: Array<{ addedBy: string; side: string }> }>).find((p) => p.kind === "research")!;
    expect(research.status).toBe("unknown");
    expect(research.reviewItems).toEqual([expect.objectContaining({ addedBy: "agent", side: "counter", sourceUrl: "https://example.com/ir/q3" })]);
    expect(added.json["researchPending"]).toBe(1);
    const machine = (added.json["premises"] as Array<{ id: string; kind: string }>).find((p) => p.kind === "machine")!;
    expect((await api(env, "POST", `/v1/theses/${thesisId}/review-items`, { premiseId: machine.id, side: "support", text: "x", sourceUrl: "https://example.com" })).status).toBe(409);
    const { OTHER_API_KEY } = await import("./helpers");
    expect((await api(env, "POST", `/v1/theses/${thesisId}/review-items`, { side: "support", text: "x", sourceUrl: "https://example.com" }, {}, OTHER_API_KEY)).status).toBe(404);
    const task = await api(env, "GET", `/v1/tasks/${(r.json["task"] as { id: string }).id}`);
    expect((task.json["task"] as { status: string }).status).toBe(statusBefore);
    // 用户把 research 前提标为 invalidated：不是机器前提，不触发 pause_issuance；机器前提不可手改
    const marked = await api(env, "POST", `/v1/theses/${thesisId}/premises/${research.id}`, { status: "invalidated" });
    expect(marked.status).toBe(200);
    expect(marked.json["researchPremiseInvalidated"]).toBe(true);
    expect((marked.json["status"] as string)).toBe("holds");
    expect((await api(env, "POST", `/v1/theses/${thesisId}/premises/${machine.id}`, { status: "holds" })).status).toBe(409);
    expect(((await api(env, "GET", `/v1/tasks/${(r.json["task"] as { id: string }).id}`)).json["task"] as { status: string }).status).toBe(statusBefore);
  });
});

describe("T-04 过期能结束 / 续订；T-05 进证据包", () => {
  it("T-04 end → 任务 WAITING(THESIS_EXPIRED)；renew → 卡片 holds、任务恢复；validUntil 自然到期由 monitor 发现", async () => {
    const { e } = await setup();
    env = e;
    const r = await api(env, "POST", "/v1/tasks", body("notify"));
    const taskId = (r.json["task"] as { id: string }).id;
    const thesisId = (r.json["thesis"] as { id: string }).id;
    const ended = await api(env, "POST", `/v1/theses/${thesisId}/end`, {});
    expect(ended.status).toBe(200);
    expect(ended.json["status"]).toBe("expired");
    const v = await api(env, "GET", `/v1/tasks/${taskId}`);
    expect((v.json["task"] as { status: string }).status).toBe("WAITING");
    expect(codes(v.json)).toContain("THESIS_EXPIRED");
    expect((v.json["task"] as { blockers: Array<{ code: string; userActionRequired: boolean }> }).blockers.find((b) => b.code === "THESIS_EXPIRED")!.userActionRequired).toBe(true);
    expect((await api(env, "POST", `/v1/theses/${thesisId}/renew`, { validUntil: "2026-09-01T00:00:00.000Z" })).status).toBe(400);
    const renewed = await api(env, "POST", `/v1/theses/${thesisId}/renew`, { validUntil: "2026-10-01T00:00:00.000Z" });
    expect(renewed.json["status"]).toBe("holds");
    expect(((await api(env, "GET", `/v1/tasks/${taskId}`)).json["task"] as { status: string }).status).toBe("ACTIVE");
    // 自然到期（任务 deadline 在 10/18 之后，此刻任务本身未到期）
    env.setNow("2026-10-02T15:00:00.000Z");
    const { monitorOnce } = await import("../src/mandates/monitor");
    await monitorOnce(env.mandates, env.tasks);
    const after = await api(env, "GET", `/v1/tasks/${taskId}`);
    expect((after.json["thesis"] as { status: string }).status).toBe("expired");
    expect(codes(after.json)).toContain("THESIS_EXPIRED");
  });
  it("T-05 证据包带理由卡（SIMULATION 任务也有：无 mandate 的最小包）；独立 POST /v1/theses 对已有卡的任务 → 409", async () => {
    const { e } = await setup();
    env = e;
    const r = await api(env, "POST", "/v1/tasks", body("notify"));
    const taskId = (r.json["task"] as { id: string }).id;
    const b = await api(env, "GET", `/v1/tasks/${taskId}/bundle`);
    expect(b.status, JSON.stringify(b.json).slice(0, 200)).toBe(200);
    const thesis = b.json["thesis"] as { id: string; taskId: string; premises: unknown[] };
    expect(thesis.taskId).toBe(taskId);
    expect(thesis.premises.length).toBeGreaterThan(0);
    expect(b.json["bundleSignature"]).toMatch(/^0x/);
    const dup = await api(env, "POST", "/v1/theses", { taskId, goal: "g", validUntil: "2026-10-01T00:00:00.000Z", premises: [] });
    expect(dup.status).toBe(409);
  });
});
