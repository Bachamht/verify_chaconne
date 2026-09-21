/**
 * v2 M-01/M-10 FORK：anvil 分叉 X Layer 主网 → 部署 PlanGuard → 白名单 → 用户一次签署 TradeMandate →
 * 真实 OKX 路由 calldata → 服务签步骤证书 → 第三方执行者提交两步买入（AAPLx、NVDAx）→ 第二份授权一步卖出（AAPLx→USDG，需 rebasing 输入容差）。
 * 只在本地分叉执行，不广播主网；OKX API 只读（swap 端点只返回 calldata）。
 * 用法：pnpm --filter @chaconne/verify-service fork:mandate   （需 apps/verify-service/.env 的 OKX 凭据；先 forge build）
 * 证据：.probes/<ts>_FORK_mandate.json（不入库）+ stdout 摘要。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, erc20Abi, getAddress, hashTypedData, http, keccak256, parseAbi, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeMinOutRaw, EIP712_TYPES_V2, hashCanonical, makePlanGuardDomain, mandateDigest, outputSetHash, POLICY_QUOTE_ONLY_V1, registryHash, stepCertificateDigest, stepDigest, type MandateStep, type StepCertificate, type TradeMandate } from "@chaconne/core/verify";
import { OkxClient, swap as okxSwap } from "../src/adapters/okx/client";
import { checkRouteAgainstIntent } from "../src/adapters/okx/calldata";

const FORK_URL = process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const ROUTER = getAddress("0x7c5bee2a8091c3ef39072f64f18fac913060aeaf");
const SPENDER = getAddress("0x8b773d83bc66be128c60e07e17c8901f7a64f000");
const USDG = getAddress("0x4ae46a509f6b1d9056937ba4500cb143933d2dc8");
const AAPLX = getAddress("0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a");
const NVDAX = getAddress("0xc845b2894dbddd03858fd2d643b4ef725fe0849d");
const SELECTORS = ["0xf2c42696", "0x0c307f76"];
const TOLERANCE = 1_000_000n; // 1e6 wei on rebasing stock inputs (sell direction)
// anvil 默认账户（公开测试私钥，仅分叉本地使用）
const ADMIN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SIGNER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const EXECUTOR_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

const OUT = join(process.cwd(), "..", "..", "OKX dev day", "probes");
mkdirSync(OUT, { recursive: true });
const lower = (a: string) => a.toLowerCase() as Hex;

function startAnvil(): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const p = spawn("anvil", ["--fork-url", FORK_URL, "--port", String(PORT), "--silent"], { stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => p.kill("SIGTERM");
    p.on("error", reject);
    const tryReady = async (n: number) => {
      try {
        const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        if (r.ok) return resolve(kill);
      } catch {
        /* retry */
      }
      if (n > 60) return reject(new Error("anvil 未就绪"));
      setTimeout(() => tryReady(n + 1), 1000);
    };
    void tryReady(0);
  });
}

async function rpcCall(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: unknown };
}

