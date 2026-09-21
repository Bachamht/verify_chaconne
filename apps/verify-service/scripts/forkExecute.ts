/**
 * G-01 FORK：anvil 分叉 X Layer 主网 → 部署 Guard → 白名单 → 真实 OKX 路由 calldata → 双签名 → execute。
 * 只在本地分叉执行，不广播主网；OKX API 只读（swap 端点只返回 calldata）。
 * 用法：pnpm --filter @chaconne/verify-service fork:execute   （需 apps/verify-service/.env 的 OKX 凭据）
 * 证据：.probes/<ts>_FORK_execute.json（不入库）+ stdout 摘要。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, erc20Abi, getAddress, http, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeMinOutRaw, EIP712_TYPES, hashCanonical, intentDigest, makeDomain, POLICY_QUOTE_ONLY_V1, registryHash, type TradeIntent, type VerificationCertificate } from "@chaconne/core/verify";
import { OkxClient, swap as okxSwap } from "../src/adapters/okx/client";
import { checkRouteAgainstIntent } from "../src/adapters/okx/calldata";
import { createAttestationSigner } from "../src/attestation/signer";
import { GUARD_ABI } from "../src/execution/guardAbi";

const FORK_URL = process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const ROUTER = getAddress("0x7c5bee2a8091c3ef39072f64f18fac913060aeaf");
const SPENDER = getAddress("0x8b773d83bc66be128c60e07e17c8901f7a64f000");
const USDG = getAddress("0x4ae46a509f6b1d9056937ba4500cb143933d2dc8");
const AAPLX = getAddress("0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a");
const SELECTORS = ["0xf2c42696", "0x0c307f76"];
// anvil 默认账户（公开测试私钥，仅分叉本地使用）
const ADMIN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SIGNER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const OUT = join(process.cwd(), "..", "..", "OKX dev day", "probes");
mkdirSync(OUT, { recursive: true });

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
  try {
    const pub = createPublicClient({ transport: http(RPC) });
    const chainId = await pub.getChainId();
    if (chainId !== 196) throw new Error(`fork chainId ${chainId} ≠ 196`);
    const admin = privateKeyToAccount(ADMIN_PK);
    const user = privateKeyToAccount(USER_PK);
    const signerAcct = privateKeyToAccount(SIGNER_PK);
    const chain = { id: 196, name: "xlayer-fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
    const wAdmin = createWalletClient({ account: admin, chain, transport: http(RPC) });
    const wUser = createWalletClient({ account: user, chain, transport: http(RPC) });
    const forkBlock = await pub.getBlock();
    console.info("fork block", forkBlock.number, new Date(Number(forkBlock.timestamp) * 1000).toISOString());

    /* ---- 部署 Guard ---- */
    const art = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "packages", "verify-contracts", "out", "ChaconneVerifyGuard.sol", "ChaconneVerifyGuard.json"), "utf8")) as { bytecode: { object: Hex } };
    const deployHash = await wAdmin.deployContract({ abi: GUARD_ADMIN_ABI, bytecode: art.bytecode.object, args: [admin.address, signerAcct.address, 1n, 120n] });
    const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
    const guard = getAddress(deployRcpt.contractAddress!);
    console.info("guard deployed", guard);

    /* ---- 白名单（与 config/xlayer.json 同源） ---- */
    const registry = JSON.parse(readFileSync(join(process.cwd(), "config", "registry.xlayer.json"), "utf8"));
    const regHash = registryHash(registry);
    const policyHash = hashCanonical(POLICY_QUOTE_ONLY_V1);
    const effectiveHash = hashCanonical({ policyDefinitionHash: policyHash, params: { maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: null } });
    for (const [fn, args] of [
      ["setPolicy", [policyHash, true]],
      ["setRegistry", [regHash, true]],
      ["setToken", [USDG, true]],
      ["setToken", [AAPLX, true]],
      ["setRoute", [ROUTER, SPENDER, true]],
      ...SELECTORS.map((sel) => ["setSelector", [ROUTER, sel, true]] as [string, unknown[]]),
    ] as Array<[string, unknown[]]>) {
      const h = await wAdmin.writeContract({ address: guard, abi: GUARD_ADMIN_ABI, functionName: fn as never, args: args as never });
      await pub.waitForTransactionReceipt({ hash: h });
    }

    /* ---- 给测试用户 USDG：找一个持有者假扮转账 ---- */
    const latest = await pub.getBlockNumber();
    const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])[0];
    const logs: Awaited<ReturnType<typeof pub.getLogs>> = [];
    // X Layer RPC 限制 eth_getLogs 区间 ≤ 100 块：分窗扫最近 4000 块
    for (let to = latest; to > latest - 4000n && logs.length < 400; to -= 100n) {
      const chunk = await pub.getLogs({ address: USDG, event: transferEvent, fromBlock: to - 99n, toBlock: to });
      logs.push(...chunk);
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
    const fundData = { to: USDG, from: whale, data: `0xa9059cbb${user.address.slice(2).padStart(64, "0")}${(20_000_000n).toString(16).padStart(64, "0")}` };
    const fundTx = (await rpcCall("eth_sendTransaction", [fundData])) as { result?: Hex; error?: unknown };
    if (!fundTx.result) throw new Error(`fund failed: ${JSON.stringify(fundTx.error)}`);
    await pub.waitForTransactionReceipt({ hash: fundTx.result });
    await rpcCall("anvil_stopImpersonatingAccount", [whale]);
    const userUsdg = (await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [user.address] })) as bigint;
    console.info("user USDG", userUsdg.toString(), "(whale", whale, ")");

    /* ---- 真实 OKX swap calldata（userWalletAddress = guard） ---- */
    const okx = new OkxClient({ apiKey: process.env["OKX_API_KEY"] ?? "", secretKey: process.env["OKX_SECRET_KEY"] ?? "", passphrase: process.env["OKX_PASSPHRASE"] ?? "" });
    const amountIn = "5000000";
    const s = await okxSwap(okx, { chainIndex: "196", fromTokenAddress: USDG.toLowerCase(), toTokenAddress: AAPLX.toLowerCase(), amount: amountIn, slippagePercent: "0.5", userWalletAddress: guard, swapReceiverAddress: guard });
    const sd = s.data?.[0];
    if (!s.ok || !sd) throw new Error(`swap api failed: ${s.code} ${s.msg}`);
    const data = sd.tx.data as Hex;
    const check = checkRouteAgainstIntent(data, { inputToken: USDG.toLowerCase(), outputToken: AAPLX.toLowerCase(), amountInRaw: amountIn, deadlineUnix: Math.floor(Date.now() / 1000) + 60, expectedReceiver: guard });
    if (!check.ok || getAddress(sd.tx.to) !== ROUTER) throw new Error(`route check failed: ${check.reasons.join(",")} to=${sd.tx.to}`);
    const expectedOut = sd.routerResult.toTokenAmount;
    const minOut = computeMinOutRaw(expectedOut, 50);
    console.info("okx swap: expectedOut", expectedOut, "minOut", minOut, "api minReceive", sd.tx.minReceiveAmount, "impact", sd.routerResult.priceImpactPercent);

    /* ---- 双签名 ---- */
    const nowSec = Number(forkBlock.timestamp);
    const intent: TradeIntent = {
      owner: user.address.toLowerCase() as Hex,
      recipient: user.address.toLowerCase() as Hex,
      inputToken: USDG.toLowerCase() as Hex,
      outputToken: AAPLX.toLowerCase() as Hex,
      amountIn,
      minAmountOut: minOut,
      router: ROUTER.toLowerCase() as Hex,
      spender: SPENDER.toLowerCase() as Hex,
      calldataHash: keccak256(data),
      policyDefinitionHash: policyHash,
      effectivePolicyHash: effectiveHash,
      registryHash: regHash,
      evidenceHash: keccak256(s.rawHash),
      nonce: "12345",
      deadline: String(nowSec + 60),
    };
    const domain = makeDomain(196, guard.toLowerCase() as Hex);
    const digest = intentDigest(domain, intent);
    const intentSig = await wUser.signTypedData({ domain: { ...domain }, types: EIP712_TYPES, primaryType: "TradeIntent", message: { ...intent, amountIn: BigInt(intent.amountIn), minAmountOut: BigInt(intent.minAmountOut), nonce: BigInt(intent.nonce), deadline: BigInt(intent.deadline) } });
    const cert: VerificationCertificate = { intentDigest: digest, evidenceHash: intent.evidenceHash, policyDefinitionHash: policyHash, effectivePolicyHash: effectiveHash, issuedAt: String(nowSec), validUntil: String(nowSec + 60), signerEpoch: "1" };
    const signer = createAttestationSigner(SIGNER_PK, 1);
    const { signature: certSig } = await signer.signCertificate(196, guard.toLowerCase() as Hex, cert);

    /* ---- approve + execute ---- */
    const ah = await wUser.writeContract({ address: USDG, abi: erc20Abi, functionName: "approve", args: [guard, BigInt(amountIn)] });
    await pub.waitForTransactionReceipt({ hash: ah });
    const before = (await pub.readContract({ address: AAPLX, abi: erc20Abi, functionName: "balanceOf", args: [user.address] })) as bigint;
    const eh = await wUser.writeContract({
      address: guard,
      abi: GUARD_ABI,
      functionName: "execute",
      args: [
        { ...intent, amountIn: BigInt(intent.amountIn), minAmountOut: BigInt(intent.minAmountOut), nonce: BigInt(intent.nonce), deadline: BigInt(intent.deadline) } as never,
        intentSig,
        { ...cert, issuedAt: BigInt(cert.issuedAt), validUntil: BigInt(cert.validUntil), signerEpoch: BigInt(cert.signerEpoch) } as never,
        certSig,
        data,
      ],
      gas: 1_500_000n,
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash: eh });
    const after = (await pub.readContract({ address: AAPLX, abi: erc20Abi, functionName: "balanceOf", args: [user.address] })) as bigint;
    const guardUsdg = (await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [guard] })) as bigint;
    const guardAapl = (await pub.readContract({ address: AAPLX, abi: erc20Abi, functionName: "balanceOf", args: [guard] })) as bigint;
    const allowance = (await pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [guard, SPENDER] })) as bigint;
    let event: unknown = null;
    for (const l of rcpt.logs) {
      if (getAddress(l.address) !== guard) continue;
      try {
        const d = decodeEventLog({ abi: GUARD_ABI, data: l.data, topics: l.topics });
        if (d.eventName === "GuardedExecution") event = Object.fromEntries(Object.entries(d.args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
      } catch {
        /* other logs */
      }
    }
    const result = {
      mode: "FORK",
      forkUrl: FORK_URL,
      forkBlock: forkBlock.number.toString(),
      chainId,
      guard,
      router: ROUTER,
      spender: SPENDER,
      selector: data.slice(0, 10),
      status: rcpt.status,
      gasUsed: rcpt.gasUsed.toString(),
      amountIn,
      expectedOut,
      minOut,
      received: (after - before).toString(),
      guardResidualUsdg: guardUsdg.toString(),
      guardResidualAaplx: guardAapl.toString(),
      note: "AAPLx 为 rebasing 代币（份额×乘数），转账舍入可在 Guard 留下 ≤ 数 wei 粉尘；不计为用户资金，可由 owner rescue。",
      residualAllowance: allowance.toString(),
      event,
      okxRawHash: s.rawHash,
      at: new Date().toISOString(),
    };
    writeFileSync(join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}_FORK_execute.json`), JSON.stringify(result, null, 2));
    console.info(JSON.stringify(result, null, 2));
    const DUST = 1_000_000n; // 1e-12 AAPLx：rebasing 舍入上限
    if (rcpt.status !== "success" || after - before < BigInt(minOut) || guardUsdg !== 0n || guardAapl > DUST || allowance !== 0n) {
      throw new Error("FORK 执行断言失败");
    }
  } finally {
    kill();
  }
}

const GUARD_ADMIN_ABI = [
  ...GUARD_ABI,
  { type: "constructor", inputs: [{ name: "initialOwner", type: "address" }, { name: "initialSigner", type: "address" }, { name: "initialEpoch", type: "uint64" }, { name: "maxCertTtl", type: "uint64" }], stateMutability: "nonpayable" },
  { type: "function", name: "setPolicy", stateMutability: "nonpayable", inputs: [{ name: "h", type: "bytes32" }, { name: "e", type: "bool" }], outputs: [] },
  { type: "function", name: "setRegistry", stateMutability: "nonpayable", inputs: [{ name: "h", type: "bytes32" }, { name: "e", type: "bool" }], outputs: [] },
  { type: "function", name: "setToken", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "e", type: "bool" }], outputs: [] },
  { type: "function", name: "setRoute", stateMutability: "nonpayable", inputs: [{ name: "r", type: "address" }, { name: "s", type: "address" }, { name: "e", type: "bool" }], outputs: [] },
  { type: "function", name: "setSelector", stateMutability: "nonpayable", inputs: [{ name: "r", type: "address" }, { name: "sel", type: "bytes4" }, { name: "e", type: "bool" }], outputs: [] },
] as const;

main().catch((e) => {
  console.error("fork execute failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
