/** v6 Lane B · C1 上下文摄入与 /v1/context（X-01～X-06）、事件端点 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyContextSnapshots } from "@chaconne/db";
import { canonicalJson, CONTEXT_FIELD_PATHS, contextPathGet, type EvidenceRecord } from "@chaconne/core/verify";
import { fixtureEvent } from "@chaconne/core/verify/context/fixture";
import { FIXTURE_STOCK_KEY, T_REGULAR } from "@chaconne/core/verify/fixtures";
import { ed25519PublicKeyFromRaw, verifyEd25519 } from "../src/context/keys";
import { api, createTestEnv, type TestEnv } from "./helpers";
import { crowsnestFixture, signedContext, testKeypair } from "./contextHelpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const AT = "2026-09-18T14:58:00.000Z"; // 打包在 T_REGULAR 前 2 分钟
const LANE_A_PUBKEY_ID = "crowsnest-ctx-k1";

describe("X-01 验签 / 篡改拒收（Lane A 黄金样本 + 本地临时密钥）", () => {
  it("X-01 三份黄金样本：TS canonical 逐字节一致 + Ed25519 验签通过；改一个字节 → 验签失败", () => {
    for (const name of ["context_canon_1_edge", "context_canon_2_rates", "context_canon_3_event"]) {
      const g = JSON.parse(crowsnestFixture(`${name}.json`)) as { input: Record<string, unknown>; canonical: string; signature: string; publicKeyHex: string; publicKeyId: string };
      expect(g.publicKeyId).toBe(LANE_A_PUBKEY_ID);
      const c = canonicalJson(g.input);
      expect(c).toBe(g.canonical);
      const pub = ed25519PublicKeyFromRaw(Buffer.from(g.publicKeyHex, "hex"));
      expect(verifyEd25519(pub, c, g.signature), name).toBe(true);
      expect(verifyEd25519(pub, c.replace("crowsnest", "crowsnesT"), g.signature)).toBe(false);
      const flipped = g.signature.slice(0, 10) + (g.signature[10] === "0" ? "1" : "0") + g.signature.slice(11);
      expect(verifyEd25519(pub, c, flipped)).toBe(false);
    }
  });

  it("X-01 摄入：正确签名 → 快照 ok + market_context 证据 signatureValid=true；篡改字段 → rejected + unavailable 证据 + CONTEXT_UNAVAILABLE；未知 publicKeyId → 拒收", async () => {
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
    const raw = signedContext(kp, { at: AT });
    const ok = await env.crowsnest.ingest(raw, { endpoint: "test", mode: "LIVE" });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect((ok.evidence.payload as { signatureValid: boolean }).signatureValid).toBe(true);
    expect(ok.evidence.mode).toBe("LIVE");
    expect(ok.provenance).toBe("live");
    const tampered = raw.replace('"17.85"', '"18.85"');
    const bad = await env.crowsnest.ingest(tampered, { endpoint: "test", mode: "LIVE" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toBe("signature_invalid");
    expect((bad.evidence.payload as { signatureValid: boolean; fieldStatus: Record<string, string> }).signatureValid).toBe(false);
    expect((bad.evidence.payload as { fieldStatus: Record<string, string> }).fieldStatus).toEqual({ "*": "unavailable" });
    const rows = await env.db.select().from(verifyContextSnapshots);
    expect(rows.map((r) => r.status).sort()).toEqual(["ok", "rejected"]);
    const other = testKeypair("other-key");
    const unknown = await env.crowsnest.ingest(signedContext(other, { at: AT }), { endpoint: "test", mode: "LIVE" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("unknown_public_key");
    // 最新一次拒收不影响服务继续用上一份有效快照
    const r = await api(env, "GET", "/v1/context?tier=agent");
    expect(r.status).toBe(200);
    expect((r.json["meta"] as { available: boolean; note: string }).available).toBe(true);
  });

  it("X-01 Lane A 联调样本 sample_context.json（provenance.mode=sample）：验签通过、证据模式降为 FIXTURE、LIVE 判定不用它、SIMULATION 可用", async () => {
    const g = JSON.parse(crowsnestFixture("context_canon_1_edge.json")) as { publicKeyHex: string };
    env = await createTestEnv({ now: "2026-09-23T10:05:00.000Z", crowsnestPubkey: `${LANE_A_PUBKEY_ID}=${g.publicKeyHex}` });
    const r = await env.crowsnest.ingest(crowsnestFixture("sample_context.json"), { endpoint: "sample", mode: "LIVE" });
    expect(r.ok, JSON.stringify(!r.ok ? r.detail : null)).toBe(true);
    if (!r.ok) return;
    expect(r.provenance).toBe("sample");
    expect(r.evidence.mode).toBe("FIXTURE");
    expect(r.events.inserted.length).toBeGreaterThan(0);
    expect(r.fieldStatus["session.label"]).toBe("ok");
    expect(r.fieldStatus["risk.nqOvernightPct"]).toBe("unavailable");
    const view = await api(env, "GET", "/v1/context?tier=agent");
    expect((view.json["meta"] as { provenanceMode: string }).provenanceMode).toBe("sample");
    const live = await env.context.conditionEvidence(["us-equity:FAKE"]);
    expect(live.context).toBeNull();
    const sim = await env.context.conditionEvidence(["us-equity:FAKE"], undefined, { allowNonLive: true });
    expect(sim.context).not.toBeNull();
    // agent 档样本：risk.vix 已由 producer 标 not_in_tier，服务侧同样输出 not_in_tier
    const agent = await env.crowsnest.ingest(crowsnestFixture("sample_context.agent.json"), { endpoint: "sample-agent", mode: "LIVE" });
    expect(agent.ok).toBe(true);
  });
});

describe("X-02 逐字段 staleness 由服务判定", () => {
  it("X-02 摄入时按 receivedAt 判定：打包 30 分钟前 → session/fed.hikeProb stale、rates 日度仍 ok；响应 meta.fieldStatus 带出", async () => {
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
    const r = await env.crowsnest.ingest(signedContext(kp, { at: "2026-09-18T14:30:00.000Z" }), { endpoint: "test", mode: "LIVE" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fieldStatus["session.label"]).toBe("stale");
    expect(r.fieldStatus["fed.hikeProb"]).toBe("stale");
    expect(r.fieldStatus["rates.y10"]).toBe("ok");
    expect(r.fieldStatus["risk.vix"]).toBe("stale");
    expect(r.fieldStatus["events"]).toBe("ok");
    const view = await api(env, "GET", "/v1/context?tier=display");
    const label = (view.json["session"] as { label: { status: string } }).label;
    expect(label.status).toBe("stale"); // 覆盖 producer 自报的 ok
  });
});

describe("X-03 哨兵不可达", () => {
  it("X-03 pull 失败 → unavailable 快照 + 证据；GET /v1/context 仍 200 且全部字段 unavailable、键齐全", async () => {
    env = await createTestEnv();
    const r = await env.crowsnest.pull("https://crowsnest.invalid/context/latest.json", "LIVE");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unreachable");
    const view = await api(env, "GET", "/v1/context?tier=agent");
    expect(view.status).toBe(200);
    const meta = view.json["meta"] as { available: boolean; reason: string };
    expect(meta.available).toBe(false);
    expect(meta.reason).toBe("CONTEXT_UNAVAILABLE");
    for (const [path] of CONTEXT_FIELD_PATHS) expect((contextPathGet(view.json, path) as { status: string } | undefined)?.status, path).toBe("unavailable");
    expect(view.json["events"]).toEqual([]);
  });
});

describe("X-04 / X-05 / X-06 响应裁剪与过滤", () => {
  const events = [
    fixtureEvent({ kind: "MACRO_TIER1", name: "CPI", dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T12:30:00.000Z" }),
    fixtureEvent({ kind: "EARNINGS", name: "FAKE Q3", dateLocal: "2026-09-25", underlyingIds: ["us-equity:FAKE"], sessionHint: "amc" }),
    fixtureEvent({ kind: "EARNINGS", name: "OTHER Q3", dateLocal: "2026-09-25", underlyingIds: ["us-equity:OTHER"], sessionHint: "amc" }),
  ];
  it("X-04 无 key 只给 agent 档：risk.vix {status:'unavailable', note:'not_in_tier'} 而非省略；display 档（带 key）能看到；internal 需要 key", async () => {
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
    await env.crowsnest.ingest(signedContext(kp, { at: AT, events }), { endpoint: "test", mode: "LIVE" });
    const anon = await fetch(`${env.url}/v1/context?tier=internal`);
    expect(anon.status).toBe(200);
    const body = (await anon.json()) as Record<string, unknown>;
    expect((body["meta"] as { tier: string }).tier).toBe("agent");
    for (const [path] of CONTEXT_FIELD_PATHS) expect(contextPathGet(body, path), path).toBeDefined();
    expect(contextPathGet(body, "risk.vix")).toMatchObject({ value: null, status: "unavailable", note: "not_in_tier" });
    expect(contextPathGet(body, "rates.y10")).toMatchObject({ value: "4.96", status: "ok" });
    expect(body["signature"]).toBeUndefined();
    const display = await api(env, "GET", "/v1/context?tier=display");
    expect(contextPathGet(display.json, "risk.vix")).toMatchObject({ value: "17.85" });
  });

  it("X-04b 通配 key（web:*）不带 x-verify-caller → 按匿名放行、只给 agent 档，而不是 400 missing_caller；带 caller → display 档照常", async () => {
    // 2026-09-23 v6 上线实测：verify-web 代理对所有请求都带 web:* key，未连钱包访客没有 caller，
    // 原 optionalAuth 会 400 → /agent 首页上下文卡对每个未连钱包访客显示「尚未就绪 (HTTP 400)」
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}`, extraKeys: "vk_test_web:web:*" });
    await env.crowsnest.ingest(signedContext(kp, { at: AT, events }), { endpoint: "test", mode: "LIVE" });
    const noCaller = await api(env, "GET", "/v1/context?tier=display", undefined, {}, "vk_test_web");
    expect(noCaller.status).toBe(200);
    expect((noCaller.json["meta"] as { tier: string }).tier).toBe("agent");
    expect(contextPathGet(noCaller.json, "risk.vix")).toMatchObject({ value: null, status: "unavailable", note: "not_in_tier" });
    const withCaller = await api(env, "GET", "/v1/context?tier=display", undefined, { "x-verify-caller": "0xbaCB138e0e9E1444Bae9b401C4615378C57c0381" }, "vk_test_web");
    expect(withCaller.status).toBe(200);
    expect((withCaller.json["meta"] as { tier: string }).tier).toBe("display");
    expect(contextPathGet(withCaller.json, "risk.vix")).toMatchObject({ value: "17.85" });
  });
  it("X-05 assetKey 过滤：只回宏观 + 该标的的公司事件；taskId 过滤：只回条件引用的事件类型与字段", async () => {
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
    await env.crowsnest.ingest(signedContext(kp, { at: AT, events }), { endpoint: "test", mode: "LIVE" });
    const byAsset = await api(env, "GET", `/v1/context?tier=agent&assetKey=${FIXTURE_STOCK_KEY}`);
    expect((byAsset.json["events"] as Array<{ name: string }>).map((e) => e.name).sort()).toEqual(["CPI", "FAKE Q3"]);
    const all = await api(env, "GET", "/v1/context?tier=agent");
    expect((all.json["events"] as unknown[]).length).toBe(3);
    // 任务过滤：session_dca 只有 session/min_gap → 无事件条件 → 事件为空、rates 标 not_relevant
    const t = await api(env, "POST", "/v1/tasks", { clientRequestId: "ctx-task", playbookId: "session_dca", mode: "SIMULATION", ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", params: { steps: 2, perStepAmountRaw: "5000000", inputAssetKey: "eip155:196:0x1111111111111111111111111111111111111111", outputAssetKey: FIXTURE_STOCK_KEY } });
    expect(t.status).toBe(201);
    const taskId = (t.json["task"] as { id: string }).id;
    const byTask = await api(env, "GET", `/v1/context?tier=agent&taskId=${taskId}`);
    expect(byTask.status).toBe(200);
    expect((byTask.json["events"] as unknown[]).length).toBe(0);
    expect(contextPathGet(byTask.json, "rates.y10")).toMatchObject({ status: "unavailable", note: "not_relevant" });
    expect((contextPathGet(byTask.json, "session.label") as { status: string }).status).toBe("ok");
  });
  it("X-06 私有研究字段黑名单扫描：带 analyst/forecast/thresholds 的原文验签通过后，任何响应与证据里都不出现这些键", async () => {
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
    const base = JSON.parse(signedContext(kp, { at: AT })) as Record<string, unknown>;
    delete base["signature"];
    const { signContext } = await import("./contextHelpers");
    const raw = signContext({ ...base, analyst: { btcThesis: "private", targets: [1, 2] }, forecast: { ledger: "secret" }, thresholds: { vix: 30 } }, kp);
    const r = await env.crowsnest.ingest(raw, { endpoint: "test", mode: "LIVE" });
    expect(r.ok).toBe(true);
    const scan = /analyst|forecast|thresholds|btcThesis|ledger/;
    for (const tier of ["internal", "display", "agent", "paid"]) {
      const v = await api(env, "GET", `/v1/context?tier=${tier}`);
      expect(JSON.stringify(v.json), tier).not.toMatch(scan);
    }
    const rows = await env.db.select().from(verifyContextSnapshots);
    expect(JSON.stringify(rows[0]!.contextJson)).not.toMatch(scan);
    expect(JSON.stringify(rows[0]!.evidenceJson as EvidenceRecord)).not.toMatch(scan);
  });
});

describe("事件端点与修订史", () => {
  it("GET /v1/events 列表 + /revisions：改期 → revision+1、revisedFrom、firstKnownAt 不变；旧修订不覆盖", async () => {
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}` });
    const v0 = fixtureEvent({ id: "crowsnest.fred:MACRO_TIER2:2026-09-24:claims", kind: "MACRO_TIER2", name: "claims", dateLocal: "2026-09-24", scheduledAtUtc: "2026-09-24T12:30:00.000Z", firstKnownAt: "2026-09-20T01:05:00.000Z" });
    await env.crowsnest.ingest(signedContext(kp, { at: AT, events: [v0] }), { endpoint: "test", mode: "LIVE" });
    const v1 = { ...v0, revision: 1, dateLocal: "2026-09-25", scheduledAtUtc: "2026-09-25T12:30:00.000Z", status: "revised" as const };
    await env.crowsnest.ingest(signedContext(kp, { at: "2026-09-18T14:59:00.000Z", events: [v1] }), { endpoint: "test", mode: "LIVE" });
    // 旧修订再来 → 不覆盖
    await env.crowsnest.ingest(signedContext(kp, { at: "2026-09-18T14:59:30.000Z", events: [v0] }), { endpoint: "test", mode: "LIVE" });
    const list = await api(env, "GET", "/v1/events?kind=MACRO_TIER2");
    const ev = (list.json["events"] as Array<{ id: string; revision: number; dateLocal: string; revisedFrom?: unknown; firstKnownAt: string }>)[0]!;
    // producer 说首次可知 9/20，但本服务 9/18 已收到 → 取较早者（首次入库时刻）
    expect(ev).toMatchObject({ id: v0.id, revision: 1, dateLocal: "2026-09-25", revisedFrom: { dateLocal: "2026-09-24", scheduledAtUtc: "2026-09-24T12:30:00.000Z" }, firstKnownAt: T_REGULAR });
    const revs = await api(env, "GET", `/v1/events/${encodeURIComponent(v0.id)}/revisions`);
    expect((revs.json["revisions"] as Array<{ revision: number }>).map((r) => r.revision)).toEqual([0, 1]);
    expect((await api(env, "GET", "/v1/events/nope/revisions")).status).toBe(404);
  });
});
