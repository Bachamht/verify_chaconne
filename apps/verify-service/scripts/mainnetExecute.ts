/**
 * B4 主网执行（G-01 LIVE）：经 HTTP API 走完整链路，演示钱包（客户端角色 4）本地签名。
 *   create job → report → prepare-execution（服务用真实证明私钥签证书）→ 演示钱包签 TradeIntent
 *   → [EXECUTE=1 才继续] Guard.execute → submissions → 回执（精确 approve 在 prepare 之前做：证书 TTL ~30s）
 * 默认 dry-run：到签完意图为止，打印硬边界与证书，不发任何链上交易。
 * 环境：VERIFY_SERVICE_URL、VERIFY_API_KEY、VERIFY_CALLER（=演示钱包地址）、DEMO_USER_PRIVATE_KEY（来自 .qa-live/demo-wallet.env）、
 *       POLICY（默认 REFERENCE_CONTEXT）、POLICY_VERSION（默认 1.1.0 = 最新；1.0.0 在休市时段不接受 close_last_tick 参考）、AMOUNT_RAW（默认 5000000 = 5 USDG）、EXECUTE=1 才广播。
 *       SIDE=sell 走卖出方向（输入 AAPLx、输出 USDG，AMOUNT_RAW 按 18 位精度；`AMOUNT_RAW=all` = 卖掉钱包里全部输入代币）；
 *       INPUT_ASSET / OUTPUT_ASSET 可显式覆盖 assetKey。
 * 证据写 .probes/<ts>_MAINNET_execute.json（不入库）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EIP712_TYPES, intentDigest, makeDomain, type TradeIntent } from "@chaconne/core/verify";
import { GUARD_ABI } from "../src/execution/guardAbi";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";
const KEY = process.env["VERIFY_API_KEY"] ?? "";
const RPC = process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
const POLICY = process.env["POLICY"] ?? "REFERENCE_CONTEXT";
const POLICY_VERSION = process.env["POLICY_VERSION"] ?? "1.1.0";
const EXECUTE = process.env["EXECUTE"] === "1";
const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const SIDE = process.env["SIDE"] === "sell" ? "sell" : "buy";
const INPUT_ASSET = process.env["INPUT_ASSET"] ?? (SIDE === "sell" ? AAPLX : USDG);
const OUTPUT_ASSET = process.env["OUTPUT_ASSET"] ?? (SIDE === "sell" ? USDG : AAPLX);
const AMOUNT_ENV = process.env["AMOUNT_RAW"] ?? (SIDE === "sell" ? "all" : "5000000");
const OUT = join(process.cwd(), "..", "..", "OKX dev day", "probes");

const pk = process.env["DEMO_USER_PRIVATE_KEY"];
if (!pk) throw new Error("缺 DEMO_USER_PRIVATE_KEY（.qa-live/demo-wallet.env）");
const demo = privateKeyToAccount(pk as Hex);
const chain = { id: 196, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: demo, chain, transport: http(RPC) });

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${SERVICE}${path}`, { method, headers: { "content-type": "application/json", "x-api-key": KEY, "x-verify-caller": demo.address.toLowerCase() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const inputToken = getAddress(INPUT_ASSET.split(":")[2]!);
  // AMOUNT_RAW=all（卖出默认）：用钱包里输入代币的全部余额
  const AMOUNT =
    AMOUNT_ENV === "all"
      ? (await pub.readContract({ address: inputToken, abi: erc20Abi, functionName: "balanceOf", args: [demo.address] })).toString()
      : AMOUNT_ENV;
  if (BigInt(AMOUNT) <= 0n) throw new Error(`输入代币余额为 0（${inputToken}）`);
  const log: Record<string, unknown> = { mode: EXECUTE ? "LIVE" : "LIVE-DRYRUN", service: SERVICE, demoWallet: demo.address, side: SIDE, inputAsset: INPUT_ASSET, outputAsset: OUTPUT_ASSET, policy: POLICY, policyVersion: POLICY_VERSION, amountRaw: AMOUNT, at: new Date().toISOString() };
  console.info("demo wallet", demo.address, "| balances: OKB", (Number(await pub.getBalance({ address: demo.address })) / 1e18).toFixed(4), "| USDG", Number(await pub.readContract({ address: getAddress(USDG.split(":")[2]!), abi: erc20Abi, functionName: "balanceOf", args: [demo.address] })) / 1e6);

  /* 1. create job */
  const created = await api<Record<string, unknown>>("POST", "/v1/jobs", {
    clientRequestId: `mainnet-${SIDE}-${Date.now()}`,
    ownerAddress: demo.address,
    recipientAddress: demo.address,
    executionChainId: 196,
    inputAssetKey: INPUT_ASSET,
    outputAssetKey: OUTPUT_ASSET,
    amountInRaw: AMOUNT,
    mode: "exactIn",
    ...(SIDE === "sell" ? { side: "sell" as const } : {}),
    policyId: POLICY,
    policyVersion: POLICY_VERSION,
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: POLICY === "QUOTE_ONLY" ? null : 300,
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`create failed ${created.status} ${JSON.stringify(created.data)}`);
  const jobId = created.data["jobId"] as string;
  log["jobId"] = jobId;
  const lr = created.data["latestReport"] as Record<string, unknown>;
  console.info("job", jobId, "v1 verdict", lr["verdict"], "evidenceMode", created.data["evidenceMode"]);

  /* 2. report */
  const rep = await api<{ report: Record<string, unknown>; reportHash: string; evidence: unknown[] }>("GET", `/v1/jobs/${jobId}/report`);
  log["reportV1"] = { verdict: rep.data.report["verdict"], comparison: rep.data.report["comparisonStatus"], session: rep.data.report["marketSession"], reasons: rep.data.report["reasons"], reference: rep.data.report["reference"], reportHash: rep.data.reportHash, evidence: rep.data.evidence.length };
  console.info("report v1:", JSON.stringify(log["reportV1"], null, 1));

  /* 2b. EXECUTE：先备好精确授权。v5 起证书 TTL 仅 ~30s，approve 若放在 prepare 之后会把证书耗到过期（CertificateExpired）。
   *      只在 v1 报告已 eligible 时才授权；已有足额授权则跳过。 */
  let approveTx: Hex | null = null;
  if (EXECUTE && lr["verdict"] === "eligible") {
    const hz = (await (await fetch(`${SERVICE}/healthz`)).json()) as { guard?: string };
    if (!hz.guard) throw new Error("healthz 未回显 guard 地址");
    const guardAddr = getAddress(hz.guard);
    const token = inputToken; // 买入 = USDG，卖出 = 股票代币
    const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [demo.address, guardAddr] });
    if (allowance >= BigInt(AMOUNT)) {
      console.info("allowance already sufficient:", allowance.toString(), "— skip approve");
    } else {
      console.info("approve exact (before prepare)", { token, spender: guardAddr, amount: AMOUNT });
      approveTx = await wallet.sendTransaction({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [guardAddr, BigInt(AMOUNT)] }) });
      await pub.waitForTransactionReceipt({ hash: approveTx });
      console.info("approved", approveTx);
    }
  }

  /* 3. prepare execution */
  const prep = await api<Record<string, unknown>>("POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: `mainnet-${Date.now()}` });
  log["prepare"] = { status: prep.status, state: prep.data["state"], verdict: prep.data["verdict"], reasons: (prep.data["report"] as Record<string, unknown> | null)?.["reasons"], remaining: prep.data["refreshesRemaining"] };
  const exec = prep.data["execution"] as Record<string, unknown> | null;
  if (prep.status !== 200 || !exec) {
    console.info("not eligible for execution:", JSON.stringify(log["prepare"], null, 1));
    writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_MAINNET_execute.json`), JSON.stringify(log, null, 2));
    return;
  }
  const typed = exec["typedData"] as { domain: { chainId: number; verifyingContract: Hex }; message: Record<string, string> };
  const cert = exec["certificate"] as Record<string, string>;
  const intent = typed.message as unknown as TradeIntent;
  const guard = (exec["guardCall"] as { to: Hex }).to;
  const digest = intentDigest(makeDomain(196, guard), intent);
  if (digest !== cert["intentDigest"]) throw new Error("intentDigest mismatch between service and local computation");
  console.info("hard bounds:", { amountIn: intent.amountIn, minAmountOut: intent.minAmountOut, recipient: intent.recipient, router: intent.router, spender: intent.spender, deadline: intent.deadline, validUntil: exec["validUntil"], guard, signer: exec["attestationSigner"] });

  /* 4. sign intent (local demo wallet) */
  const intentSig = await wallet.signTypedData({ domain: { name: "ChaconneVerifyGuard", version: "1", chainId: 196, verifyingContract: guard }, types: EIP712_TYPES, primaryType: "TradeIntent", message: { ...intent, amountIn: BigInt(intent.amountIn), minAmountOut: BigInt(intent.minAmountOut), nonce: BigInt(intent.nonce), deadline: BigInt(intent.deadline) } });
  log["intentDigest"] = digest;
  log["intentSigned"] = true;

  if (!EXECUTE) {
    console.info("DRY-RUN: intent signed locally; not broadcasting. Set EXECUTE=1 to approve + execute on mainnet.");
    writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_MAINNET_execute.json`), JSON.stringify(log, null, 2));
    return;
  }

  /* 5. 核对授权（已在 2b 备好）+ execute */
  const approval = exec["approval"] as { token: Hex; spender: Hex; amount: string };
  if (approval.spender.toLowerCase() !== guard.toLowerCase()) throw new Error(`approval spender ${approval.spender} != guard ${guard}`);
  if (approval.amount !== intent.amountIn) throw new Error("approval amount != intent.amountIn");
  const allowanceNow = await pub.readContract({ address: approval.token, abi: erc20Abi, functionName: "allowance", args: [demo.address, guard] });
  if (allowanceNow < BigInt(approval.amount)) throw new Error(`allowance ${allowanceNow} < amountIn ${approval.amount}（2b 未授权？）`);
  const data = encodeFunctionData({
    abi: GUARD_ABI,
    functionName: "execute",
    args: [
      { ...intent, amountIn: BigInt(intent.amountIn), minAmountOut: BigInt(intent.minAmountOut), nonce: BigInt(intent.nonce), deadline: BigInt(intent.deadline) } as never,
      intentSig,
      { ...cert, issuedAt: BigInt(cert["issuedAt"]!), validUntil: BigInt(cert["validUntil"]!), signerEpoch: BigInt(cert["signerEpoch"]!) } as never,
      exec["certificateSignature"] as Hex,
      exec["routerCalldata"] as Hex,
    ],
  });
  let gas = 900_000n;
  try {
    const est = await pub.estimateGas({ account: demo, to: guard, data, value: 0n });
    gas = (est * 13n) / 10n;
    console.info("estimated gas", est.toString(), "→ limit", gas.toString());
  } catch (e) {
    throw new Error(`execute would revert (estimateGas): ${e instanceof Error ? e.message.slice(0, 400) : e}`);
  }
  const eh = await wallet.sendTransaction({ to: guard, data, value: 0n, gas });
  console.info("execute sent", eh);
  await api("POST", `/v1/jobs/${jobId}/submissions`, { attemptId: prep.data["attemptId"], txHash: eh, intentSignature: intentSig }); // 签名入证据包（否则 cert_N_intent_digest ❌）
  const rcpt = await pub.waitForTransactionReceipt({ hash: eh, timeout: 180_000 });
  let event: Record<string, unknown> | null = null;
  for (const l of rcpt.logs) {
    try {
      const d = decodeEventLog({ abi: GUARD_ABI, data: l.data, topics: l.topics });
      if (d.eventName === "GuardedExecution") event = Object.fromEntries(Object.entries(d.args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    } catch {
      /* other logs */
    }
  }
  log["execution"] = { approveTx: approveTx ?? "pre-existing allowance", executeTx: eh, status: rcpt.status, block: rcpt.blockNumber.toString(), gasUsed: rcpt.gasUsed.toString(), event };
  console.info(JSON.stringify(log["execution"], null, 1));
  writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_MAINNET_execute.json`), JSON.stringify(log, null, 2));
}

main().catch((e) => {
  console.error("mainnet execute failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
