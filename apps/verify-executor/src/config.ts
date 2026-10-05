/**
 * verify-executor 配置与启动护栏（v7 §1.1，D-089，SEC-06）：
 *   - 只允许 EXECUTOR_PRIVATE_KEY 一把私钥形态变量（eoa 模式）；okx_agentic 模式下连它也不许有；其它 *PRIVATE_KEY* / *SECRET_KEY* / MNEMONIC 一律拒启；
 *   - 执行身份地址 ∈ FORBIDDEN_EXECUTOR_ADDRESSES（签名者、部署者、商户、演示钱包）即拒启；
 *   - 交易白名单的代币集合来自登记表文件（只取 tokenAddress），PlanGuard 地址来自 env；不接受其它目标。
 * 错误信息里只出现地址，从不出现私钥。
 */
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseFeeCaps, type FeeCaps } from "@chaconne/verify-exec";

export interface ExecutorConfig {
  serviceUrl: string;
  apiKey: string;
  mode: "eoa" | "okx_agentic";
  account: PrivateKeyAccount | null;
  address: Hex;
  rpcUrl: string;
  chainId: number;
  planGuard: Hex;
  tokens: Set<string>;
  minOkbWei: bigint;
  /** 每笔费用上限（D-089 修订）：EXECUTOR_MAX_GAS_LIMIT / EXECUTOR_MAX_FEE_PER_GAS_WEI / EXECUTOR_MAX_PRIORITY_FEE_PER_GAS_WEI / EXECUTOR_MAX_FEE_PER_TX_WEI */
  feeCaps: FeeCaps;
  pollMs: number;
  minCertRemainingS: number;
  okxAgenticCli: string | null;
  version: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function assertExecutorEnv(env: NodeJS.ProcessEnv): void {
  const re = /(?:PRIVATE_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE)/i;
  const mode = env["EXECUTOR_MODE"] === "okx_agentic" ? "okx_agentic" : "eoa";
  const allowed = mode === "eoa" ? new Set(["EXECUTOR_PRIVATE_KEY"]) : new Set<string>();
  const offenders = Object.entries(env)
    .filter(([k, v]) => v && v.trim() && re.test(k) && !allowed.has(k))
    .map(([k]) => k);
  if (offenders.length) throw new Error(`verify-executor 只允许持有执行身份私钥 EXECUTOR_PRIVATE_KEY（eoa 模式）；检测到额外私钥形态变量：${offenders.join(", ")}（D-089）`);
}

export function loadExecutorConfig(env: NodeJS.ProcessEnv = process.env, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): ExecutorConfig {
  assertExecutorEnv(env);
  const problems: string[] = [];
  const mode = env["EXECUTOR_MODE"] === "okx_agentic" ? "okx_agentic" : env["EXECUTOR_MODE"] === undefined || env["EXECUTOR_MODE"] === "" || env["EXECUTOR_MODE"] === "eoa" ? "eoa" : null;
  if (!mode) problems.push("EXECUTOR_MODE 必须是 eoa 或 okx_agentic");
  const apiKey = (env["VERIFY_EXECUTOR_API_KEY"] ?? "").trim();
  if (!apiKey) problems.push("缺少 VERIFY_EXECUTOR_API_KEY");
  const planGuard = (env["PLANGUARD_ADDRESS"] ?? "").trim();
  if (!ADDR.test(planGuard)) problems.push("PLANGUARD_ADDRESS 非法");
  const chainId = Number(env["EXECUTION_CHAIN_ID"] ?? 196);
  if (!Number.isInteger(chainId) || chainId <= 0) problems.push("EXECUTION_CHAIN_ID 非法");
  let account: PrivateKeyAccount | null = null;
  let address: Hex | null = null;
  if (mode === "eoa") {
    const pk = (env["EXECUTOR_PRIVATE_KEY"] ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) problems.push("EXECUTOR_PRIVATE_KEY 缺失或格式非法（0x + 64 hex）");
    else {
      account = privateKeyToAccount(pk as Hex);
      address = account.address.toLowerCase() as Hex;
    }
  } else if (mode === "okx_agentic") {
    const a = (env["EXECUTOR_AGENTIC_ADDRESS"] ?? "").trim();
    if (!ADDR.test(a)) problems.push("okx_agentic 模式需要 EXECUTOR_AGENTIC_ADDRESS（Agentic Wallet 地址）");
    else address = a.toLowerCase() as Hex;
  }
  const forbidden = new Set((env["FORBIDDEN_EXECUTOR_ADDRESSES"] ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  for (const f of forbidden) if (!ADDR.test(f)) problems.push(`FORBIDDEN_EXECUTOR_ADDRESSES 含非法地址 ${f}`);
  if (address && forbidden.has(address)) problems.push(`执行身份地址 ${address} 属于禁止角色地址（签名者 / 部署者 / 商户 / 演示钱包），拒绝启动`);
  const tokens = new Set<string>();
  const regFile = (env["REGISTRY_FILE"] ?? "").trim();
  if (!regFile) problems.push("缺少 REGISTRY_FILE（交易白名单的代币集合）");
  else {
    try {
      const reg = JSON.parse(readFile(regFile)) as { chainId?: number; entries?: Array<{ tokenAddress?: string; chainId?: number }> };
      for (const e of reg.entries ?? []) if (e.tokenAddress && ADDR.test(e.tokenAddress) && (e.chainId ?? reg.chainId) === chainId) tokens.add(e.tokenAddress.toLowerCase());
      if (tokens.size === 0) problems.push("REGISTRY_FILE 里没有本链代币");
    } catch (e) {
      problems.push(`REGISTRY_FILE 读取失败：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }
  // 低余额停机阈值必须显式配置（运营者确认 2026-10-02：未配置拒绝启动；0 等于不设防）
  const minOkb = (env["EXECUTOR_MIN_OKB_WEI"] ?? "").trim();
  if (mode === "eoa" && !minOkb) problems.push("EXECUTOR_MIN_OKB_WEI 未配置：eoa 模式必须显式设置执行身份低余额停机阈值（wei，> 0）");
  else if (minOkb && (!/^\d+$/.test(minOkb) || BigInt(minOkb) <= 0n)) problems.push("EXECUTOR_MIN_OKB_WEI 必须是大于 0 的整数 wei");
  let feeCaps: FeeCaps | null = null;
  try {
    feeCaps = parseFeeCaps(env);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  if (problems.length) throw new Error(`verify-executor 配置护栏拒绝启动：${problems.join("；")}`);
  return {
    serviceUrl: (env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790").replace(/\/$/, ""),
    apiKey,
    mode: mode!,
    account,
    address: address!,
    rpcUrl: env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech",
    chainId,
    planGuard: planGuard.toLowerCase() as Hex,
    tokens,
    minOkbWei: BigInt(minOkb || "0"),
    feeCaps: feeCaps!,
    pollMs: Math.max(200, Number(env["EXECUTOR_POLL_MS"] ?? 1000) || 1000),
    minCertRemainingS: Math.max(1, Number(env["EXECUTOR_MIN_CERT_REMAINING_S"] ?? 8) || 8),
    okxAgenticCli: (env["OKX_AGENTIC_CLI"] ?? "").trim() || null,
    version: "verify-executor/0.1.0",
  };
}
