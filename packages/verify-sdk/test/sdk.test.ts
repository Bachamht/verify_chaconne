/** SDK：类型化路径、鉴权头、402→自动付款→200（真实 EIP-3009 签名，进程内假服务校验授权字段）、额度拒付、授权计划流程 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { amountUsdEstimate, createClient, type VerifySdkClient } from "../src/index";
import { startFakeService } from "./fakeService";

/** 公开的 anvil 测试账户 #1（仅测试） */
const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const payer = privateKeyToAccount(PAYER_KEY);
const OWNER = payer.address;
const IN = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const OUT = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";

let free: Awaited<ReturnType<typeof startFakeService>>;
let paid: Awaited<ReturnType<typeof startFakeService>>;
beforeAll(async () => {
  free = await startFakeService();
  paid = await startFakeService({ priceUsd: "0.01" });
});
afterAll(async () => {
  await free.close();
  await paid.close();
});

describe("createClient", () => {
  it("免费服务：jobs.create 默认补 recipient/mode/chain/policyVersion；每个 /v1 请求带 key 与 caller；/healthz 不带 key", async () => {
    const c = createClient({ baseUrl: free.url, apiKey: "k", caller: OWNER.toLowerCase() });
    const created = await c.jobs.create({ clientRequestId: "r1", ownerAddress: OWNER, inputAssetKey: IN, outputAssetKey: OUT, amountInRaw: "5000000", policyId: "STRICT_LIVE", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300 });
    expect(created.status).toBe(201);
    const sent = free.seen.at(-1)!.body as Record<string, unknown>;
    expect(sent["recipientAddress"]).toBe(OWNER);
    expect(sent["mode"]).toBe("exactIn");
    expect(sent["executionChainId"]).toBe(196);
    expect(free.seen.at(-1)!.headers["x-api-key"]).toBe("k");
    expect(free.seen.at(-1)!.headers["x-verify-caller"]).toBe(OWNER.toLowerCase());
    const rep = await c.jobs.report("job_r1");
    expect(rep.status).toBe(200);
    expect(rep.paid).toBeNull();
    await c.healthz();
    expect(free.seen.at(-1)!.headers["x-api-key"]).toBeUndefined();
    const bundle = await c.jobs.bundle("job_r1");
    expect(bundle.body.kind).toBe("job");
    expect((await c.products()).body.products.length).toBe(4);
  });

  it("收费服务无 signer：report → 402 且带 paymentRequired；不重试", async () => {
    const c = createClient({ baseUrl: paid.url, apiKey: "k" });
    await c.jobs.create({ clientRequestId: "p0", ownerAddress: OWNER, inputAssetKey: IN, outputAssetKey: OUT, amountInRaw: "5000000", policyId: "QUOTE_ONLY", maxSlippageBps: 50, maxPriceImpactBps: 100 });
    const before = paid.seen.length;
    const rep = await c.jobs.report("job_p0");
    expect(rep.status).toBe(402);
    expect(rep.paymentRequired).toBeTruthy();
    expect(paid.seen.length - before).toBe(1);
  });

  it("收费服务有 signer：402 → 自动签 EIP-3009 → 200，授权可独立验签；onPayment 记账；同 job 再读不再付", async () => {
    const payments: string[] = [];
    const c = createClient({ baseUrl: paid.url, apiKey: "k", x402Signer: payer, onPayment: (ch) => payments.push(ch.amountUsdEstimate) });
    await c.jobs.create({ clientRequestId: "p1", ownerAddress: OWNER, inputAssetKey: IN, outputAssetKey: OUT, amountInRaw: "5000000", policyId: "QUOTE_ONLY", maxSlippageBps: 50, maxPriceImpactBps: 100 });
    const rep = await c.jobs.report("job_p1");
    expect(rep.status).toBe(200);
    expect(rep.paid?.amountRaw).toBe("10000");
    expect(rep.paid?.amountUsdEstimate).toBe("0.01");
    expect(rep.settle?.["success"]).toBe(true);
    expect(payments).toEqual(["0.01"]);
    expect(paid.settled.length).toBe(1);
    // 服务端收到的授权：from=payer, to=payTo, value=amount；签名可用 viem 独立验证
    const sig = paid.seen.at(-1)!.headers["payment-signature"]!;
    const payload = JSON.parse(Buffer.from(sig, "base64").toString()) as { payload: { authorization: Record<string, string>; signature: `0x${string}` } };
    const a = payload.payload.authorization;
    expect(a["from"]!.toLowerCase()).toBe(OWNER.toLowerCase());
    const ok = await verifyTypedData({
      address: OWNER,
      domain: { name: "USD₮0", version: "1", chainId: 1952, verifyingContract: "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c" },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: a["from"] as `0x${string}`, to: a["to"] as `0x${string}`, value: BigInt(a["value"]!), validAfter: BigInt(a["validAfter"]!), validBefore: BigInt(a["validBefore"]!), nonce: a["nonce"] as `0x${string}` },
      signature: payload.payload.signature,
    });
    expect(ok).toBe(true);
    const again = await c.jobs.report("job_p1");
    expect(again.status).toBe(200);
    expect(again.paid).toBeNull();
    expect(paid.settled.length).toBe(1);
  });

  it("onBeforePayment 返回 false → 不付款，原样 402", async () => {
    const c = createClient({ baseUrl: paid.url, apiKey: "k", x402Signer: payer, onBeforePayment: () => false });
    await c.jobs.create({ clientRequestId: "p2", ownerAddress: OWNER, inputAssetKey: IN, outputAssetKey: OUT, amountInRaw: "5000000", policyId: "QUOTE_ONLY", maxSlippageBps: 50, maxPriceImpactBps: 100 });
    const n = paid.settled.length;
    const rep = await c.jobs.report("job_p2");
    expect(rep.status).toBe(402);
    expect(rep.paid).toBeNull();
    expect(paid.settled.length).toBe(n);
  });

  it("授权计划流程：plans.create → toJob → mandates.create（签名）→ prepareStep READY → submitStep 202 → get；pause 后 prepare-step 409", async () => {
    const c: VerifySdkClient = createClient({ baseUrl: free.url, apiKey: "k", caller: OWNER });
    const plan = await c.plans.create({ clientRequestId: "pl1", ownerAddress: OWNER, recipientAddress: OWNER, executionChainId: 196, legs: [{ outputAssetKey: OUT, weightBps: 10000 }], budget: { inputAssetKeys: [IN], amountInRaw: "10000000" }, side: "buy", policyId: "REFERENCE_CONTEXT", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, deadline: new Date(Date.now() + 3600_000).toISOString() });
    expect(plan.status).toBe(201);
    expect((await c.plans.toJob("plan_pl1")).status).toBe(201);
    const message = { owner: OWNER, recipient: OWNER, inputToken: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", outputSetHash: "0x" + "22".repeat(32), budgetCap: "10000000", perStepCap: "5000000", maxSteps: "2", policyDefinitionHash: "0x" + "11".repeat(32), effectivePolicyHash: "0x" + "12".repeat(32), registryHash: "0x" + "13".repeat(32), validFrom: "1", deadline: "9999999999", nonce: "1" };
    const created = await c.mandates.create({ typedData: { domain: {}, types: {}, primaryType: "TradeMandate", message: message as never }, signature: "0x11" });
    expect(created.status).toBe(201);
    const id = (created.body as { mandateId: string }).mandateId;
    const step = await c.mandates.prepareStep(id);
    expect(step.body.status).toBe("READY");
    expect(step.body.step?.amountIn).toBe("5000000");
    expect((await c.mandates.submitStep(id, step.body.stepIndex!, ("0x" + "aa".repeat(32)) as `0x${string}`)).status).toBe(202);
    await c.mandates.pause(id);
    expect((await c.mandates.prepareStep(id)).status).toBe(409);
    await c.mandates.resume(id);
    expect((await c.mandates.get(id)).body).toMatchObject({ state: "ACTIVE" });
    expect((await c.shares.getPublic("sh_x")).status).toBe(200);
  });

  it("amountUsdEstimate", () => {
    expect(amountUsdEstimate("10000")).toBe("0.01");
    expect(amountUsdEstimate("1000000")).toBe("1");
    expect(amountUsdEstimate("1234567")).toBe("1.234567");
  });
});
