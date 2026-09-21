/** v2 工具：规划/模拟/商品/授权计划/步骤执行（注入 sendStepTx，无链）/证据包/战报；agent-wallet 门禁与额度 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Hex } from "viem";
import { EIP712_TYPES_V2, makePlanGuardDomain, mandateDigest, outputSetHash, stepDigest, type MandateStep, type TradeMandate } from "@chaconne/core/verify";
import { startFakeService } from "../../verify-sdk/test/fakeService";
import { VerifyClient } from "../src/client";
import { createVerifyMcpServer, TOOL_NAMES } from "../src/server";
import { TOOL_NAMES_V2 } from "../src/toolsV2";
import { AgentWallet, agentWalletConfigFromEnv, type StepTxArgs } from "../src/wallet";

/** 公开的 anvil 测试账户 #1（仅测试） */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const acct = privateKeyToAccount(KEY);
const OWNER = acct.address.toLowerCase() as Hex;
const IN = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const OUT = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const PLAN_GUARD = ("0x" + "55".repeat(20)) as Hex;

let svc: Awaited<ReturnType<typeof startFakeService>>;
let paidSvc: Awaited<ReturnType<typeof startFakeService>>;
beforeAll(async () => {
  svc = await startFakeService();
  paidSvc = await startFakeService({ priceUsd: "0.01", network: "eip155:196" });
});
afterAll(async () => {
  await svc.close();
  await paidSvc.close();
});

function makeWallet(sent: StepTxArgs[], maxSpend = "0.05", onchainSteps = 0) {
  const cfg = agentWalletConfigFromEnv({ AGENT_WALLET_PRIVATE_KEY: KEY, AGENT_WALLET_MAX_SPEND_USD: maxSpend, AGENT_WALLET_CHAIN_IDS: "196" })!;
  const reader = { steps: onchainSteps, revoked: false, async mandateSteps() { return { steps: this.steps, spent: "0", revoked: this.revoked }; }, async allowance() { return 0n; } };
  const wallet = new AgentWallet(cfg, async (args) => {
    sent.push(args);
    reader.steps += 1;
    return { txHash: ("0x" + "ab".repeat(32)) as Hex, gas: "600000", approveTxHash: ("0x" + "ac".repeat(32)) as Hex, receipt: { status: "success", blockNumber: "1", gasUsed: "551000", event: { spent: args.step["amountIn"]!, received: "1", refunded: "0" }, allowanceAfter: "0" } };
  }, reader);
  return Object.assign(wallet, { fakeReader: reader });
}

