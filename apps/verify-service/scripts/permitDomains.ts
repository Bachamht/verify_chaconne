/**
 * v7 X2 · permit 域核实（开发计划 §2.3，CV-D20）：五个登记代币（USDG / USDC / USD₮0 / AAPLx / NVDAx）。
 *   1. 主网只读：name()、DOMAIN_SEPARATOR()、可选 version() / eip712Domain()（EIP-5267，部分代币回退，不依赖）；
 *   2. 候选域（version ∈ {"1","2"}、不含 version、version() 返回值）逐个重算，与链上 DOMAIN_SEPARATOR 完全相等才记录；
 *   3. 最终判据：本地 anvil 分叉上用一把**随机生成的一次性私钥**按匹配的域签 permit，由 anvil 默认账户代付调用 permit(...)，
 *      allowance 被设置即通过（permit 不要求余额）；记下交易哈希与是否发出 Approval 事件。
 * 只读主网 RPC；所有写操作只发生在本地分叉，不广播主网，不读任何真实私钥。
 * 输出：config/permit-domains.xlayer.json 草案（status = draft_pending_operator_approval；运营者批准后改为 approved 才生效）
 *       + stdout 摘要（the address-approval log (internal) 新节据此手写）。
 * 用法：pnpm --filter @chaconne/verify-service exec tsx scripts/permitDomains.ts
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, parseSignature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { matchPermitDomain, permitDomainCandidates, permitDomainSeparator, permitTypedData, type PermitDomain, type PermitDomainEntry, type PermitDomainsFile } from "@chaconne/core/verify";

const MAINNET_RPC = process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
const PORT = Number(process.env["PERMIT_FORK_PORT"] ?? 8551);
const FORK_RPC = `http://127.0.0.1:${PORT}`;
const SYMBOLS = ["USDG", "USDC", "USD₮0", "AAPLx", "NVDAx"];
/** anvil 默认账户 #2（公开测试私钥，只在本地分叉代付 gas） */
const RELAYER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ROOT = join(process.cwd(), "..", "..");
const OUT_FILE = join(process.cwd(), "config", "permit-domains.xlayer.json");
/**
 * 第二来源（2026-10-02 人工查阅，非链上推导；只作为记录，不参与匹配——匹配只认链上 DOMAIN_SEPARATOR 与分叉接受）。
 * 实现地址来自 EIP-1967 slot（USDC 为 FiatToken 的 implementation()）。
 */
const SECOND_SOURCES: Record<string, string> = {
  "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8": 'OKLink verified source of EIP-1967 implementation 0x50607322caa9ce5c27b8cc403c476838caaa9202 (contractName USDG): EIP712._makeDomainSeparator(name(), "1")',
  "0xb6ceceab302e2e4948951ee7843fc24e92933061": 'OKLink verified source of implementation 0x908cb63cded85ee69525e2f95f7f38da25ae0245 (FiatTokenV2_2): EIP712.makeDomainSeparator(name, "2", _chainId())',
  "0x779ded0c9e1022225f8e0630b35a9b54be713736": 'Sourcify exact_match (matchId 42408986) of EIP-1967 implementation 0x1ec7df9e74be05cb5a456aca2dc1ac2cec9ab6a3 (TetherTokenOFTExtension): ERC20PermitUpgradeable __EIP712_init_unchained(name, "1")',
  "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a": 'OKLink verified source of EIP-1967 implementation 0x65c40d624af3b18c109fbf87b7deff34cdc5f19b (BackedAutoFeeTokenImplementation): DOMAIN_SEPARATOR_VERSION = "1" (DOMAIN_SEPARATOR is a stored variable)',
  "0xc845b2894dbddd03858fd2d643b4ef725fe0849d": 'OKLink verified source of EIP-1967 implementation 0x65c40d624af3b18c109fbf87b7deff34cdc5f19b (BackedAutoFeeTokenImplementation): DOMAIN_SEPARATOR_VERSION = "1" (DOMAIN_SEPARATOR is a stored variable)',
};

const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

function startAnvil(): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const p = spawn("anvil", ["--fork-url", MAINNET_RPC, "--port", String(PORT), "--silent"], { stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => p.kill("SIGTERM");
    p.on("error", reject);
    const tryReady = async (n: number) => {
      try {
        const r = await fetch(FORK_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        if (r.ok) return resolve(kill);
      } catch {
        /* retry */
      }
      if (n > 60) return reject(new Error("anvil 未就绪"));
      setTimeout(() => void tryReady(n + 1), 1000);
    };
    void tryReady(0);
  });
}

