/** Chaconne Club 后端（C-01…C-06）与第二个 A2MCP 服务（Plan & Monitor） */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, jobBody, planBody, signedMandateBody, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const WEB_KEY = "vk_web_club";
const ADDR_A = "0x00000000000000000000000000000000000000aa";
const ADDR_B = "0x00000000000000000000000000000000000000bb";

async function webEnv(extra: Record<string, string> = {}) {
  const e = await createTestEnv({ extraKeys: `${WEB_KEY}:web:*`, env: extra });
  return e;
}
const asAddr = (addr: string) => ({ "x-verify-caller": addr });

describe("Club 后端", () => {
  it("C-01 角色不改变报告哈希：同输入不同角色 → reportHash 相同", async () => {
    env = await webEnv();
    await api(env, "PUT", "/v1/profiles/me", { personaId: "turtle_drummer", name: "Tortuga", tone: "playful" }, asAddr(ADDR_A), WEB_KEY);
    await api(env, "PUT", "/v1/profiles/me", { personaId: "cat_conductor", name: "Maestro", tone: "terse" }, asAddr(ADDR_B), WEB_KEY);
    const a = await api(env, "POST", "/v1/jobs", jobBody({ clientRequestId: "same" }), asAddr(ADDR_A), WEB_KEY);
    const b = await api(env, "POST", "/v1/jobs", jobBody({ clientRequestId: "same" }), asAddr(ADDR_B), WEB_KEY);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json["jobId"]).not.toBe(b.json["jobId"]);
    const ra = await api(env, "GET", `/v1/jobs/${a.json["jobId"]}/report`, undefined, asAddr(ADDR_A), WEB_KEY);
    const rb = await api(env, "GET", `/v1/jobs/${b.json["jobId"]}/report`, undefined, asAddr(ADDR_B), WEB_KEY);
    // 角色只影响文案：规则结论、请求哈希、策略哈希与原因码逐项相同（证据哈希随证据 id/时间自然不同）
    const A = ra.json["report"] as Record<string, unknown>;
    const B = rb.json["report"] as Record<string, unknown>;
    expect(B["verdict"]).toBe(A["verdict"]);
    expect(B["requestHash"]).toBe(A["requestHash"]);
    expect(JSON.stringify(B["reasons"])).toBe(JSON.stringify(A["reasons"]));
    expect(B["effectivePolicyHash"]).toBe(A["effectivePolicyHash"]);
    expect(B["comparisonStatus"]).toBe(A["comparisonStatus"]);

    // 同一任务换角色后重读：reportHash 一字不变（报告不知道角色存在）
    const before = (await api(env, "GET", `/v1/jobs/${a.json["jobId"]}/report`, undefined, asAddr(ADDR_A), WEB_KEY)).json["reportHash"];
    await api(env, "PUT", "/v1/profiles/me", { personaId: "ox_bassist", name: "Bassie", tone: "calm" }, asAddr(ADDR_A), WEB_KEY);
    const after = (await api(env, "GET", `/v1/jobs/${a.json["jobId"]}/report`, undefined, asAddr(ADDR_A), WEB_KEY)).json["reportHash"];
    expect(after).toBe(before);
  });

  it("角色：校验 personaId/tone；GET 未设置 → null", async () => {
    env = await webEnv();
    const empty = await api(env, "GET", "/v1/profiles/me", undefined, asAddr(ADDR_A), WEB_KEY);
    expect(empty.json["profile"]).toBeNull();
    const bad = await api(env, "PUT", "/v1/profiles/me", { personaId: "dragon", name: "x", tone: "loud" }, asAddr(ADDR_A), WEB_KEY);
    expect(bad.status).toBe(400);
    const ok = await api(env, "PUT", "/v1/profiles/me", { personaId: "ox_bassist", name: "Bassie", tone: "calm" }, asAddr(ADDR_A), WEB_KEY);
    expect(ok.json["profile"]).toMatchObject({ personaId: "ox_bassist", name: "Bassie", tone: "calm" });
  });

  it("C-04 模拟任务：跑规则出结论，不签证书不执行，标 SIMULATION", async () => {
    env = await webEnv();
    const r = await api(env, "POST", "/v1/simulations", { ...planBody(), ownerAddress: ADDR_A, personaId: "cat_conductor" }, asAddr(ADDR_A), WEB_KEY);
    expect(r.status).toBe(201);
    expect(r.json["mode"]).toBe("SIMULATION");
    expect(r.json["certificatesIssued"]).toBe(0);
    expect(r.json["executions"]).toEqual([]);
    expect(["eligible", "limited", "rejected"]).toContain(r.json["verdict"]);
    expect((r.json["plan"] as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
    const got = await api(env, "GET", `/v1/simulations/${r.json["simulationId"]}`, undefined, asAddr(ADDR_A), WEB_KEY);
    expect(got.json["planHash"]).toBe(r.json["planHash"]);
    // 他人读不到
    expect((await api(env, "GET", `/v1/simulations/${r.json["simulationId"]}`, undefined, asAddr(ADDR_B), WEB_KEY)).status).toBe(404);
  });

  it("C-03 翻创模板：只含结构，不含金额 / 钱包 / 旧报价 / 旧授权", async () => {
    env = await webEnv();
    const job = await api(env, "POST", "/v1/jobs", jobBody(), asAddr(ADDR_A), WEB_KEY);
    const t = await api(env, "POST", "/v1/templates", { kind: "job", from: job.json["jobId"] }, asAddr(ADDR_A), WEB_KEY);
    expect(t.status).toBe(201);
    const tpl = t.json["template"] as Record<string, unknown>;
    const flat = JSON.stringify(tpl);
    expect(tpl["inputAssetKey"]).toBe(FIXTURE_STABLE_KEY);
    expect(tpl["outputAssetKey"]).toBe(FIXTURE_STOCK_KEY);
    expect(tpl["policyId"]).toBeTruthy();
    expect(flat).not.toContain("amountInRaw");
    expect(flat).not.toContain("ownerAddress");
    expect(flat).not.toContain("recipientAddress");
    expect(flat.toLowerCase()).not.toContain(ADDR_A.slice(2).toLowerCase());
    expect(flat).not.toContain("expectedOut");
    // 模板公开可读（不需要 key）
    const pub = await api(env, "GET", `/v1/templates/${t.json["templateId"]}`, undefined, {}, "");
    expect(pub.status).toBe(200);
    expect(pub.json["template"]).toEqual(tpl);
    // 规划模板同样不含金额
    const plan = await api(env, "POST", "/v1/plans", planBody({ ownerAddress: ADDR_A }), asAddr(ADDR_A), WEB_KEY);
    const t2 = await api(env, "POST", "/v1/templates", { kind: "plan", from: plan.json["planId"] }, asAddr(ADDR_A), WEB_KEY);
    expect(JSON.stringify(t2.json["template"])).not.toContain("amountInRaw");
    expect((t2.json["template"] as { legs: unknown[] }).legs.length).toBe(1);
  });

  it("C-02 战报默认私密；公开后金额按隐私设置区间化 / 隐藏；C-06 /pub/live 只含自愿公开项", async () => {
    env = await webEnv();
    const job = await api(env, "POST", "/v1/jobs", jobBody(), asAddr(ADDR_A), WEB_KEY);
    const jobId = job.json["jobId"] as string;
    const priv = await api(env, "POST", "/v1/shares", { kind: "job", refId: jobId, public: false }, asAddr(ADDR_A), WEB_KEY);
    expect(priv.status).toBe(201);
    expect(priv.json["public"]).toBe(false);
    expect(priv.json["publicUrl"]).toBeNull();
    const hidden = await api(env, "GET", `/pub/reports/${priv.json["shareId"]}`, undefined, {}, "");
    expect(hidden.status).toBe(404);
    expect((await api(env, "GET", "/pub/live", undefined, {}, "")).json["items"]).toEqual([]);

    const open = await api(env, "POST", "/v1/shares", { kind: "job", refId: jobId, public: true, privacy: { amounts: "range" }, title: "My first verified buy" }, asAddr(ADDR_A), WEB_KEY);
    expect(open.json["shareId"]).toBe(priv.json["shareId"]);
    const card = await api(env, "GET", `/pub/reports/${open.json["shareId"]}`, undefined, {}, "");
    expect(card.status).toBe(200);
    expect(card.json["title"]).toBe("My first verified buy");
    expect(card.json["headline"]).toBe("My first verified buy");
    const goal = card.json["goal"] as { amount: string; output: string };
    expect(goal.amount).toMatch(/^(< 10|10–100|100–1k|1k–10k|> 10k)$/);
    expect(JSON.stringify(card.json)).not.toContain(ADDR_A.slice(2));
    expect((card.json["result"] as { reportHash: string }).reportHash).toMatch(/^0x/);
    expect((card.json["verifier"] as { bundleUrl: string }).bundleUrl).toBe(`/v1/jobs/${jobId}/bundle`);
    const live = await api(env, "GET", "/pub/live", undefined, {}, "");
    expect((live.json["items"] as unknown[]).length).toBe(1);

    const exact = await api(env, "POST", "/v1/shares", { kind: "job", refId: jobId, public: true, privacy: { amounts: "hidden" } }, asAddr(ADDR_A), WEB_KEY);
    expect(exact.status).toBe(201);
    const card2 = await api(env, "GET", `/pub/reports/${exact.json["shareId"]}`, undefined, {}, "");
    expect((card2.json["goal"] as { amount: string | null }).amount).toBeNull();
    // 他人不能公开我的任务
    const stolen = await api(env, "POST", "/v1/shares", { kind: "job", refId: jobId, public: true }, asAddr(ADDR_B), WEB_KEY);
    expect(stolen.status).toBe(404);
  });

  it("C-05 战报文案随角色语气变化，但结论字段不变；授权计划战报带完成比例", async () => {
    env = await webEnv();
    const { body } = await signedMandateBody(env, { clientRequestId: "share-mnd" });
    const reg = await api(env, "POST", "/v1/mandates", body);
    const mandateId = reg.json["mandateId"] as string;
    const share = await api(env, "POST", "/v1/shares", { kind: "mandate", refId: mandateId, public: true, privacy: { amounts: "exact" } });
    expect(share.status).toBe(201);
    const card = await api(env, "GET", `/pub/reports/${share.json["shareId"]}`, undefined, {}, "");
    expect(card.status).toBe(200);
    expect(card.json["status"]).toBe("waiting");
    expect((card.json["result"] as { completionBps: number; state: string }).state).toBe("ACTIVE");
    expect((card.json["verifier"] as { contractAddress: string }).contractAddress).toBe(env.cfg.PLANGUARD_ADDRESS);
    expect(String(card.json["headline"]).length).toBeGreaterThan(5);
  });
});

/**
 * 生产形态回归（2026-09-21 评测反馈）。以上用例都跑在 `web:*`（按地址细分调用方）+ 平铺请求体上，
 * 而线上 verify-web 配的是**共享调用方** `key:web`（无通配），页面发的是接口文档 §10.10 的嵌套请求体——
 * 107 条全绿也没拦住 /play 永远 owner_required、/plan 全部候选 SOURCE_TIME_FUTURE。这里照线上原样打。
 */
describe("生产形态：共享 web 调用方 + 网页实际请求体", () => {
  const SHARED_KEY = "vk_web_shared";
  const sharedEnv = (o: Parameters<typeof createTestEnv>[0] = {}) => createTestEnv({ ...o, extraKeys: `${SHARED_KEY}:web` });

  it("/play：{goal:{…ownerAddress}, personaId, presetId, clientRequestId} → 201（曾 400 owner_required）", async () => {
    env = await sharedEnv();
    const { clientRequestId: _drop, ...goal } = planBody({ ownerAddress: ADDR_A, recipientAddress: ADDR_A }) as Record<string, unknown>;
    const r = await api(env, "POST", "/v1/simulations", { goal, personaId: "cat_conductor", presetId: "p1", clientRequestId: "web-sim-1" }, {}, SHARED_KEY);
    expect(r.status).toBe(201);
    expect(r.json["mode"]).toBe("SIMULATION");
    expect((r.json["goal"] as { ownerAddress: string }).ownerAddress.toLowerCase()).toBe(ADDR_A);
    expect((r.json["plan"] as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
    // 平铺形态（MCP）照旧可用
    const flat = await api(env, "POST", "/v1/simulations", { ...planBody({ ownerAddress: ADDR_A }), clientRequestId: "mcp-sim-1" }, {}, SHARED_KEY);
    expect(flat.status).toBe(201);
    // 两种形态都没给地址 → 仍然明确报 owner_required
    const { ownerAddress: _o, recipientAddress: _r, ...noOwner } = goal;
    expect((await api(env, "POST", "/v1/simulations", { goal: noOwner, clientRequestId: "web-sim-2" }, {}, SHARED_KEY)).json["error"]).toBe("owner_required");
  });

  it("翻创模板：网页发 {kind, refId}、不带 ownerAddress → 201，作者取被翻创对象的 owner", async () => {
    env = await sharedEnv();
    const job = await api(env, "POST", "/v1/jobs", jobBody(), {}, SHARED_KEY);
    const t = await api(env, "POST", "/v1/templates", { kind: "job", refId: job.json["jobId"] }, {}, SHARED_KEY);
    expect(t.status).toBe(201);
    expect((t.json["template"] as Record<string, unknown>)["outputAssetKey"]).toBe(FIXTURE_STOCK_KEY);
    expect(JSON.stringify(t.json)).not.toContain("amountInRaw");
  });

  it("/plan：阶梯采证耗时 5.2 s（线上实测）→ 评估时刻取在采证之后，不再全员 SOURCE_TIME_FUTURE", async () => {
    // 把每条证据的 receivedAt 推到请求时钟之后 5.2 s —— pln_c33f310166c722c2e23fd72f 的实际时序
    const late = (iso: string) => new Date(Date.parse(iso) + 5_200).toISOString();
    env = await sharedEnv({
      evidenceDecorator: (c, nowIso) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, time: { ...e.time, requestedAt: nowIso, receivedAt: late(nowIso) } })) }),
    });
    const r = await api(env, "POST", "/v1/plans", planBody({ ownerAddress: ADDR_A, policyId: "QUOTE_ONLY", maxReferenceDeviationBps: null }), {}, SHARED_KEY);
    expect([200, 201]).toContain(r.status);
    const plan = r.json["plan"] as { evaluatedAt: string; recommended: string | null; candidates: Array<{ blocking?: Array<{ code: string }>; policyVerdicts?: Record<string, { blocking?: Array<{ code: string }> }> }> };
    expect(JSON.stringify(plan)).not.toContain("SOURCE_TIME_FUTURE");
    expect(plan.recommended).not.toBeNull();
    // 入库的 evaluatedAt 与报告一致（不是采证前的请求时钟）
    expect(r.json["evaluatedAt"]).toBe(plan.evaluatedAt);
  });
});

