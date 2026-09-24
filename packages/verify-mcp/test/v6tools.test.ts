/**
 * v6 工具（interfaces §11.8）：注册 23 个（合计 43）；任务链路走冻结路径；停止响应复述 D-088；
 * 端点未部署 → 结构化 not_available（不伪装）；authorize_task 只在 agent-wallet 模式、owner 一致、budgetCap ≤ MAX_SPEND 时代签；
 * agent-wallet 模式自动心跳（60 s，可注入间隔）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Hex } from "viem";
import { EIP712_TYPES_V2 } from "@chaconne/core/verify";
import { startFakeService } from "../../verify-sdk/test/fakeService";
import { VerifyClient } from "../src/client";
import { ExecutorHeartbeat } from "../src/heartbeat";
import { createVerifyMcpServer, TOOL_NAMES } from "../src/server";
import { TOOL_NAMES_V6, D088_NOTE } from "../src/toolsV6";
import { AgentWallet, agentWalletConfigFromEnv } from "../src/wallet";

/** 公开的 anvil 测试账户 #1（仅测试） */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const acct = privateKeyToAccount(KEY);
const OWNER = acct.address.toLowerCase() as Hex;
const OTHER = "0x1111111111111111111111111111111111111111";

let svc: Awaited<ReturnType<typeof startFakeService>>;
let old: Awaited<ReturnType<typeof startFakeService>>;
beforeAll(async () => {
  svc = await startFakeService();
  old = await startFakeService({ v6: false });
});
afterAll(async () => {
  await svc.close();
  await old.close();
});

function wallet(maxSpend: string) {
  const cfg = agentWalletConfigFromEnv({ AGENT_WALLET_PRIVATE_KEY: KEY, AGENT_WALLET_MAX_SPEND_USD: maxSpend, AGENT_WALLET_CHAIN_IDS: "196" })!;
  return new AgentWallet(cfg, async () => { throw new Error("no chain in tests"); }, { async mandateSteps() { return { steps: 0, spent: "0", revoked: false }; }, async allowance() { return 0n; } });
}
async function connect(url: string, w: AgentWallet | null, heartbeat: ExecutorHeartbeat | null = null) {
  const client = new VerifyClient({ baseUrl: url, apiKey: "k", caller: OWNER, payer: w?.payer ?? null });
  const server = createVerifyMcpServer({ client, wallet: w, chainId: 196, heartbeat });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "t6", version: "0" });
  await c.connect(ct);
  return { client: c, http: client, close: async () => { await c.close(); await server.close(); } };
}
const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, unknown>;
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;
const taskArgs = { clientRequestId: "t6", ownerAddress: OWNER, playbookId: "session_dca", params: { steps: 3, perStepAmountRaw: "5000000" }, conditions: { version: "conditions/1", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }] }, mode: "LIVE" };

describe("注册", () => {
  it("46 个工具全部发现：v1 7 + v2 13 + v6 23 + 免 key 3，旧工具一个不少", async () => {
    const { client, close } = await connect(svc.url, null);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names.length).toBe(46);
    expect(TOOL_NAMES_V6.length).toBe(23);
    for (const n of ["plan_trade", "prepare_mandate", "execute_next_step", "get_evidence_bundle", "verify_evidence_bundle", "list_supported_assets"]) expect(names).toContain(n);
    await close();
  });
});