async function main() {
  const kill = await startAnvil();
  const log: Record<string, unknown> = { mode: "FORK", forkUrl: FORK_URL, at: new Date().toISOString(), steps: [] as unknown[] };
  try {
    const pub = createPublicClient({ transport: http(RPC) });
    const chainId = await pub.getChainId();
    if (chainId !== 196) throw new Error(`fork chainId ${chainId} ≠ 196`);
    const admin = privateKeyToAccount(ADMIN_PK);
    const user = privateKeyToAccount(USER_PK);
    const signerAcct = privateKeyToAccount(SIGNER_PK);
    const executorAcct = privateKeyToAccount(EXECUTOR_PK);
    const chain = { id: 196, name: "xlayer-fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
    const wAdmin = createWalletClient({ account: admin, chain, transport: http(RPC) });
    const wUser = createWalletClient({ account: user, chain, transport: http(RPC) });
    const wSigner = createWalletClient({ account: signerAcct, chain, transport: http(RPC) });
    const wExec = createWalletClient({ account: executorAcct, chain, transport: http(RPC) });
    const forkBlock = await pub.getBlock();
    log["forkBlock"] = forkBlock.number.toString();
    console.info("fork block", forkBlock.number, new Date(Number(forkBlock.timestamp) * 1000).toISOString());

    /* ---- 部署 PlanGuard ---- */
    const art = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "packages", "verify-contracts", "out", "ChaconneVerifyPlanGuard.sol", "ChaconneVerifyPlanGuard.json"), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const ABI = art.abi;
    const deployHash = await wAdmin.deployContract({ abi: ABI, bytecode: art.bytecode.object, args: [admin.address, signerAcct.address, 1n, 120n] });
    const guard = getAddress((await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!);
    log["planGuard"] = guard;
    console.info("planGuard deployed", guard);

    /* ---- 白名单（与 config/xlayer.planguard.json 同源） ---- */
    const registry = JSON.parse(readFileSync(join(process.cwd(), "config", "registry.xlayer.json"), "utf8"));
    const regHash = registryHash(registry);
    const policyHash = hashCanonical(POLICY_QUOTE_ONLY_V1);
    const effectiveHash = hashCanonical({ policyDefinitionHash: policyHash, params: { maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: null } });
    const cfg: Array<[string, unknown[]]> = [
      ["setPolicy", [policyHash, true]],
      ["setRegistry", [regHash, true]],
      ["setToken", [USDG, true]],
      ["setToken", [AAPLX, true]],
      ["setToken", [NVDAX, true]],
      ["setRoute", [ROUTER, SPENDER, true]],
      ...SELECTORS.map((sel) => ["setSelector", [ROUTER, sel, true]] as [string, unknown[]]),
      ["setInputShortfallTolerance", [AAPLX, TOLERANCE]],
      ["setInputShortfallTolerance", [NVDAX, TOLERANCE]],
    ];
    for (const [fn, args] of cfg) {
      const h = await wAdmin.writeContract({ address: guard, abi: ABI, functionName: fn, args });
      await pub.waitForTransactionReceipt({ hash: h });
    }

    /* ---- 给测试用户 USDG：找一个持有者假扮转账 ---- */
    const latest = await pub.getBlockNumber();
    const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])[0];
    const logs: Awaited<ReturnType<typeof pub.getLogs>> = [];
    for (let to = latest; to > latest - 4000n && logs.length < 400; to -= 100n) {
      logs.push(...(await pub.getLogs({ address: USDG, event: transferEvent, fromBlock: to - 99n, toBlock: to })));
    }
    const candidates = new Map<string, bigint>();
    for (const l of logs) {
      const args = (l as unknown as { args: { to: string; value?: bigint } }).args;
      candidates.set(args.to, (candidates.get(args.to) ?? 0n) + (args.value ?? 0n));
    }
    let whale: string | null = null;
    for (const [addr] of [...candidates.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1)).slice(0, 15)) {
      const bal = (await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(addr)] })) as bigint;
      if (bal >= 50_000_000n) {
        whale = getAddress(addr);
        break;
      }
    }
    if (!whale) throw new Error("找不到 USDG 持有者");
    await rpcCall("anvil_impersonateAccount", [whale]);
    await rpcCall("anvil_setBalance", [whale, "0x56BC75E2D63100000"]);
    const fundTx = (await rpcCall("eth_sendTransaction", [{ to: USDG, from: whale, data: `0xa9059cbb${user.address.slice(2).padStart(64, "0")}${(20_000_000n).toString(16).padStart(64, "0")}` }])) as { result?: Hex; error?: unknown };
    if (!fundTx.result) throw new Error(`fund failed: ${JSON.stringify(fundTx.error)}`);
    await pub.waitForTransactionReceipt({ hash: fundTx.result });
    await rpcCall("anvil_stopImpersonatingAccount", [whale]);
    const bal = async (token: Hex, who: Hex) => (await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
    console.info("user USDG", (await bal(USDG, user.address)).toString());

    const okx = new OkxClient({ apiKey: process.env["OKX_API_KEY"] ?? "", secretKey: process.env["OKX_SECRET_KEY"] ?? "", passphrase: process.env["OKX_PASSPHRASE"] ?? "" });
    const domain = makePlanGuardDomain(196, lower(guard));
    const viemDomain = { name: "ChaconneVerifyPlanGuard", version: "1", chainId: 196, verifyingContract: guard } as const;

    /* ---- 授权 A：买入，预算 10 USDG，单步 5，3 步，输出集 {AAPLx, NVDAx} ---- */
    const now = async () => Number((await pub.getBlock()).timestamp);
    const outputSetA = [lower(AAPLX), lower(NVDAX)].sort() as Hex[];
    const mandateA: TradeMandate = {
      owner: lower(user.address), recipient: lower(user.address), inputToken: lower(USDG), outputSetHash: outputSetHash(outputSetA),
      budgetCap: "10000000", perStepCap: "5000000", maxSteps: "3",
      policyDefinitionHash: policyHash, effectivePolicyHash: effectiveHash, registryHash: regHash,
      validFrom: String((await now()) - 10), deadline: String((await now()) + 3600), nonce: "1",
    };
    const signMandate = async (m: TradeMandate) => {
      const sig = await wUser.signTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: { ...m, budgetCap: BigInt(m.budgetCap), perStepCap: BigInt(m.perStepCap), maxSteps: Number(m.maxSteps), validFrom: BigInt(m.validFrom), deadline: BigInt(m.deadline), nonce: BigInt(m.nonce) } });
      const d = mandateDigest(domain, m);
      const onchain = (await pub.readContract({ address: guard, abi: ABI, functionName: "mandateDigest", args: [{ ...m, budgetCap: BigInt(m.budgetCap), perStepCap: BigInt(m.perStepCap), maxSteps: Number(m.maxSteps), validFrom: BigInt(m.validFrom), deadline: BigInt(m.deadline), nonce: BigInt(m.nonce) }] })) as Hex;
      if (onchain !== d) throw new Error(`mandateDigest mismatch TS ${d} vs chain ${onchain}`);
      return { sig, digest: d };
    };
    const mA = await signMandate(mandateA);
    const ah = await wUser.writeContract({ address: USDG, abi: erc20Abi, functionName: "approve", args: [guard, 10_000_000n] });
    await pub.waitForTransactionReceipt({ hash: ah });

    async function runStep(label: string, m: TradeMandate, mSig: Hex, set: Hex[], idx: number, inputToken: Hex, outputToken: Hex, amountIn: bigint, swapAmount: bigint) {
      const s = await okxSwap(okx, { chainIndex: "196", fromTokenAddress: inputToken, toTokenAddress: outputToken, amount: swapAmount.toString(), slippagePercent: "0.5", userWalletAddress: guard, swapReceiverAddress: guard });
      const sd = s.data?.[0];
      if (!s.ok || !sd) throw new Error(`${label}: swap api failed: ${s.code} ${s.msg}`);
      const data = sd.tx.data as Hex;
      const check = checkRouteAgainstIntent(data, { inputToken, outputToken, amountInRaw: swapAmount.toString(), deadlineUnix: (await now()) + 60, expectedReceiver: guard });
      if (!check.ok || getAddress(sd.tx.to) !== ROUTER) throw new Error(`${label}: route check failed: ${check.reasons.join(",")} to=${sd.tx.to} selector=${data.slice(0, 10)}`);
      const expectedOut = sd.routerResult.toTokenAmount;
      const minOut = computeMinOutRaw(expectedOut, 50);
      const t = await now();
      const step: MandateStep = { mandateDigest: mandateDigest(domain, m), stepIndex: String(idx), outputToken, amountIn: amountIn.toString(), minAmountOut: minOut, router: lower(ROUTER), spender: lower(SPENDER), calldataHash: keccak256(data), evidenceHash: keccak256(s.rawHash), deadline: String(t + 60) };
      const sDigest = stepDigest(domain, step);
      const stepMsg = { ...step, stepIndex: Number(step.stepIndex), amountIn: BigInt(step.amountIn), minAmountOut: BigInt(step.minAmountOut), deadline: BigInt(step.deadline) };
      if (hashTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "MandateStep", message: stepMsg }) !== sDigest) throw new Error("stepDigest TS≠viem");
      const cert: StepCertificate = { stepDigest: sDigest, evidenceHash: step.evidenceHash, policyDefinitionHash: policyHash, effectivePolicyHash: effectiveHash, issuedAt: String(t), validUntil: String(t + 60), signerEpoch: "1" };
      const certMsg = { ...cert, issuedAt: BigInt(cert.issuedAt), validUntil: BigInt(cert.validUntil), signerEpoch: BigInt(cert.signerEpoch) };
      const certSig = await wSigner.signTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "StepCertificate", message: certMsg });
      if (hashTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "StepCertificate", message: certMsg }) !== stepCertificateDigest(domain, cert)) throw new Error("certDigest TS≠viem");
      const mMsg = { ...m, budgetCap: BigInt(m.budgetCap), perStepCap: BigInt(m.perStepCap), maxSteps: Number(m.maxSteps), validFrom: BigInt(m.validFrom), deadline: BigInt(m.deadline), nonce: BigInt(m.nonce) };
      const recBefore = await bal(outputToken, user.address);
      const inBefore = await bal(inputToken, user.address);
      const execBefore = { in: await bal(inputToken, executorAcct.address), out: await bal(outputToken, executorAcct.address) };
      const gasEst = await pub.estimateContractGas({ address: guard, abi: ABI, functionName: "executeStep", args: [mMsg, mSig, set, stepMsg, certMsg, certSig, data], account: executorAcct.address });
      const eh = await wExec.writeContract({ address: guard, abi: ABI, functionName: "executeStep", args: [mMsg, mSig, set, stepMsg, certMsg, certSig, data], gas: (gasEst * 13n) / 10n });
      const rcpt = await pub.waitForTransactionReceipt({ hash: eh });
      let event: Record<string, unknown> | null = null;
      for (const l of rcpt.logs) {
        if (getAddress(l.address) !== guard) continue;
        try {
          const d = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics });
          if (d.eventName === "MandateStep") event = Object.fromEntries(Object.entries(d.args as unknown as Record<string, unknown>).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
        } catch {
          /* other logs */
        }
      }
      const state = (await pub.readContract({ address: guard, abi: ABI, functionName: "mandateState", args: [step.mandateDigest] })) as [bigint, number, boolean];
      const rec = { label, selector: data.slice(0, 10), status: rcpt.status, gasEstimate: gasEst.toString(), gasUsed: rcpt.gasUsed.toString(), amountIn: amountIn.toString(), swapAmount: swapAmount.toString(), expectedOut, minOut, apiMinReceive: sd.tx.minReceiveAmount, impact: sd.routerResult.priceImpactPercent, received: (await bal(outputToken, user.address) - recBefore).toString(), inputDelta: (inBefore - (await bal(inputToken, user.address))).toString(), executorDelta: { in: ((await bal(inputToken, executorAcct.address)) - execBefore.in).toString(), out: ((await bal(outputToken, executorAcct.address)) - execBefore.out).toString() }, mandateState: { spent: state[0].toString(), steps: state[1], revoked: state[2] }, guardResidual: { input: (await bal(inputToken, guard)).toString(), output: (await bal(outputToken, guard)).toString() }, allowance: ((await pub.readContract({ address: inputToken, abi: erc20Abi, functionName: "allowance", args: [guard, SPENDER] })) as bigint).toString(), event, okxRawHash: s.rawHash };
      (log["steps"] as unknown[]).push(rec);
      console.info(JSON.stringify(rec, null, 1));
      if (rcpt.status !== "success" || !event || BigInt(rec.received) < BigInt(minOut) || rec.executorDelta.in !== "0" || rec.executorDelta.out !== "0" || rec.allowance !== "0") throw new Error(`${label}: 断言失败`);
      return rec;
    }

    await runStep("A.step0 buy USDG→AAPLx", mandateA, mA.sig, outputSetA, 0, lower(USDG), lower(AAPLX), 5_000_000n, 5_000_000n);
    await runStep("A.step1 buy USDG→NVDAx", mandateA, mA.sig, outputSetA, 1, lower(USDG), lower(NVDAX), 5_000_000n, 5_000_000n);

    /* ---- 授权 B：卖出 AAPLx → USDG（rebasing 输入，容差 1e6 wei；路由数量 = amountIn − 容差） ---- */
    const aapl = await bal(AAPLX, user.address);
    const outputSetB = [lower(USDG)];
    const mandateB: TradeMandate = { ...mandateA, inputToken: lower(AAPLX), outputSetHash: outputSetHash(outputSetB), budgetCap: aapl.toString(), perStepCap: aapl.toString(), maxSteps: "1", nonce: "2" };
    const mB = await signMandate(mandateB);
    const bh = await wUser.writeContract({ address: AAPLX, abi: erc20Abi, functionName: "approve", args: [guard, aapl] });
    await pub.waitForTransactionReceipt({ hash: bh });
    log["sellInputAaplx"] = aapl.toString();
    await runStep("B.step0 sell AAPLx→USDG", mandateB, mB.sig, outputSetB, 0, lower(AAPLX), lower(USDG), aapl, aapl - TOLERANCE);

    log["final"] = { userUsdg: (await bal(USDG, user.address)).toString(), userAaplx: (await bal(AAPLX, user.address)).toString(), userNvdax: (await bal(NVDAX, user.address)).toString(), guardUsdg: (await bal(USDG, guard)).toString(), guardAaplx: (await bal(AAPLX, guard)).toString(), guardNvdax: (await bal(NVDAX, guard)).toString() };
    log["ok"] = true;
  } catch (e) {
    log["ok"] = false;
    log["error"] = e instanceof Error ? e.message.slice(0, 800) : String(e);
    throw e;
  } finally {
    kill();
    writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_FORK_mandate.json`), JSON.stringify(log, null, 2));
    console.info(JSON.stringify(log["final"] ?? log["error"], null, 1));
  }
}

main().catch((e) => {
  console.error("fork mandate failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
