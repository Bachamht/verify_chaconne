/**
 * v5 端到端集成（I2）：真实服务 + 主网分叉 + PlanGuard 授权计划逐步执行。
 *   规划 → 选候选 → 用户签一次 TradeMandate → 登记 → prepare-step（服务签步骤证书）
 *   → 执行者精确授权 + executeStep（分叉）→ 提交 hash → 证据包 → 离线验证
 * 与 forkMandate.ts 的区别：证书由**运行中的服务**签发，全程走 HTTP，验证的是 C2+D2+F2+A2+B2 的接线。
 * 环境：VERIFY_SERVICE_URL、VERIFY_API_KEY、FORK_RPC_URL、PLANGUARD_ADDRESS、DEMO_USER_PRIVATE_KEY。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, getAddress, http, verifyTypedData, verifyMessage, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EIP712_TYPES_V2, makePlanGuardDomain, mandateDigest as mandateDigestOf, outputSetHash, verifyBundleOffline, type EvidenceBundle, type PlanReport, type TradeMandate } from "@chaconne/core/verify";
import { PLANGUARD_ABI } from "../src/execution/planGuardAbi";

/** viem 的 const-ABI 推导对本脚本的动态参数过严；这里按运行时 Abi 使用（编码正确性由 abi:drift 与合约测试保证） */
const PG = PLANGUARD_ABI as unknown as Abi;

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8795";
const KEY = process.env["VERIFY_API_KEY"] ?? "vk_local_web";
const RPC = process.env["FORK_RPC_URL"] ?? "http://127.0.0.1:8555";
const PLANGUARD = (process.env["PLANGUARD_ADDRESS"] ?? "") as Hex;
const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const NVDAX = "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const OUT = join(process.cwd(), "..", "..", "OKX dev day", "probes");

