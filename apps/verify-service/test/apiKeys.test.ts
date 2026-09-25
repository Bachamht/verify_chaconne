/** FIX-175：key 必须带（缺省关闭开放模式）；钱包签名自助签发 key；key 代表该钱包，与网页同一批记录；吊销即失效 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { apiKeyIssueMessage } from "@chaconne/core/verify";
import { api, createTestEnv, TEST_OWNER_KEY, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });
const OWNER = privateKeyToAccount(TEST_OWNER_KEY);
const owner = OWNER.address.toLowerCase();
const STRANGER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const body = (id: string) => ({ clientRequestId: id, mode: "SIMULATION", ownerAddress: owner, scope: { objective: "keyed", outputAssetKeys: [FIXTURE_STOCK_KEY], budgetCapRaw: "1000000", perStepCapRaw: "500000", inputAssetKey: FIXTURE_STABLE_KEY } });

async function issue(e: TestEnv, opts: { label?: string; signer?: typeof OWNER; nonce?: string; issuedAt?: string; signature?: string } = {}) {
  const fields = { owner, label: opts.label ?? "my agent", nonce: opts.nonce ?? randomBytes(16).toString("hex"), issuedAt: opts.issuedAt ?? e.cfgNow() };
  const signature = opts.signature ?? (await (opts.signer ?? OWNER).signMessage({ message: apiKeyIssueMessage(fields) }));
  const res = await fetch(e.url + "/v1/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerAddress: fields.owner, label: fields.label, nonce: fields.nonce, issuedAt: fields.issuedAt, signature }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, nonce: fields.nonce };
}

describe("FIX-175 钱包签发的 API key", () => {
  it("缺省必须带 key：无 key → 401 missing_api_key 并告诉去哪拿；签发 → 201 明文 key 只给一次；key 代表钱包：建任务、列任务，网页会话看到同一批", async () => {
    env = await createTestEnv({ extraKeys: "vk_web_t:web:*" });
    const nokey = await api(env, "GET", `/v1/tasks?owner=${owner}`, undefined, { "x-verify-caller": owner }, "");
    expect(nokey.status).toBe(401);
    expect(nokey.json["error"]).toBe("missing_api_key");
    expect(String(nokey.json["keysUrl"])).toMatch(/\/agent\/keys$/);

    const k = await issue(env);
    expect(k.status, JSON.stringify(k.json)).toBe(201);
    const apiKey = k.json["apiKey"] as string;
    expect(apiKey).toMatch(/^vk_live_[0-9a-f]{48}$/);
    expect(k.json["callerId"]).toBe(`agent:${owner}`);
    expect(String(k.json["hint"])).toMatch(/^vk_live_[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect((k.json["usage"] as { mcp: { VERIFY_API_KEY: string } }).mcp.VERIFY_API_KEY).toBe(apiKey);

    const created = await api(env, "POST", "/v1/tasks", body("k1"), {}, apiKey);
    expect(created.status, JSON.stringify(created.json).slice(0, 200)).toBe(201);
    const id = (created.json["task"] as { id: string }).id;
    expect(((await api(env, "GET", `/v1/tasks?owner=${owner}`, undefined, {}, apiKey)).json["tasks"] as Array<{ id: string }>).some((t) => t.id === id)).toBe(true);
    // 网页（受信代理 + 该钱包）看到 agent 建的任务；agent 的 key 也能读网页建的
    expect((await api(env, "GET", `/v1/tasks/${id}`, undefined, { "x-verify-caller": owner }, "vk_web_t")).status).toBe(200);
    const viaWeb = await api(env, "POST", "/v1/tasks", body("k2"), { "x-verify-caller": owner }, "vk_web_t");
    expect((await api(env, "GET", `/v1/tasks/${(viaWeb.json["task"] as { id: string }).id}`, undefined, {}, apiKey)).status).toBe(200);
    // 别的钱包的 key 看不到
    const other = await api(env, "GET", `/v1/tasks/${id}`, undefined, { "x-verify-caller": STRANGER.address.toLowerCase() }, "vk_web_t");
    expect(other.status).toBe(403);
    // 钱包 key 不是运营者
    const ing = await api(env, "POST", "/v1/events/earnings/ingest", {}, {}, apiKey);
    expect([403, 404]).toContain(ing.status);
    if (ing.status === 403) expect(ing.json["error"]).toBe("operator_only");

    // 列出：网页会话（代理 + 该钱包）可以；别的钱包 403；不含明文
    const list = await api(env, "GET", `/v1/keys?owner=${owner}`, undefined, { "x-verify-caller": owner }, "vk_web_t");
    expect(list.status).toBe(200);
    const keys = list.json["keys"] as Array<Record<string, unknown>>;
    expect(keys.map((x) => x["id"])).toEqual([k.json["id"]]);
    expect(JSON.stringify(keys)).not.toContain(apiKey);
    expect((await api(env, "GET", `/v1/keys?owner=${owner}`, undefined, { "x-verify-caller": STRANGER.address.toLowerCase() }, "vk_web_t")).status).toBe(403);
    // 用自己的 key 也能列
    expect((await api(env, "GET", `/v1/keys?owner=${owner}`, undefined, {}, apiKey)).status).toBe(200);

    // 吊销：别的钱包 404；自己 200；之后 key 403 invalid_api_key
    expect((await api(env, "DELETE", `/v1/keys/${String(k.json["id"])}`, undefined, { "x-verify-caller": STRANGER.address.toLowerCase() }, "vk_web_t")).status).toBe(404);
    const rev = await api(env, "DELETE", `/v1/keys/${String(k.json["id"])}`, undefined, { "x-verify-caller": owner }, "vk_web_t");
    expect(rev.status).toBe(200);
    expect(rev.json["revoked"]).toBe(true);
    const dead = await api(env, "GET", `/v1/tasks?owner=${owner}`, undefined, {}, apiKey);
    expect(dead.status).toBe(403);
    expect(dead.json["error"]).toBe("invalid_api_key");
    expect(((await api(env, "GET", `/v1/keys?owner=${owner}`, undefined, { "x-verify-caller": owner }, "vk_web_t")).json["keys"] as unknown[]).length).toBe(0);
  });

  it("签名校验：别人代签 401 bad_signature；同一签名重放 409 nonce_reused；issuedAt 偏差超过 10 分钟 400；标签 / nonce 非法 400", async () => {
    env = await createTestEnv();
    const forged = await issue(env, { signer: STRANGER });
    expect(forged.status).toBe(401);
    expect(forged.json["error"]).toBe("bad_signature");
    const first = await issue(env);
    expect(first.status).toBe(201);
    const nowMs = Date.parse(env.cfgNow());
    const replay = await issue(env, { nonce: first.nonce, issuedAt: env.cfgNow() });
    expect(replay.status).toBe(409);
    expect(replay.json["error"]).toBe("nonce_reused");
    const stale = await issue(env, { issuedAt: new Date(nowMs - 20 * 60_000).toISOString() });
    expect(stale.status).toBe(400);
    expect(stale.json["error"]).toBe("issued_at_out_of_window");
    expect((await issue(env, { label: "" })).status).toBe(400);
    expect((await issue(env, { nonce: "zz" })).status).toBe(400);
    expect((await issue(env, { signature: "0x1234" })).status).toBe(400);
  });
});