async function main() {
  const registry = JSON.parse(readFileSync(join(process.cwd(), "config", "registry.xlayer.v1.2.json"), "utf8")) as { chainId: number; entries: Array<{ assetKey: string; tokenAddress: string; displaySymbol: string }> };
  const planGuardCfg = JSON.parse(readFileSync(join(ROOT, "packages", "verify-contracts", "config", "xlayer.planguard.json"), "utf8")) as { planGuard: Hex };
  const spender = planGuardCfg.planGuard.toLowerCase() as Hex;
  const tokens = SYMBOLS.map((s) => {
    const e = registry.entries.find((x) => x.displaySymbol === s);
    if (!e) throw new Error(`登记表里找不到 ${s}`);
    return { symbol: s, assetKey: e.assetKey.toLowerCase(), token: e.tokenAddress.toLowerCase() as Hex };
  });

  const main_ = createPublicClient({ transport: http(MAINNET_RPC) });
  const chainId = await main_.getChainId();
  if (chainId !== 196) throw new Error(`主网 chainId ${chainId} ≠ 196`);
  const verifiedBlock = await main_.getBlockNumber();
  const verifiedAt = new Date().toISOString();
  const probes: Array<{ symbol: string; assetKey: string; token: Hex; name: string; onchain: Hex; versionFn: string | null; eip712: unknown; matched: PermitDomain | null; candidates: Array<{ version: string | null; separator: Hex }> }> = [];
  for (const t of tokens) {
    const read = <T>(functionName: string, args: unknown[] = []) => main_.readContract({ address: t.token, abi: TOKEN_ABI, functionName: functionName as never, args: args as never, blockNumber: verifiedBlock }) as Promise<T>;
    const name = await read<string>("name");
    const onchain = (await read<Hex>("DOMAIN_SEPARATOR")).toLowerCase() as Hex;
    const versionFn = await read<string>("version").catch(() => null);
    const eip712 = await read<readonly unknown[]>("eip712Domain").then((r) => ({ name: r[1], version: r[2], chainId: String(r[3]), verifyingContract: r[4] })).catch((e: unknown) => ({ error: e instanceof Error ? e.message.split("\n")[0]!.slice(0, 120) : String(e) }));
    const extra = [versionFn, (eip712 as { version?: string }).version].filter((v): v is string => typeof v === "string" && v.length > 0);
    const cands = permitDomainCandidates(name, chainId, t.token, [...new Set(extra)]);
    const matched = matchPermitDomain(cands, onchain);
    probes.push({ ...t, name, onchain, versionFn, eip712, matched, candidates: cands.map((c) => ({ version: c.version, separator: permitDomainSeparator(c) })) });
    console.info(`${t.symbol} ${t.token} name=${JSON.stringify(name)} DOMAIN_SEPARATOR=${onchain} version()=${versionFn === null ? "n/a" : JSON.stringify(versionFn)} → matched ${matched ? JSON.stringify(matched.version) : "NONE"}`);
  }

  /* ---- 分叉接受 ---- */
  const kill = await startAnvil();
  const entries: PermitDomainEntry[] = [];
  const report: Array<Record<string, unknown>> = [];
  try {
    const pub = createPublicClient({ transport: http(FORK_RPC) });
    const forkBlock = await pub.getBlockNumber();
    const chain = { id: 196, name: "xlayer-fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [FORK_RPC] } } } as const;
    const relayer = createWalletClient({ account: privateKeyToAccount(RELAYER_PK), chain, transport: http(FORK_RPC) });
    for (const p of probes) {
      // 先试链上对拍匹配的域；没有匹配时逐个候选做真实接受（最终判据）
      const tryList: PermitDomain[] = p.matched ? [p.matched] : permitDomainCandidates(p.name, 196, p.token, p.versionFn ? [p.versionFn] : []);
      let accepted: { domain: PermitDomain; tx: Hex; block: number; approvalEvent: boolean; allowance: string } | null = null;
      const failures: string[] = [];
      for (const domain of tryList) {
        const owner = privateKeyToAccount(generatePrivateKey()); // 一次性随机私钥，用完即弃，不落盘
        const nonce = await pub.readContract({ address: p.token, abi: TOKEN_ABI, functionName: "nonces", args: [owner.address] });
        const head = await pub.getBlock();
        const deadline = head.timestamp + 1800n;
        const value = 1_000_000n;
        const td = permitTypedData(domain, { owner: owner.address.toLowerCase() as Hex, spender, value: value.toString(), nonce: nonce.toString(), deadline: deadline.toString() });
        const sig = await owner.signTypedData({ domain: td.domain as never, types: td.types as never, primaryType: "Permit", message: { owner: owner.address, spender, value, nonce, deadline } } as never);
        const { v, r, s, yParity } = parseSignature(sig);
        try {
          const hash = await relayer.writeContract({ address: p.token, abi: TOKEN_ABI, functionName: "permit", args: [owner.address, spender, value, deadline, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s] });
          const rcpt = await pub.waitForTransactionReceipt({ hash });
          const allowance = await pub.readContract({ address: p.token, abi: TOKEN_ABI, functionName: "allowance", args: [owner.address, spender] });
          let approvalEvent = false;
          for (const l of rcpt.logs) {
            try {
              const d = decodeEventLog({ abi: TOKEN_ABI, data: l.data, topics: l.topics });
              if (d.eventName === "Approval" && l.address.toLowerCase() === p.token && (d.args as { value: bigint }).value === value) approvalEvent = true;
            } catch {
              /* 其它事件 */
            }
          }
          if (rcpt.status === "success" && allowance === value) {
            accepted = { domain, tx: hash, block: Number(rcpt.blockNumber), approvalEvent, allowance: allowance.toString() };
            break;
          }
          failures.push(`version=${JSON.stringify(domain.version)}: status ${rcpt.status}, allowance ${allowance}`);
        } catch (e) {
          failures.push(`version=${JSON.stringify(domain.version)}: ${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : String(e)}`);
        }
      }
      report.push({ symbol: p.symbol, token: p.token, name: p.name, onchainDomainSeparator: p.onchain, versionFn: p.versionFn, eip712Domain: p.eip712, matchedVersion: p.matched ? p.matched.version : "NONE", separatorMatch: !!p.matched, forkBlock: Number(forkBlock), forkAcceptance: accepted ? { tx: accepted.tx, block: accepted.block, approvalEvent: accepted.approvalEvent, allowanceAfter: accepted.allowance, acceptedVersion: accepted.domain.version } : null, failures, candidates: p.candidates });
      if (p.matched && accepted && accepted.domain.version === p.matched.version) {
        entries.push({ assetKey: p.assetKey, token: p.token, name: p.name, version: p.matched.version, domainSeparator: p.onchain, verifiedBlock: Number(verifiedBlock), verifiedAt, forkAcceptance: { block: accepted.block, tx: accepted.tx }, sources: ["eth_call DOMAIN_SEPARATOR()", "eth_call name()", `local anvil fork permit() accepted (block ${accepted.block}${accepted.approvalEvent ? ", Approval emitted" : ", no Approval event"})`, ...(p.versionFn !== null ? ["eth_call version()"] : []), ...("version" in (p.eip712 as object) ? ["eth_call eip712Domain() (EIP-5267)"] : []), ...(SECOND_SOURCES[p.token] ? [SECOND_SOURCES[p.token]!] : [])] });
      }
      console.info(`${p.symbol}: separator match ${p.matched ? "yes" : "no"}; fork acceptance ${accepted ? `${accepted.tx} (block ${accepted.block}, Approval ${accepted.approvalEvent ? "yes" : "no"})` : `FAILED ${failures.join(" | ")}`}`);
    }
  } finally {
    kill();
  }
  const file: PermitDomainsFile & { status: string; generatedBy: string; spenderUsedOnFork: string } = { version: "permit-domains/1", chainId: 196, status: "draft_pending_operator_approval", generatedBy: "apps/verify-service/scripts/permitDomains.ts", spenderUsedOnFork: spender, entries };
  writeFileSync(OUT_FILE, `${JSON.stringify(file, null, 2)}\n`);
  console.info(`\nwrote ${OUT_FILE} (${entries.length}/${probes.length} entries)`);
  console.info(JSON.stringify({ verifiedBlock: Number(verifiedBlock), verifiedAt, report }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
