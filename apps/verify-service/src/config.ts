/**
 * verify-service 配置（独立 .env，D-080）。
 * 环境组合护栏（验收 O-01）：fixture 证据/登记 不得与 真实收费/主网执行 同时启用；
 * 生产（NODE_ENV=production）禁止 fixture 模式。
 */
import { z } from "zod";
import { isEvmAddress } from "@chaconne/core/verify";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.string().optional().default("development"),
  VERIFY_HOST: z.string().optional().default("127.0.0.1"),
  VERIFY_PORT: z.coerce.number().int().optional().default(8790),
  PUBLIC_BASE_URL: z.string().optional().default(""),

  OKX_API_KEY: z.string().optional().default(""),
  OKX_SECRET_KEY: z.string().optional().default(""),
  OKX_PASSPHRASE: z.string().optional().default(""),
  OKX_FACILITATOR_BASE_URL: z.string().optional().default(""),
  OKX_API_BASE_URL: z.string().optional().default("https://web3.okx.com"),
  FINNHUB_API_KEY: z.string().optional().default(""),
  XLAYER_RPC_URL: z.string().optional().default("https://rpc.xlayer.tech"),

  PAYMENT_NETWORK: z.enum(["eip155:196", "eip155:1952"]).optional().default("eip155:1952"),
  MERCHANT_RECIPIENT_ADDRESS: z.string().optional().default(""),
  /** "0" = 免费；否则十进制美元串（如 "0.01"） */
  REPORT_PRICE_USD: z.string().regex(/^\d+(\.\d+)?$/).optional().default("0"),
  PAYMENT_MODE: z.enum(["okx", "mock"]).optional().default("okx"),

  ATTESTATION_PRIVATE_KEY: z.string().optional().default(""),
  SIGNER_EPOCH: z.coerce.number().int().min(0).optional().default(1),

  EXECUTION_CHAIN_ID: z.coerce.number().int().positive().optional().default(196),
  GUARD_ADDRESS: z.string().optional().default(""),
  ROUTER_ADDRESS: z.string().optional().default(""),
  SPENDER_ADDRESS: z.string().optional().default(""),

  REGISTRY_MODE: z.enum(["fixture", "file"]).optional().default("fixture"),
  REGISTRY_FILE: z.string().optional().default(""),
  EVIDENCE_MODE: z.enum(["fixture", "live"]).optional().default("fixture"),

  /** 逗号分隔 "key:callerId" */
  VERIFY_API_KEYS: z.string().optional().default(""),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).optional().default(60),

  ENTITLEMENT_MAX_REFRESHES: z.coerce.number().int().min(0).optional().default(2),
  ENTITLEMENT_WINDOW_SECONDS: z.coerce.number().int().min(10).optional().default(300),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).optional().default(15_000),
  SETTLE_POLL_DEADLINE_MS: z.coerce.number().int().min(100).optional().default(5000),
  /** 结算同步等待链上结果（OKX facilitator syncSettle）。LIVE 发现：异步模式下 verify 通过 + settle "pending" 但链上失败会导致先交付后失败，故默认同步 */
  SETTLE_SYNC: z.enum(["true", "false"]).optional().default("true"),
  /** 链上回执核实：轮询间隔、记 CONFIRMED 所需确认数、回执缺失多久后记 UNKNOWN */
  RECEIPT_INTERVAL_MS: z.coerce.number().int().min(1000).optional().default(10_000),
  RECEIPT_CONFIRMATIONS: z.coerce.number().int().min(1).optional().default(6),
  RECEIPT_UNKNOWN_AFTER_MS: z.coerce.number().int().min(1000).optional().default(10 * 60_000),

  /* ---- v2（升级执行计划 v5）---- */
  /** PlanGuard v2 合约地址（空 = 授权计划功能 503） */
  PLANGUARD_ADDRESS: z.string().optional().default(""),
  /** 商品价格（十进制美元串；审核期 0） */
  PRODUCT_PRICE_PLAN_USD: z.string().regex(/^\d+(\.\d+)?$/).optional().default("0"),
  PRODUCT_PRICE_MONITOR_WINDOW_USD: z.string().regex(/^\d+(\.\d+)?$/).optional().default("0"),
  PRODUCT_PRICE_TASK_BUNDLE_USD: z.string().regex(/^\d+(\.\d+)?$/).optional().default("0"),
  /** 监测窗口有效期（秒） */
  MONITOR_WINDOW_SECONDS: z.coerce.number().int().min(60).optional().default(24 * 3600),
  /** monitor 轮询间隔：常规时段 / 休市 */
  MONITOR_INTERVAL_REGULAR_MS: z.coerce.number().int().min(1000).optional().default(30_000),
  MONITOR_INTERVAL_CLOSED_MS: z.coerce.number().int().min(1000).optional().default(5 * 60_000),
  /** 卖出方向：rebasing 股票代币路由按 amountIn − tolerance 报价（D2：PlanGuard inputShortfallTolerance，默认 1e6 wei） */
  SELL_INPUT_TOLERANCE_WEI: z.string().regex(/^\d+$/).optional().default("1000000"),
  /** 逗号分隔地址：这些付款人/owner 视为自付演示（账单 selfPayment=true） */
  DEMO_SELF_PAYMENT_ADDRESSES: z.string().optional().default(""),
});

