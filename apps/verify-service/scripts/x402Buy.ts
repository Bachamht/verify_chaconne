/**
 * x402 买家端（I-05 / PRE-06 LIVE 验收）：用官方客户端 SDK（@okxweb3/x402-core client + @okxweb3/x402-evm ExactEvmScheme）
 * 以付款人私钥（演示钱包，客户端角色）向 verify-service 购买一份报告，并可选走 A2MCP 单端点。
 *   POST /v1/jobs → GET /report → 402 PAYMENT-REQUIRED → 签 EIP-3009 授权 → 重发带 PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE
 * 不广播交易：结算由 facilitator 代付 gas；本脚本只签授权。付款人余额不足时服务端应 402（verify 失败），不会扣款。
 * 环境：VERIFY_SERVICE_URL、VERIFY_API_KEY（/v1 路径需要；A2MCP 不需要）、PAYER_PRIVATE_KEY（默认取 DEMO_USER_PRIVATE_KEY）、
 *       POLICY（默认 QUOTE_ONLY）、A2MCP=1 走 /a2mcp/verify。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";
import type { Hex } from "viem";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";
const KEY = process.env["VERIFY_API_KEY"] ?? "";
const POLICY = process.env["POLICY"] ?? "QUOTE_ONLY";
const A2MCP = process.env["A2MCP"] === "1";
const pk = process.env["PAYER_PRIVATE_KEY"] ?? process.env["DEMO_USER_PRIVATE_KEY"];
if (!pk) throw new Error("缺 PAYER_PRIVATE_KEY / DEMO_USER_PRIVATE_KEY");
const payer = privateKeyToAccount(pk as Hex);
const OUT = join(process.cwd(), "..", "..", "OKX dev day", "probes");

export function buildClient(account: ReturnType<typeof privateKeyToAccount>, network: string): x402HTTPClient {
  const signer = toClientEvmSigner({ address: account.address, signTypedData: (m) => account.signTypedData(m as never) });
  const client = x402Client.fromConfig({ schemes: [{ network: network as never, client: new ExactEvmScheme(signer) }] });
  return new x402HTTPClient(client);
}

const body = {
  ownerAddress: payer.address,
  inputAssetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8",
  outputAssetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a",
  amountInRaw: "5000000",
  policyId: POLICY,
  maxSlippageBps: 50,
  maxPriceImpactBps: 100,
  maxReferenceDeviationBps: POLICY === "QUOTE_ONLY" ? null : 300,
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const log: Record<string, unknown> = { mode: "x402-client", service: SERVICE, payer: payer.address, policy: POLICY, a2mcp: A2MCP, at: new Date().toISOString() };
  const baseHeaders: Record<string, string> = { "content-type": "application/json", ...(KEY ? { "x-api-key": KEY, "x-verify-caller": payer.address.toLowerCase() } : {}) };

  let url: string;
  let init: RequestInit;
  if (A2MCP) {
    url = `${SERVICE}/a2mcp/verify`;
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  } else {
    const created = await fetch(`${SERVICE}/v1/jobs`, { method: "POST", headers: baseHeaders, body: JSON.stringify({ ...body, clientRequestId: `x402-${Date.now()}`, recipientAddress: payer.address, executionChainId: 196, mode: "exactIn", policyVersion: "1.0.0" }) });
    const cj = (await created.json()) as Record<string, unknown>;
    if (created.status !== 201 && created.status !== 200) throw new Error(`create ${created.status} ${JSON.stringify(cj)}`);
    log["jobId"] = cj["jobId"];
    url = `${SERVICE}/v1/jobs/${cj["jobId"]}/report`;
    init = { method: "GET", headers: baseHeaders };
  }

  const first = await fetch(url, init);
  log["firstStatus"] = first.status;
  if (first.status !== 402) {
    console.info("no paywall (status", first.status, ") — service is free or already paid");
    writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_X402_client.json`), JSON.stringify(log, null, 2));
    return;
  }
  const http = buildClient(payer, "eip155:1952");
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
  const req = required.accepts[0]!;
  log["challenge"] = { network: req.network, amount: req.amount, asset: req.asset, payTo: req.payTo, maxTimeoutSeconds: req.maxTimeoutSeconds, extra: req.extra };
  console.info("402 challenge:", log["challenge"]);
  const payload = await http.createPaymentPayload(required);
  const auth = (payload.payload as { authorization?: Record<string, string> }).authorization;
  log["authorization"] = auth ? { from: auth["from"], to: auth["to"], value: auth["value"], validBefore: auth["validBefore"] } : null;
  const payHeaders = http.encodePaymentSignatureHeader(payload);

  const second = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...payHeaders } });
  const text = await second.text();
  log["secondStatus"] = second.status;
  let settle: unknown = null;
  try {
    settle = http.getPaymentSettleResponse((n) => second.headers.get(n));
  } catch {
    settle = null;
  }
  log["settle"] = settle;
  log["responseHead"] = text.slice(0, 600);
  console.info("paid request →", second.status, "settle:", JSON.stringify(settle));
  console.info(text.slice(0, 400));
  writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_X402_client.json`), JSON.stringify(log, null, 2));
}

if (process.argv[1] && /x402Buy\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("x402 buy failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