describe("第二个 A2MCP 服务（Plan & Monitor，D-083）", () => {
  it("空参 → 200 status=input_required + schema + example（OKX 客户端只认 200/402）；正常参数 → 200 规划结果", async () => {
    env = await createTestEnv();
    const empty = await fetch(env.url + "/a2mcp/plan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(empty.status).toBe(200);
    const ej = (await empty.json()) as Record<string, unknown>;
    expect(ej["error"]).toBe("input_required");
    expect((ej["schema"] as { required: string[] }).required).toContain("outputAssetKey");
    expect(ej["example"]).toBeTruthy();

    const ok = await fetch(env.url + "/a2mcp/plan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-okx-agent-id": "13803" },
      body: JSON.stringify({ ownerAddress: "0x00000000000000000000000000000000000000aa", inputAssetKeys: [FIXTURE_STABLE_KEY], outputAssetKey: FIXTURE_STOCK_KEY, amountInRaw: "100000000", policyId: "STRICT_LIVE", maxSlippageBps: 50 }),
    });
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as Record<string, unknown>;
    expect(j["service"]).toBe("Chaconne Verify / Plan & Monitor");
    expect((j["candidates"] as unknown[]).length).toBeGreaterThan(0);
    expect(j["planHash"]).toMatch(/^0x/);
    expect(String(j["disclaimer"])).toMatch(/Not investment advice/);
  });

  it("GET /a2mcp/plan 与 GET /a2mcp/monitor 空探活 → 200 status=input_required（第三方 GET 探测不再 404）", async () => {
    env = await webEnv();
    for (const p of ["/a2mcp/plan", "/a2mcp/monitor"]) {
      const res = await fetch(env.url + p);
      expect(res.status).toBe(200);
      const j = (await res.json()) as Record<string, unknown>;
      expect(j["status"]).toBe("input_required");
      expect(j["ok"]).toBe(false);
    }
  });

  it("/a2mcp/monitor 空参 → 200 status=input_required 带签名说明；登记 → 200 + 状态可查", async () => {
    env = await createTestEnv();
    const empty = await fetch(env.url + "/a2mcp/monitor", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as Record<string, unknown>)["error"]).toBe("input_required");
    const { body } = await signedMandateBody(env, { clientRequestId: "a2mcp-mnd" });
    const reg = await fetch(env.url + "/a2mcp/monitor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(reg.status).toBe(201);
    const rj = (await reg.json()) as Record<string, unknown>;
    expect(rj["state"]).toBe("ACTIVE");
    const status = await fetch(`${env.url}/a2mcp/monitor/${rj["mandateId"]}`);
    expect(status.status).toBe(200);
    expect(((await status.json()) as Record<string, unknown>)["mandateId"]).toBe(rj["mandateId"]);
  });
});