export type VerifyConfig = ReturnType<typeof loadConfig>;

export interface ApiKeyEntry {
  key: string;
  callerId: string;
}

export function parseApiKeys(raw: string): ApiKeyEntry[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx <= 0) throw new Error(`VERIFY_API_KEYS 条目格式应为 key:callerId，得到 ${pair}`);
      return { key: pair.slice(0, idx), callerId: pair.slice(idx + 1) };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`环境变量校验失败：${parsed.error.message}`);
  const e = parsed.data;
  const isProd = e.NODE_ENV === "production";
  const paid = e.REPORT_PRICE_USD !== "0" && Number(e.REPORT_PRICE_USD) > 0;

  const problems: string[] = [];
  if (isProd && (e.EVIDENCE_MODE === "fixture" || e.REGISTRY_MODE === "fixture")) {
    problems.push("生产环境禁止 fixture 证据/登记模式");
  }
  if (paid && e.PAYMENT_MODE === "okx" && (!e.OKX_API_KEY || !e.OKX_SECRET_KEY || !e.OKX_PASSPHRASE)) {
    problems.push("收费模式需要 OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE");
  }
  if (paid && !isEvmAddress(e.MERCHANT_RECIPIENT_ADDRESS)) problems.push("收费模式需要合法 MERCHANT_RECIPIENT_ADDRESS");
  if (paid && e.PAYMENT_MODE === "okx" && e.EVIDENCE_MODE === "fixture") problems.push("fixture 证据不得与真实收费同时启用（O-01）");
  if (isProd && e.PAYMENT_MODE === "mock") problems.push("生产环境禁止 mock 支付");
  if (e.GUARD_ADDRESS && !isEvmAddress(e.GUARD_ADDRESS)) problems.push("GUARD_ADDRESS 非法");
  if (e.PLANGUARD_ADDRESS && !isEvmAddress(e.PLANGUARD_ADDRESS)) problems.push("PLANGUARD_ADDRESS 非法");
  for (const a of e.DEMO_SELF_PAYMENT_ADDRESSES.split(",").map((x) => x.trim()).filter(Boolean)) if (!isEvmAddress(a)) problems.push(`DEMO_SELF_PAYMENT_ADDRESSES 含非法地址 ${a}`);
  if (e.ROUTER_ADDRESS && !isEvmAddress(e.ROUTER_ADDRESS)) problems.push("ROUTER_ADDRESS 非法");
  if (e.SPENDER_ADDRESS && !isEvmAddress(e.SPENDER_ADDRESS)) problems.push("SPENDER_ADDRESS 非法");
  if (e.ATTESTATION_PRIVATE_KEY && !/^0x[0-9a-fA-F]{64}$/.test(e.ATTESTATION_PRIVATE_KEY)) problems.push("ATTESTATION_PRIVATE_KEY 格式非法");
  if (e.REGISTRY_MODE === "file" && !e.REGISTRY_FILE) problems.push("REGISTRY_MODE=file 需要 REGISTRY_FILE");
  if (e.EVIDENCE_MODE === "live" && (!e.OKX_API_KEY || !e.OKX_SECRET_KEY || !e.OKX_PASSPHRASE)) problems.push("EVIDENCE_MODE=live 需要 OKX 凭据");
  if (e.EVIDENCE_MODE === "live" && !e.FINNHUB_API_KEY) problems.push("EVIDENCE_MODE=live 需要 FINNHUB_API_KEY（参考价来源，CV-D02）");
  if (problems.length > 0) throw new Error(`配置护栏拒绝启动：${problems.join("；")}`);

  return {
    ...e,
    isProd,
    paid,
    apiKeys: parseApiKeys(e.VERIFY_API_KEYS),
    selfPaymentAddresses: new Set(e.DEMO_SELF_PAYMENT_ADDRESSES.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)),
  };
}

/**
 * 私钥护栏（verify-service 版）：只允许 ATTESTATION_PRIVATE_KEY 一把；
 * 其它任何 *PRIVATE_KEY* / *SECRET_KEY*（OKX_SECRET_KEY 除外，它是 API 认证不是链上私钥）/ MNEMONIC 一律拒启。
 */
export function assertOnlyAttestationKey(env: NodeJS.ProcessEnv = process.env): void {
  const allowed = new Set(["ATTESTATION_PRIVATE_KEY", "OKX_SECRET_KEY"]);
  const re = /(?:PRIVATE_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE)/i;
  const offenders = Object.entries(env)
    .filter(([k, v]) => v && v.trim() && re.test(k) && !allowed.has(k))
    .map(([k]) => k);
  if (offenders.length > 0) {
    throw new Error(`verify-service 只允许持有证明签名私钥；检测到额外私钥形态变量：${offenders.join(", ")}（D-080）`);
  }
}