const pk = process.env["DEMO_USER_PRIVATE_KEY"];
if (!pk) throw new Error("缺 DEMO_USER_PRIVATE_KEY");
if (!PLANGUARD) throw new Error("缺 PLANGUARD_ADDRESS");
const owner = privateKeyToAccount(pk as Hex);
const chain = { id: 196, name: "X Layer fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: owner, chain, transport: http(RPC) });
const log: Record<string, unknown> = { mode: "FORK+LIVE-SERVICE", service: SERVICE, rpc: RPC, planGuard: PLANGUARD, owner: owner.address, at: new Date().toISOString() };

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${SERVICE}${path}`, { method, headers: { "content-type": "application/json", "x-api-key": KEY, "x-verify-caller": owner.address.toLowerCase() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}
const bal = (token: Hex) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] });

async function main() {
  mkdirSync(OUT, { recursive: true });
  const usdg = getAddress(USDG.split(":")[2]!);
  const aaplx = getAddress(AAPLX.split(":")[2]!);
  void NVDAX;
  console.info("owner", owner.address, "USDG", (Number(await bal(usdg)) / 1e6).toFixed(4), "AAPLx", String(await bal(aaplx)));

  /* 1. 规划 */
  const plan = await api<{ planId: string; plan: PlanReport | null; recommended: string | null; planHash: string }>("POST", "/v1/plans", {
    clientRequestId: `e2e-${Date.now()}`,
    ownerAddress: owner.address,
    recipientAddress: owner.address,
    executionChainId: 196,
    legs: [{ outputAssetKey: AAPLX, weightBps: 10000 }],
    budget: { inputAssetKeys: [USDG], amountInRaw: "6000000" },
    side: "buy",
    policyId: "REFERENCE_CONTEXT",
    policyVersion: "1.1.0",
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: 300,
    deadline: new Date(Date.now() + 3600_000).toISOString(),
    ladderBps: [10000, 5000],
  });
  if (plan.status >= 300) throw new Error(`plan ${plan.status} ${JSON.stringify(plan.data)}`);
  const report = plan.data.plan;
  console.info("plan", plan.data.planId, "候选", report?.candidates.length, "推荐", plan.data.recommended);
  for (const c of report?.candidates ?? []) console.info(`  ${c.candidateId} ${c.completionBps / 100}% → ${c.chosenPolicyVerdict} ${c.nextStep}`);
  log["plan"] = { planId: plan.data.planId, planHash: plan.data.planHash, recommended: plan.data.recommended, candidates: report?.candidates.map((c) => ({ id: c.candidateId, completionBps: c.completionBps, verdict: c.chosenPolicyVerdict, nextStep: c.nextStep })) };

  /* 2. 一次签署 TradeMandate（两步 × 每步 3 USDG） */
  const set = [aaplx]; // 授权输出集合 = legs 的输出代币（服务按 legs 重算 outputSetHash）
  const now = Math.floor(Date.now() / 1000);
  const mandate: TradeMandate = {
    owner: owner.address.toLowerCase() as Hex,
    recipient: owner.address.toLowerCase() as Hex,
    inputToken: usdg.toLowerCase() as Hex,
    outputSetHash: outputSetHash(set),
    budgetCap: "6000000",
    perStepCap: "3000000",
    maxSteps: "2",
    policyDefinitionHash: report!.policyDefinitionHash,
    effectivePolicyHash: report!.effectivePolicyHash,
    registryHash: report!.registryHash,
    validFrom: String(now - 60),
    deadline: String(now + 3600),
    nonce: String(BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"))),
  };
  const domain = makePlanGuardDomain(196, PLANGUARD);
  const typed = { domain: { name: domain.name, version: domain.version, chainId: 196, verifyingContract: PLANGUARD }, types: EIP712_TYPES_V2, primaryType: "TradeMandate" as const, message: mandate };
  const signature = await wallet.signTypedData({ ...typed, message: { ...mandate, budgetCap: BigInt(mandate.budgetCap), perStepCap: BigInt(mandate.perStepCap), maxSteps: Number(mandate.maxSteps), validFrom: BigInt(mandate.validFrom), deadline: BigInt(mandate.deadline), nonce: BigInt(mandate.nonce) } as never });
  const digest = mandateDigestOf(domain, mandate);
  console.info("mandate digest", digest);

  const reg = await api<Record<string, unknown>>("POST", "/v1/mandates", {
    clientRequestId: `e2e-mandate-${Date.now()}`,
    mandate,
    signature,
    inputAssetKey: USDG,
    legs: [{ outputAssetKey: AAPLX, weightBps: 10000 }],
    side: "buy",
    policyId: "REFERENCE_CONTEXT",
    policyVersion: "1.1.0",
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: 300,
    planId: plan.data.planId,
    sku: "task_bundle",
  });
  if (reg.status >= 300) throw new Error(`mandate ${reg.status} ${JSON.stringify(reg.data).slice(0, 400)}`);
  const mandateId = reg.data["mandateId"] as string;
  console.info("mandate", mandateId, reg.data["state"], "digest 一致:", (reg.data["mandateDigest"] as string)?.toLowerCase() === digest.toLowerCase());
  log["mandate"] = { mandateId, digest, state: reg.data["state"], budget: reg.data["budget"], serverDigestMatches: (reg.data["mandateDigest"] as string)?.toLowerCase() === digest.toLowerCase() };

  /* 3. 逐步执行 */
  const steps: Record<string, unknown>[] = [];
  for (let i = 0; i < 2; i++) {
    const prep = await api<Record<string, unknown>>("POST", `/v1/mandates/${mandateId}/prepare-step`, { refreshKey: `e2e-step-${i}-${Date.now()}` });
    if (prep.status !== 200) {
      console.info(`step ${i} 未就绪: ${prep.status}`, JSON.stringify(prep.data).slice(0, 300));
      steps.push({ stepIndex: i, prepared: false, status: prep.status, body: prep.data });
      break;
    }
    const step = prep.data["step"] as Record<string, string>;
    const cert = prep.data["certificate"] as Record<string, string>;
    const outputSet = (prep.data["outputSet"] as Hex[]) ?? set;
    console.info(`step ${i}: in=${step["amountIn"]} minOut=${step["minAmountOut"]} out=${step["outputToken"]} validUntil=${prep.data["validUntil"]}`);

    // 证书签名独立验证（不信任服务自述）
    const certOk = await verifyTypedData({
      address: prep.data["attestationSigner"] as Hex,
      domain: { name: "ChaconneVerifyPlanGuard", version: "1", chainId: 196, verifyingContract: PLANGUARD },
      types: EIP712_TYPES_V2,
      primaryType: "StepCertificate",
      message: { ...cert, issuedAt: BigInt(cert["issuedAt"]!), validUntil: BigInt(cert["validUntil"]!), signerEpoch: BigInt(cert["signerEpoch"]!) } as never,
      signature: prep.data["certificateSignature"] as Hex,
    });
    if (!certOk) throw new Error("步骤证书签名验证失败");

    // 分叉链的区块时间落后于真实时钟，证书会被判 CertificateNotYetValid；仅在分叉环境对齐时间（主网不需要）
    try {
      await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_setNextBlockTimestamp", params: [Math.floor(Date.now() / 1000)] }) });
      await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }) });
    } catch {
      /* 非分叉环境忽略 */
    }

    const approveHash = await wallet.sendTransaction({ to: usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PLANGUARD, BigInt(step["amountIn"]!)] }) });
    await pub.waitForTransactionReceipt({ hash: approveHash });

    const data = encodeFunctionData({
      abi: PG,
      functionName: "executeStep",
      args: [
        { ...mandate, budgetCap: BigInt(mandate.budgetCap), perStepCap: BigInt(mandate.perStepCap), maxSteps: Number(mandate.maxSteps), validFrom: BigInt(mandate.validFrom), deadline: BigInt(mandate.deadline), nonce: BigInt(mandate.nonce) },
        signature,
        outputSet,
        { ...step, stepIndex: Number(step["stepIndex"]), amountIn: BigInt(step["amountIn"]!), minAmountOut: BigInt(step["minAmountOut"]!), deadline: BigInt(step["deadline"]!) },
        { ...cert, issuedAt: BigInt(cert["issuedAt"]!), validUntil: BigInt(cert["validUntil"]!), signerEpoch: BigInt(cert["signerEpoch"]!) },
        prep.data["certificateSignature"] as Hex,
        prep.data["routerCalldata"] as Hex,
      ],
    });
    const gas = await pub.estimateGas({ account: owner, to: PLANGUARD, data, value: 0n });
    const hash = await wallet.sendTransaction({ to: PLANGUARD, data, gas: (gas * 13n) / 10n });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    let event: Record<string, string> | null = null;
    for (const l of rcpt.logs) {
      try {
        const d = decodeEventLog({ abi: PG, data: l.data, topics: l.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
        if (d.eventName === "MandateStep") event = Object.fromEntries(Object.entries(d.args).map(([k, v]) => [k, String(v)]));
      } catch {
        /* 其它日志 */
      }
    }
    console.info(`  tx ${hash} status=${rcpt.status} gas=${rcpt.gasUsed} received=${event?.["received"]} executor=${event?.["executor"]}`);
    const sub = await api(`POST` as string, `/v1/mandates/${mandateId}/steps/${Number(step["stepIndex"])}/submissions`, { txHash: hash });

    // 等服务端回执核实推进 stepsDone（需要确认数；分叉上手动出块加速）
    let advanced = false;
    for (let t = 0; t < 30 && !advanced; t++) {
      await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "evm_mine", params: [] }) }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
      const v = await api<Record<string, unknown>>("GET", `/v1/mandates/${mandateId}`);
      const done = (v.data["steps"] as { done: number } | undefined)?.done ?? 0;
      advanced = done > Number(step["stepIndex"]);
    }
    console.info(`  服务端确认推进: ${advanced}`);
    steps.push({ stepIndex: Number(step["stepIndex"]), prepared: true, certSignatureVerified: certOk, txHash: hash, status: rcpt.status, gasUsed: String(rcpt.gasUsed), event, submissionStatus: sub.status, serverAdvanced: advanced });
  }
  log["steps"] = steps;

  /* 4. 证据包 + 离线验证 */
  const view = await api<Record<string, unknown>>("GET", `/v1/mandates/${mandateId}`);
  console.info("mandate 状态", view.data["state"], "已用", JSON.stringify(view.data["budget"]), "步", JSON.stringify(view.data["steps"]));
  const bundleRes = await api<EvidenceBundle>("GET", `/v1/mandates/${mandateId}/bundle`);
  if (bundleRes.status !== 200) throw new Error(`bundle ${bundleRes.status} ${JSON.stringify(bundleRes.data).slice(0, 300)}`);
  const deps = {
    verifyTypedData: (a: { address: Hex; typedData: { domain: unknown; types: unknown; primaryType: string; message: unknown }; signature: Hex }) =>
      verifyTypedData({ address: a.address, domain: a.typedData.domain, types: a.typedData.types, primaryType: a.typedData.primaryType, message: a.typedData.message, signature: a.signature } as never),
    verifyMessage: (a: { address: Hex; raw: Hex; signature: Hex }) => verifyMessage({ address: a.address, message: { raw: a.raw }, signature: a.signature }),
  };
  const checks = await verifyBundleOffline(bundleRes.data, deps);
  const failed = checks.filter((c) => !c.ok);
  console.info(`\n证据包离线验证：${checks.length - failed.length}/${checks.length} 通过`);
  for (const c of checks) console.info(`  ${c.ok ? "✓" : "✗"} ${c.id}${c.detail ? " — " + c.detail : ""}`);

  // 篡改实验：改一个数字必须翻红
  const tampered = JSON.parse(JSON.stringify(bundleRes.data)) as EvidenceBundle;
  if (tampered.reports[0]?.normalizedQuote) tampered.reports[0].normalizedQuote.minOutRaw = "1";
  const after = await verifyBundleOffline(tampered, deps);
  const newlyFailed = after.filter((c) => !c.ok).map((c) => c.id).filter((id) => !failed.some((f) => f.id === id));
  console.info("篡改 minOutRaw 后新增失败项:", newlyFailed.join(", ") || "（无，异常！）");

  log["bundle"] = { size: JSON.stringify(bundleRes.data).length, bundleHash: bundleRes.data.bundleHash, checks: checks.map((c) => ({ id: c.id, ok: c.ok })), failed: failed.map((c) => c.id), tamperNewlyFailed: newlyFailed };
  log["final"] = { state: view.data["state"], budget: view.data["budget"], steps: view.data["steps"], usdg: String(await bal(usdg)), aaplx: String(await bal(aaplx)) };
  writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_E2E_mandate.json`), JSON.stringify(log, null, 2));
  console.info("\n完成。证据已写入 probes。");
}

main().catch((e) => {
  console.error("E2E 失败：", e instanceof Error ? e.message : e);
  writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_E2E_mandate_FAILED.json`), JSON.stringify({ ...log, error: e instanceof Error ? e.message : String(e) }, null, 2));
  process.exit(1);
});
