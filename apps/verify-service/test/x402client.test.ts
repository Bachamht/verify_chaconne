/** 官方 x402 客户端 SDK ↔ 本服务 402 闸门的契约（PRE-06 / P-01 客户端侧）：真实 EIP-3009 typed-data 签名，mock facilitator 只核 payTo/amount */
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import { api, createTestEnv, jobBody, TEST_MERCHANT } from "./helpers";

/** 公开的 anvil 测试账户 #1（仅测试） */
const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("x402 client SDK against the paywall", () => {
  it("402 → SDK 生成 EIP-3009 授权 → 200 + PAYMENT-RESPONSE；授权签名可独立验证；同凭证重放不重结算", async () => {
    const env = await createTestEnv({ priceUsd: "0.01" });
    const payer = privateKeyToAccount(PAYER_KEY);
    const signer = toClientEvmSigner({ address: payer.address, signTypedData: (m) => payer.signTypedData(m as never) });
    const http = new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network: "eip155:1952", client: new ExactEvmScheme(signer) }] }));

    const created = await api(env, "POST", "/v1/jobs", jobBody());
    const jobId = created.json["jobId"] as string;
    const first = await api(env, "GET", `/v1/jobs/${jobId}/report`);
    expect(first.status).toBe(402);

    const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
    const req = required.accepts[0]!;
    expect(req.network).toBe("eip155:1952");
    expect(req.payTo.toLowerCase()).toBe(TEST_MERCHANT);
    expect(req.amount).toBe("10000"); // $0.01 in 6-decimals
    expect(req.asset.toLowerCase()).toBe("0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c"); // X Layer testnet USD₮0 (SDK default)

    const payload = await http.createPaymentPayload(required);
    const inner = payload.payload as { signature: `0x${string}`; authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` } };
    expect(inner.authorization.from.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(inner.authorization.to.toLowerCase()).toBe(TEST_MERCHANT);
    expect(inner.authorization.value).toBe("10000");
    // 独立验证：EIP-3009 TransferWithAuthorization typed data 由付款人签
    const ok = await verifyTypedData({
      address: payer.address,
      domain: { name: req.extra?.["name"] as string, version: req.extra?.["version"] as string, chainId: 1952, verifyingContract: req.asset as `0x${string}` },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: inner.authorization.from as `0x${string}`, to: inner.authorization.to as `0x${string}`, value: BigInt(inner.authorization.value), validAfter: BigInt(inner.authorization.validAfter), validBefore: BigInt(inner.authorization.validBefore), nonce: inner.authorization.nonce },
      signature: inner.signature,
    });
    expect(ok).toBe(true);

    const headers = http.encodePaymentSignatureHeader(payload);
    const paid = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, headers);
    expect(paid.status).toBe(200);
    expect(paid.json["reportHash"]).toMatch(/^0x/);
    const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
    expect(settle.success).toBe(true);
    expect(settle.payer?.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(env.control.settleCalls).toBe(1);

    const replay = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, headers);
    expect(replay.status).toBe(200);
    expect(env.control.settleCalls).toBe(1);
    await env.close();
  });

  it("A2MCP 路径同样可用官方客户端付款", async () => {
    const env = await createTestEnv({ priceUsd: "0.01" });
    const payer = privateKeyToAccount(PAYER_KEY);
    const http = new x402HTTPClient(x402Client.fromConfig({ schemes: [{ network: "eip155:1952", client: new ExactEvmScheme(toClientEvmSigner({ address: payer.address, signTypedData: (m) => payer.signTypedData(m as never) })) }] }));
    const params = { ownerAddress: payer.address, inputAssetKey: jobBody().inputAssetKey, outputAssetKey: jobBody().outputAssetKey, amountInRaw: "5000000", policyId: "QUOTE_ONLY", maxSlippageBps: 50, maxPriceImpactBps: 100 };
    const first = await fetch(env.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
    expect(first.status).toBe(402);
    const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
    const payload = await http.createPaymentPayload(required);
    const second = await fetch(env.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json", ...http.encodePaymentSignatureHeader(payload) }, body: JSON.stringify(params) });
    expect(second.status).toBe(200);
    const j = (await second.json()) as Record<string, unknown>;
    expect(j["verdict"]).toBeDefined();
    expect(http.getPaymentSettleResponse((n) => second.headers.get(n)).success).toBe(true);
    await env.close();
  });
});