async function connect(url: string, wallet: AgentWallet | null) {
  const server = createVerifyMcpServer({ client: new VerifyClient({ baseUrl: url, apiKey: "k", caller: OWNER, payer: wallet?.payer ?? null }), wallet, chainId: 196 });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, unknown>;

describe("v2 工具注册", () => {
  it("20 个工具全部发现，v2 13 个含在内", async () => {
    const { client, close } = await connect(svc.url, null);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    for (const n of TOOL_NAMES_V2) expect(names).toContain(n);
    await close();
  });
});

describe("规划 / 模拟 / 商品 / 战报", () => {
  it("plan_trade → recommended；create_simulation 标 SIMULATION；get_products 4 个；create_share_card 默认私密", async () => {
    const { client, close } = await connect(svc.url, null);
    const goal = { clientRequestId: "pl1", ownerAddress: OWNER, legs: [{ outputAssetKey: OUT, weightBps: 10000 }], budget: { inputAssetKeys: [IN], amountInRaw: "10000000" }, policyId: "REFERENCE_CONTEXT", maxSlippageBps: 50, maxPriceImpactBps: 100, deadline: new Date(Date.now() + 3600_000).toISOString() };
    const plan = await client.callTool({ name: "plan_trade", arguments: goal });
    expect(plan.isError).toBeFalsy();
    expect((sc(plan)["plan"] as Record<string, unknown>)["recommended"]).toBe("cand_0_10000");
    const sent = svc.seen.at(-1)!.body as Record<string, unknown>;
    expect(sent["recipientAddress"]).toBe(OWNER);
    expect(sent["side"]).toBe("buy");
    const sim = await client.callTool({ name: "create_simulation", arguments: { ...goal, clientRequestId: "s1" } });
    expect(sc(sim)["mode"]).toBe("SIMULATION");
    const prods = await client.callTool({ name: "get_products", arguments: {} });
    expect((sc(prods)["products"] as unknown[]).length).toBe(4);
    const share = await client.callTool({ name: "create_share_card", arguments: { kind: "job", id: "job_x" } });
    expect(sc(share)["shareId"]).toBe("sh_1");
    const shareBody = svc.seen.at(-1)!.body as Record<string, unknown>;
    expect(shareBody["public"]).toBe(false);
    expect((shareBody["privacy"] as Record<string, string>)["wallet"]).toBe("hidden");
    await close();
  });
});

describe("授权计划：prepare → sign → register → execute_next_step", () => {
  const mandateArgs = { ownerAddress: OWNER, planGuard: PLAN_GUARD, inputAssetKey: IN, outputAssetKeys: [OUT, "eip155:196:0x0d3db2d6a4ca2c2b6a2ae9d4e2c3f7e6a1b2c3d4"], budgetCap: "10000000", perStepCap: "5000000", maxSteps: 2, policyDefinitionHash: "0x" + "11".repeat(32), effectivePolicyHash: "0x" + "12".repeat(32), registryHash: "0x" + "13".repeat(32), deadline: 9999999999, nonce: "7" };

  it("prepare_mandate 产出可签 typedData（outputSetHash 排序去重、digest 与 core 一致）；无 wallet 时 register signLocally 拒绝、execute 拒绝", async () => {
    const { client, close } = await connect(svc.url, null);
    const prep = await client.callTool({ name: "prepare_mandate", arguments: mandateArgs });
    expect(prep.isError).toBeFalsy();
    const td = sc(prep)["typedData"] as { domain: { chainId: number; verifyingContract: Hex; name: string }; message: TradeMandate };
    expect(td.domain.name).toBe("ChaconneVerifyPlanGuard");
    expect(sc(prep)["outputSet"]).toEqual(["0x0d3db2d6a4ca2c2b6a2ae9d4e2c3f7e6a1b2c3d4", OUT.split(":")[2]]);
    expect(td.message.outputSetHash).toBe(outputSetHash(sc(prep)["outputSet"] as Hex[]));
    expect(sc(prep)["mandateDigest"]).toBe(mandateDigest(makePlanGuardDomain(196, PLAN_GUARD), td.message));
    expect(sc(prep)["agentWalletCanSign"]).toBe(false);
    const bad = await client.callTool({ name: "prepare_mandate", arguments: { ...mandateArgs, perStepCap: "20000000" } });
    expect(bad.isError).toBe(true);
    const reg = await client.callTool({ name: "register_mandate", arguments: { typedData: td, signLocally: true } });
    expect(reg.isError).toBe(true);
    expect(sc(reg)["error"]).toBe("agent_wallet_disabled");
    const exec = await client.callTool({ name: "execute_next_step", arguments: { mandateId: "mnd_1", mandate: td, mandateSignature: "0x11", outputSet: sc(prep)["outputSet"] } });
    expect(sc(exec)["error"]).toBe("agent_wallet_disabled");
    await close();
  });

  it("agent-wallet：register signLocally 签名可验；execute_next_step 本地核对通过 → 发送 → 提交 hash；篡改后的步骤被本地拒绝；错链拒绝", async () => {
    const sent: StepTxArgs[] = [];
    const wallet = makeWallet(sent);
    const { client, close } = await connect(svc.url, wallet);
    const prep = await client.callTool({ name: "prepare_mandate", arguments: { ...mandateArgs, outputAssetKeys: [OUT] } });
    const td = sc(prep)["typedData"] as { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: "TradeMandate"; message: TradeMandate };
    expect(sc(prep)["agentWalletCanSign"]).toBe(true);
    const reg = await client.callTool({ name: "register_mandate", arguments: { typedData: td, signLocally: true, sku: "task_bundle" } });
    expect(reg.isError).toBeFalsy();
    const mandateId = sc(reg)["mandateId"] as string;
    const sig = (svc.seen.at(-1)!.body as { signature: Hex }).signature;
    expect(await verifyTypedData({ address: acct.address, domain: td.domain as never, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: { ...td.message, budgetCap: 10000000n, perStepCap: 5000000n, maxSteps: 2, validFrom: BigInt(td.message.validFrom), deadline: BigInt(td.message.deadline), nonce: 7n }, signature: sig })).toBe(true);

    // 假服务的 prepare-step 用固定 mandateDigest 0x22…，本地核对必须拒绝（digest 不符）
    const outputSet = sc(prep)["outputSet"] as Hex[];
    const rejected = await client.callTool({ name: "execute_next_step", arguments: { mandateId, mandate: td, mandateSignature: sig, outputSet } });
    expect(sc(rejected)["error"]).toBe("step_rejected_locally");
    expect(String(sc(rejected)["message"])).toContain("mandateDigest");
    expect(sent.length).toBe(0);

    // 让假服务返回与本地一致的步骤：用真实 digest 重写响应（通过一次性中间层）
    const realMd = mandateDigest(makePlanGuardDomain(196, PLAN_GUARD), td.message);
    const patched = await startFakeService();
    const origFetch = fetch;
    const client2 = new VerifyClient({
      baseUrl: patched.url,
      apiKey: "k",
      caller: OWNER,
      fetchImpl: async (input, init) => {
        const res = await origFetch(input, init);
        if (String(input).endsWith("/prepare-step") && res.status === 200) {
          const j = (await res.json()) as Record<string, unknown>;
          const step = { ...(j["step"] as MandateStep), mandateDigest: realMd };
          const sd = stepDigest(makePlanGuardDomain(196, PLAN_GUARD), step);
          const cert = { ...(j["certificate"] as Record<string, string>), stepDigest: sd };
          return new Response(JSON.stringify({ ...j, step, stepDigest: sd, certificate: cert, typedData: { ...(j["typedData"] as object), message: step } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return res;
      },
    });
    const server2 = createVerifyMcpServer({ client: client2, wallet, chainId: 196 });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server2.connect(st);
    const c2 = new Client({ name: "t2", version: "0" });
    await c2.connect(ct);
    const reg2 = await c2.callTool({ name: "register_mandate", arguments: { typedData: td, signature: sig } });
    const id2 = sc(reg2)["mandateId"] as string;
    const dry = await c2.callTool({ name: "execute_next_step", arguments: { mandateId: id2, mandate: td, mandateSignature: sig, outputSet, expectedStepIndex: 0, dryRun: true } });
    expect(dry.isError).toBeFalsy();
    expect(sc(dry)["executed"]).toBe(false);
    const done = await c2.callTool({ name: "execute_next_step", arguments: { mandateId: id2, mandate: td, mandateSignature: sig, outputSet, expectedStepIndex: 0 } });
    expect(done.isError).toBeFalsy();
    expect(sc(done)["executed"]).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]!.planGuard).toBe(PLAN_GUARD);
    expect(sent[0]!.step["stepIndex"]).toBe("0");
    expect((sc(done)["submission"] as Record<string, unknown>)["state"]).toBe("SUBMITTED");
    expect((sc(done)["receipt"] as Record<string, unknown>)["allowanceAfter"]).toBe("0");
    expect(sent[0]!.outputSet).toEqual(outputSet);
    expect(patched.seen.filter((s) => /\/steps\/0\/submissions$/.test(s.path)).length).toBe(1);
    // 链上步序与服务端不同步（链上已 5 步，服务给 step 1）→ 拒绝，不发送
    wallet.fakeReader.steps = 5;
    const stale = await c2.callTool({ name: "execute_next_step", arguments: { mandateId: id2, mandate: td, mandateSignature: sig, outputSet } });
    expect(sc(stale)["error"]).toBe("step_index_onchain_mismatch");
    expect(sent.length).toBe(1);
    wallet.fakeReader.revoked = true;
    wallet.fakeReader.steps = 1;
    const revoked = await c2.callTool({ name: "execute_next_step", arguments: { mandateId: id2, mandate: td, mandateSignature: sig, outputSet } });
    expect(sc(revoked)["error"]).toBe("mandate_revoked_onchain");
    wallet.fakeReader.revoked = false;
    // 期望步骤序号不符 → 拒绝
    const wrongIdx = await c2.callTool({ name: "execute_next_step", arguments: { mandateId: id2, mandate: td, mandateSignature: sig, outputSet, expectedStepIndex: 5 } });
    expect(sc(wrongIdx)["error"]).toBe("step_rejected_locally");
    // 错链：mandate domain chainId=1952，钱包只允许 196
    const td1952 = { ...td, domain: { ...td.domain, chainId: 1952 } };
    const wrongChain = await c2.callTool({ name: "execute_next_step", arguments: { mandateId: id2, mandate: td1952, mandateSignature: sig, outputSet } });
    expect(String(sc(wrongChain)["message"])).toContain("not allowed");
    await c2.close();
    await server2.close();
    await patched.close();
    await close();
  });

  it("get_mandate / pause / resume / cancel / get_evidence_bundle", async () => {
    const { client, close } = await connect(svc.url, null);
    const reg = await client.callTool({ name: "register_mandate", arguments: { typedData: { domain: {}, types: {}, primaryType: "TradeMandate", message: { owner: OWNER, maxSteps: "2", perStepCap: "1" } }, signature: "0x11" } });
    const id = sc(reg)["mandateId"] as string;
    expect(sc(await client.callTool({ name: "pause_mandate", arguments: { mandateId: id } }))["state"]).toBe("PAUSED");
    expect(sc(await client.callTool({ name: "resume_mandate", arguments: { mandateId: id } }))["state"]).toBe("ACTIVE");
    expect(sc(await client.callTool({ name: "get_mandate", arguments: { mandateId: id } }))["state"]).toBe("ACTIVE");
    expect(sc(await client.callTool({ name: "cancel_mandate", arguments: { mandateId: id } }))["state"]).toBe("CANCELLED");
    const b = await client.callTool({ name: "get_evidence_bundle", arguments: { kind: "mandate", id } });
    expect(sc(b)["kind"]).toBe("mandate");
    const nf = await client.callTool({ name: "get_mandate", arguments: { mandateId: "mnd_missing" } });
    expect(nf.isError).toBe(true);
    await close();
  });
});

describe("agent-wallet 自动付款与额度", () => {
  it("purchase_verification 在 agent-wallet 模式下自动付 $0.01（autoPaid）；超过 MAX_SPEND 后拒付 → 402 原样", async () => {
    const wallet = makeWallet([], "0.015");
    const { client, close } = await connect(paidSvc.url, wallet);
    const mk = async (id: string) => client.callTool({ name: "prepare_verification", arguments: { clientRequestId: id, ownerAddress: OWNER, inputAssetKey: IN, outputAssetKey: OUT, amountInRaw: "5000000", policyId: "QUOTE_ONLY", maxSlippageBps: 50 } });
    await mk("a1");
    const paid = await client.callTool({ name: "purchase_verification", arguments: { jobId: "job_a1" } });
    expect(sc(paid)["status"]).toBe(200);
    expect((sc(paid)["autoPaid"] as Record<string, unknown>)["amountUsdEstimate"]).toBe("0.01");
    expect(wallet.spentUsd).toBe("0.01");
    expect(paidSvc.settled.length).toBe(1);
    await mk("a2");
    const over = await client.callTool({ name: "purchase_verification", arguments: { jobId: "job_a2" } });
    expect(sc(over)["status"]).toBe(402);
    expect(wallet.spentUsd).toBe("0.01");
    expect(paidSvc.settled.length).toBe(1);
    expect(wallet.summary().remainingUsd).toBe("0.005");
    await close();
  });

  it("配置解析：三项全缺 → null；部分 → 抛错；坏 key/坏链 → 抛错", () => {
    expect(agentWalletConfigFromEnv({})).toBeNull();
    expect(() => agentWalletConfigFromEnv({ AGENT_WALLET_PRIVATE_KEY: KEY })).toThrow(/together/);
    expect(() => agentWalletConfigFromEnv({ AGENT_WALLET_PRIVATE_KEY: "0x12", AGENT_WALLET_MAX_SPEND_USD: "1", AGENT_WALLET_CHAIN_IDS: "196" })).toThrow(/64 hex/);
    expect(() => agentWalletConfigFromEnv({ AGENT_WALLET_PRIVATE_KEY: KEY, AGENT_WALLET_MAX_SPEND_USD: "1", AGENT_WALLET_CHAIN_IDS: "abc" })).toThrow(/csv/);
    const cfg = agentWalletConfigFromEnv({ AGENT_WALLET_PRIVATE_KEY: KEY, AGENT_WALLET_MAX_SPEND_USD: "2.5", AGENT_WALLET_CHAIN_IDS: "196, 1952" })!;
    expect(cfg.chainIds).toEqual([196, 1952]);
    const w = new AgentWallet(cfg);
    expect(w.address.toLowerCase()).toBe(OWNER);
    expect(w.reserve("2.5")).toBe(true);
    expect(w.reserve("0.000001")).toBe(false);
    expect(w.allowsChain(1952)).toBe(true);
    expect(w.allowsChain(1)).toBe(false);
  });
});