describe("任务链路（冻结路径）", () => {
  it("create_task → get_task（阻塞全量 + nextCheckAt + 执行器态）→ pause/cancel 复述 D-088；explain / compare / context / events / impacts", async () => {
    const { client, close } = await connect(svc.url, null);
    const created = await client.callTool({ name: "create_task", arguments: taskArgs });
    expect(created.isError).toBeFalsy();
    expect(svc.seen.at(-1)!.path).toBe("/v1/tasks");
    const task = sc(created)["task"] as { id: string; blockers: unknown[]; nextCheckAt: string };
    expect(task.id).toBe("tsk_t6");
    expect(text(created)).toContain("blockers: EVENT_WINDOW_ACTIVE");
    expect(text(created)).toContain("nextCheckAt 2026-09-22T13:30:00Z");
    expect(text(created)).toContain("mandateDraft ready to sign");
    const got = await client.callTool({ name: "get_task", arguments: { taskId: task.id } });
    expect(text(got)).toContain("executor offline");
    const paused = await client.callTool({ name: "pause_task", arguments: { taskId: task.id } });
    expect(text(paused)).toMatch(/revokeMandate/);
    const cancelled = await client.callTool({ name: "cancel_task", arguments: { taskId: task.id } });
    expect(text(cancelled)).toMatch(/only blocks new certificates|only blocks NEW/i);
    expect(D088_NOTE).toMatch(/revokeMandate/);
    const wait = await client.callTool({ name: "explain_task_wait", arguments: { taskId: task.id } });
    expect(text(wait)).toContain("1 blocker(s): EVENT_WINDOW_ACTIVE");
    const cmp = await client.callTool({ name: "compare_task_policies", arguments: { taskId: task.id, variants: [{ label: "A", conditions: taskArgs.conditions }, { label: "B", conditions: { version: "conditions/1", items: [{ type: "session", allow: ["US_REGULAR"] }] } }] } });
    expect(sc(cmp)["mode"]).toBe("SIMULATION");
    expect(text(cmp)).toContain("A=INSUFFICIENT_EVIDENCE");
    const ctx = await client.callTool({ name: "get_market_context", arguments: { tier: "agent", owner: OWNER } });
    expect(svc.seen.at(-1)!.path).toBe(`/v1/context?tier=agent&owner=${OWNER}`);
    expect(text(ctx)).toContain("session US_REGULAR (ok)");
    expect(((sc(ctx)["risk"] as { vix: { status: string; note: string } }).vix)).toMatchObject({ status: "unavailable", note: "not_in_tier" });
    const ev = await client.callTool({ name: "get_events", arguments: { kind: "MACRO_TIER1" } });
    expect(text(ev)).toBe("1 event(s)");
    const imp = await client.callTool({ name: "get_my_event_impacts", arguments: { owner: OWNER } });
    expect(svc.seen.at(-1)!.path).toBe(`/v1/event-impacts?owner=${OWNER}&horizonHours=48`);
    expect(text(imp)).toContain("1 impact(s)");
    const th = await client.callTool({ name: "watch_thesis", arguments: { taskId: task.id, goal: "g", rationale: "r", premises: [{ kind: "research", text: "x" }], validUntil: "2026-10-01T00:00:00Z" } });
    expect(sc(th)["status"]).toBe("unknown");
    const item = await client.callTool({ name: "add_thesis_review_item", arguments: { thesisId: "ths_1", premiseId: "p1", side: "counter", text: "t", sourceUrl: "https://example.com/x" } });
    expect((svc.seen.at(-1)!.body as { addedBy: string }).addedBy).toBe("agent");
    expect(item.isError).toBeFalsy();
    const rp = await client.callTool({ name: "replay_policy", arguments: { playbookId: "session_dca", conditions: taskArgs.conditions, assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", from: "2026-09-17T00:00:00Z", to: "2026-09-17T23:59:59Z" } });
    expect(text(rp)).toContain("1 gap(s)");
    const bg = await client.callTool({ name: "create_budget_group", arguments: { owner: OWNER, name: "n", inputAssetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z", capRaw: "100000000" } });
    expect((svc.seen.at(-1)!.body as { priorityRule: string }).priorityRule).toBe("priority_then_created");
    expect(bg.isError).toBeFalsy();
    const pf = await client.callTool({ name: "get_portfolio", arguments: { owner: OWNER } });
    expect(svc.seen.at(-1)!.path).toBe(`/v1/portfolio/${OWNER}`);
    expect(pf.isError).toBeFalsy();
    const wh = await client.callTool({ name: "register_webhook", arguments: { url: "https://example.com/hook", secret: "0123456789abcdef0123" } });
    expect(text(wh)).toContain("wh_1");
    const tg = await client.callTool({ name: "link_telegram", arguments: {} });
    expect(text(tg)).toContain("TG-1234");
    await close();
  });

  it("端点未部署（404 not_found）→ not_available（isError=false，structuredContent.status=not_available），不伪装数据", async () => {
    const { client, close } = await connect(old.url, null);
    for (const [name, args] of [["get_market_context", {}], ["create_task", taskArgs], ["get_task", { taskId: "tsk_x" }], ["get_my_event_impacts", { owner: OWNER }], ["explain_task_wait", { taskId: "x" }], ["get_portfolio", { owner: OWNER }], ["executor_heartbeat", { mandateId: "mnd_1" }]] as const) {
      const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
      expect(r.isError, name).toBeFalsy();
      expect(sc(r)["status"], name).toBe("not_available");
      expect(text(r), name).toContain("not_available");
    }
    // 业务 404（假服务 v6 开着但任务不存在）仍是错误，不是 not_available
    const { client: c2, close: close2 } = await connect(svc.url, null);
    const nf = await c2.callTool({ name: "get_task", arguments: { taskId: "tsk_missing" } });
    expect(nf.isError).toBe(true);
    expect(sc(nf)["error"]).toBe("task_not_found");
    await close2();
    await close();
  });
});

describe("authorize_task（agent-wallet 限额内代签）", () => {
  it("无 wallet → agent_wallet_disabled；有 owner 签名参数时不需要 wallet", async () => {
    const { client, close } = await connect(svc.url, null);
    await client.callTool({ name: "create_task", arguments: { ...taskArgs, clientRequestId: "a1" } });
    const r = await client.callTool({ name: "authorize_task", arguments: { taskId: "tsk_a1" } });
    expect(sc(r)["error"]).toBe("agent_wallet_disabled");
    const withSig = await client.callTool({ name: "authorize_task", arguments: { taskId: "tsk_a1", signature: "0x11" } });
    expect(withSig.isError).toBeFalsy();
    expect(sc(withSig)["signedBy"]).toBe("owner");
    await close();
  });

  it("budgetCap 15 USDG > MAX_SPEND 0.05 → budget_exceeds_agent_limit，不签名不上送；MAX_SPEND 20 → 代签，签名可验，mandate 进心跳循环；owner 不符 → 拒绝", async () => {
    const small = wallet("0.05");
    const { client, close } = await connect(svc.url, small);
    await client.callTool({ name: "create_task", arguments: { ...taskArgs, clientRequestId: "a2" } });
    const before = svc.seen.length;
    const refused = await client.callTool({ name: "authorize_task", arguments: { taskId: "tsk_a2" } });
    expect(sc(refused)["error"]).toBe("budget_exceeds_agent_limit");
    expect(sc(refused)["budgetCapUsd"]).toBe("15");
    expect(svc.seen.slice(before).some((s) => s.path.endsWith("/authorize"))).toBe(false);
    await close();

    const big = wallet("20");
    const hb = new ExecutorHeartbeat(new VerifyClient({ baseUrl: svc.url, apiKey: "k", caller: OWNER }), big.address, 60_000, () => undefined);
    const { client: c2, close: close2 } = await connect(svc.url, big, hb);
    await c2.callTool({ name: "create_task", arguments: { ...taskArgs, clientRequestId: "a3" } });
    const okr = await c2.callTool({ name: "authorize_task", arguments: { taskId: "tsk_a3" } });
    expect(okr.isError).toBeFalsy();
    expect(sc(okr)["signedBy"]).toBe("agent-wallet");
    expect(sc(okr)["mandateId"]).toBe("mnd_task_tsk_a3");
    expect(hb.watching).toEqual(["mnd_task_tsk_a3"]);
    const sent = svc.seen.find((s) => s.path === "/v1/tasks/tsk_a3/authorize")!.body as { typedData: { domain: Record<string, unknown>; message: Record<string, string> }; signature: Hex };
    const m = sent.typedData.message;
    const valid = await verifyTypedData({ address: acct.address, domain: sent.typedData.domain as never, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: { ...m, budgetCap: BigInt(m["budgetCap"]!), perStepCap: BigInt(m["perStepCap"]!), maxSteps: Number(m["maxSteps"]), validFrom: BigInt(m["validFrom"]!), deadline: BigInt(m["deadline"]!), nonce: BigInt(m["nonce"]!) } as never, signature: sent.signature });
    expect(valid).toBe(true);
    // owner 不符：typedData 指定别人的 owner
    const foreign = await c2.callTool({ name: "authorize_task", arguments: { taskId: "tsk_a3", typedData: { ...sent.typedData, types: {}, primaryType: "TradeMandate", message: { ...m, owner: OTHER } } } });
    expect(sc(foreign)["error"]).toBe("owner_mismatch");
    // 错链
    const wrongChain = await c2.callTool({ name: "authorize_task", arguments: { taskId: "tsk_a3", typedData: { ...sent.typedData, types: {}, primaryType: "TradeMandate", domain: { ...sent.typedData.domain, chainId: 1 } } } });
    expect(sc(wrongChain)["error"]).toBe("chain_not_allowed");
    await close2();
  });
});

describe("执行器心跳", () => {
  it("循环按间隔向 /v1/mandates/:id/executor/heartbeat 发 POST（204）；unwatch 后停止；mandate_not_found 自动移除", async () => {
    const hb = new ExecutorHeartbeat(new VerifyClient({ baseUrl: svc.url, apiKey: "k", caller: OWNER }), OWNER, 30, () => undefined);
    hb.watch("mnd_hb");
    hb.start();
    await new Promise((r) => setTimeout(r, 120));
    hb.stop();
    const beats = svc.heartbeats.filter((h) => h.mandateId === "mnd_hb");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(hb.sent.every((s) => s.status === 204)).toBe(true);
    expect((svc.seen.find((s) => s.path === "/v1/mandates/mnd_hb/executor/heartbeat")!.body as { executor: string }).executor).toBe(OWNER);
    hb.unwatch("mnd_hb");
    expect(hb.watching).toEqual([]);
    // 端点未部署：not_available 但不抛
    const hbOld = new ExecutorHeartbeat(new VerifyClient({ baseUrl: old.url, apiKey: "k" }), OWNER, 60_000, () => undefined);
    expect(await hbOld.beat("mnd_x")).toEqual({ status: 404, notAvailable: true });
  });

  it("executor_heartbeat 工具：agent-wallet 模式下 watch 进循环并立即发一拍；watch=false 移除", async () => {
    const w = wallet("1");
    const hb = new ExecutorHeartbeat(new VerifyClient({ baseUrl: svc.url, apiKey: "k", caller: OWNER }), w.address, 60_000, () => undefined);
    const { client, close } = await connect(svc.url, w, hb);
    const r = await client.callTool({ name: "executor_heartbeat", arguments: { mandateId: "mnd_tool" } });
    expect(sc(r)["status"]).toBe(204);
    expect(sc(r)["watching"]).toEqual(["mnd_tool"]);
    const off = await client.callTool({ name: "executor_heartbeat", arguments: { mandateId: "mnd_tool", watch: false } });
    expect(sc(off)["watching"]).toEqual([]);
    await close();
  });
});
