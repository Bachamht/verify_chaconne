/**
 * A2MCP 输入宽容层（I2 2026-09-21，ASP #13803 驳回后的修复）。
 *
 * 事实：OKX 的调用客户端（`onchainos payment quote`）只接受 HTTP 200 或 402，其它状态一律判 `endpoint_unreachable`；
 * 它默认先 **GET 空探测**，再按服务描述里的参数说明带 `--param k=v`（GET 走 query，POST 走 JSON body）。
 * 因此：A2MCP 端点对"缺参数"必须回 **200** 并在正文里说明（status=input_required），绝不能 400。
 *
 * 同时让 LLM Agent 更容易调对：
 *  - 资产可用符号（USDG / USDC / USDT0 / AAPLx / NVDAx / AAPL / NVDA）或 0x 地址，不必知道 eip155 键；
 *  - 金额可用人类单位 `amount`（如 "100"），按输入币种精度换成 amountInRaw；
 *  - 常见字段别名（owner/wallet/address、policy、slippageBps、from/to、stock/token…）；
 *  - policyId 缺省 REFERENCE_CONTEXT、maxSlippageBps 缺省 50、recipient 缺省 owner（缺省即公开约定，不是降级）。
 */
import type { Request } from "express";
import type { AssetRegistry, RegistryEntry } from "@chaconne/core/verify";

const OWNER_KEYS = ["ownerAddress", "owner", "wallet", "walletAddress", "address", "from", "buyer", "payer", "userAddress", "account"];
const RECIPIENT_KEYS = ["recipientAddress", "recipient", "to", "receiver", "toAddress"];
const INPUT_KEYS = ["inputAssetKey", "inputAsset", "input", "payWith", "stablecoin", "fromToken", "fromAsset", "spend", "inputToken", "quoteAsset", "currency"];
const OUTPUT_KEYS = ["outputAssetKey", "outputAsset", "output", "asset", "stock", "token", "toToken", "toAsset", "buy", "symbol", "ticker", "outputToken", "baseAsset"];
const AMOUNT_RAW_KEYS = ["amountInRaw", "amountRaw", "amountIn", "rawAmount"];
const AMOUNT_HUMAN_KEYS = ["amount", "amountUsd", "budget", "value", "notional", "size", "usd"];
const POLICY_KEYS = ["policyId", "policy", "mode", "verificationPolicy"];
const SLIPPAGE_KEYS = ["maxSlippageBps", "slippageBps", "slippage", "maxSlippage"];
const IMPACT_KEYS = ["maxPriceImpactBps", "priceImpactBps", "impactBps", "maxImpactBps", "maxPriceImpact"];
const DEVIATION_KEYS = ["maxReferenceDeviationBps", "deviationBps", "maxDeviationBps", "referenceDeviationBps"];

const POLICY_ALIASES: Record<string, "STRICT_LIVE" | "REFERENCE_CONTEXT" | "QUOTE_ONLY"> = {
  STRICT_LIVE: "STRICT_LIVE",
  STRICT: "STRICT_LIVE",
  LIVE: "STRICT_LIVE",
  REFERENCE_CONTEXT: "REFERENCE_CONTEXT",
  REFERENCE: "REFERENCE_CONTEXT",
  CONTEXT: "REFERENCE_CONTEXT",
  CLOSE: "REFERENCE_CONTEXT",
  DEFAULT: "REFERENCE_CONTEXT",
  QUOTE_ONLY: "QUOTE_ONLY",
  QUOTE: "QUOTE_ONLY",
  ROUTE_ONLY: "QUOTE_ONLY",
};

export interface FriendlyInput {
  ownerAddress: string;
  recipientAddress: string;
  inputAssetKey: string | null;
  outputAssetKey: string | null;
  amountInRaw: string | null;
  policyId: string;
  maxSlippageBps: number | null;
  maxPriceImpactBps: number | null;
  maxReferenceDeviationBps: number | null;
  clientRequestId: string | undefined;
  /** 告诉调用方我们把什么解析成了什么（透明，便于 Agent 复述） */
  resolved: Record<string, string>;
  /** 缺失的必填项（按公开参数名） */
  missing: string[];
  /** 无法解析的输入 */
  problems: Array<{ field: string; value: string; hint: string }>;
}

function pick(body: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k];
    // 大小写不敏感兜底
    const hit = Object.keys(body).find((bk) => bk.toLowerCase() === k.toLowerCase());
    if (hit && body[hit] !== undefined && body[hit] !== null && body[hit] !== "") return body[hit];
  }
  return undefined;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** 符号 / 地址 / assetKey → 登记表条目 */
export function resolveAsset(reg: AssetRegistry, raw: string, role: "stable_input" | "stock_output"): RegistryEntry | null {
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const entries = reg.entries.filter((e) => e.role === role);
  const byKey = entries.find((e) => e.assetKey.toLowerCase() === lower);
  if (byKey) return byKey;
  if (/^0x[0-9a-f]{40}$/i.test(s)) return entries.find((e) => e.tokenAddress.toLowerCase() === lower) ?? null;
  const norm = lower.replace(/[₮]/g, "t").replace(/[\s_-]/g, "");
  const bySymbol = entries.find((e) => e.displaySymbol.toLowerCase().replace(/[₮]/g, "t").replace(/[\s_-]/g, "") === norm);
  if (bySymbol) return bySymbol;
  if (role === "stable_input") {
    if (norm === "usdt" || norm === "usdt0" || norm === "tether") return entries.find((e) => e.displaySymbol.toLowerCase().includes("usd₮") || e.displaySymbol.toLowerCase().includes("usdt")) ?? null;
    if (norm === "usd" || norm === "dollar" || norm === "stable" || norm === "stablecoin") return entries.find((e) => e.displaySymbol === "USDG") ?? entries[0] ?? null;
  } else {
    // 底层股票代码：AAPL → AAPLx；也接受 "apple"/"nvidia" 之类常见名
    const byUnderlying = entries.find((e) => e.underlyingId.toLowerCase().endsWith(":" + norm) || e.displaySymbol.toLowerCase().replace(/x$/, "") === norm.replace(/x$/, ""));
    if (byUnderlying) return byUnderlying;
    const names: Record<string, string> = { apple: "AAPL", nvidia: "NVDA", spy: "SPY", sp500: "SPY", "s&p500": "SPY" };
    const t = names[norm];
    if (t) return entries.find((e) => e.underlyingId.toLowerCase().endsWith(":" + t.toLowerCase())) ?? null;
  }
  return null;
}

/** 人类单位金额 → 最小单位（十进制字符串），超过精度的小数位截断 */
export function toRawAmount(human: string, decimals: number): string | null {
  const m = /^\s*\$?\s*([0-9][0-9,]*)(?:\.([0-9]+))?\s*$/.exec(human);
  if (!m) return null;
  const whole = m[1]!.replace(/,/g, "");
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  const raw = (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
  return raw === "0" ? null : raw;
}

function toBps(v: unknown, kind: "slippage" | "impact" | "deviation"): number | null {
  if (v === undefined || v === null || v === "") return null;
  const s = str(v);
  if (/^\d+$/.test(s)) return Number(s);
  // "0.5%" / "0.5" 视为百分比
  const pm = /^([0-9]*\.?[0-9]+)\s*%$/.exec(s) ?? (kind === "slippage" && /^0?\.[0-9]+$/.test(s) ? [s, s] : null);
  if (pm) return Math.round(Number(pm[1]) * 100);
  return Number.NaN;
}

export function parseFriendlyInput(req: Request, reg: AssetRegistry, chainId: number): FriendlyInput {
  const body = ((req.method === "GET" ? req.query : req.body) ?? {}) as Record<string, unknown>;
  const resolved: Record<string, string> = {};
  const problems: FriendlyInput["problems"] = [];
  const missing: string[] = [];

  const owner = str(pick(body, OWNER_KEYS));
  if (!owner) missing.push("ownerAddress");
  else if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) problems.push({ field: "ownerAddress", value: owner, hint: "must be a 0x-prefixed 40-hex EVM address" });
  const recipient = str(pick(body, RECIPIENT_KEYS)) || owner;

  const inRaw = str(pick(body, INPUT_KEYS));
  const stables = reg.entries.filter((e) => e.role === "stable_input");
  // 缺省稳定币 = 登记表里的 USDG，否则第一项（夹具登记表符号不同）
  const inEntry = inRaw ? resolveAsset(reg, inRaw, "stable_input") : (stables.find((e) => e.displaySymbol === "USDG") ?? stables[0] ?? null);
  if (!inRaw && inEntry) resolved["inputAssetKey"] = `default ${inEntry.displaySymbol} ${inEntry.assetKey}`;
  if (!inEntry) problems.push({ field: "inputAssetKey", value: inRaw, hint: `unknown stablecoin; use one of ${reg.entries.filter((e) => e.role === "stable_input").map((e) => e.displaySymbol).join(" / ")} or an eip155:${chainId}:<address> key` });
  else if (inRaw && inRaw.toLowerCase() !== inEntry.assetKey.toLowerCase()) resolved["inputAssetKey"] = `${inRaw} → ${inEntry.displaySymbol} ${inEntry.assetKey}`;

  const outRaw = str(pick(body, OUTPUT_KEYS));
  const outEntry = outRaw ? resolveAsset(reg, outRaw, "stock_output") : null;
  if (!outRaw) missing.push("outputAssetKey");
  else if (!outEntry) problems.push({ field: "outputAssetKey", value: outRaw, hint: `unknown stock token; use one of ${reg.entries.filter((e) => e.role === "stock_output" && e.executionAllowed).map((e) => `${e.displaySymbol} (${e.underlyingId.split(":")[1]})`).join(" / ")} or an eip155:${chainId}:<address> key` });
  else if (outRaw.toLowerCase() !== outEntry.assetKey.toLowerCase()) resolved["outputAssetKey"] = `${outRaw} → ${outEntry.displaySymbol} ${outEntry.assetKey}`;

  let amountInRaw: string | null = null;
  const rawAmt = str(pick(body, AMOUNT_RAW_KEYS));
  const humanAmt = str(pick(body, AMOUNT_HUMAN_KEYS));
  if (rawAmt) {
    if (/^[0-9]+$/.test(rawAmt) && rawAmt !== "0") amountInRaw = rawAmt;
    else problems.push({ field: "amountInRaw", value: rawAmt, hint: "must be a positive decimal integer string in the stablecoin's smallest unit (6 decimals: 5 USDG = 5000000)" });
  } else if (humanAmt) {
    const dec = inEntry?.tokenDecimals ?? 6;
    const r = toRawAmount(humanAmt, dec);
    if (r) {
      amountInRaw = r;
      resolved["amountInRaw"] = `amount ${humanAmt} ${inEntry?.displaySymbol ?? ""} → ${r} (${dec} decimals)`;
    } else problems.push({ field: "amount", value: humanAmt, hint: 'must be a positive decimal number, e.g. "100" or "12.5"' });
  } else missing.push("amountInRaw (or amount)");

  const polRaw = str(pick(body, POLICY_KEYS));
  const policyId = polRaw ? (POLICY_ALIASES[polRaw.toUpperCase().replace(/[\s-]/g, "_")] ?? "") : "REFERENCE_CONTEXT";
  if (polRaw && !policyId) problems.push({ field: "policyId", value: polRaw, hint: "one of STRICT_LIVE | REFERENCE_CONTEXT | QUOTE_ONLY" });
  if (!polRaw) resolved["policyId"] = "default REFERENCE_CONTEXT (official close as context; use STRICT_LIVE during US regular hours for a live reference)";
  else if (policyId && policyId !== polRaw) resolved["policyId"] = `${polRaw} → ${policyId}`;

  const slip = toBps(pick(body, SLIPPAGE_KEYS), "slippage");
  const maxSlippageBps = slip === null ? 50 : slip;
  if (slip === null) resolved["maxSlippageBps"] = "default 50 (0.5%)";
  if (Number.isNaN(maxSlippageBps)) problems.push({ field: "maxSlippageBps", value: str(pick(body, SLIPPAGE_KEYS)), hint: "integer basis points 1-300 (50 = 0.5%)" });
  const maxPriceImpactBps = toBps(pick(body, IMPACT_KEYS), "impact");
  if (Number.isNaN(maxPriceImpactBps)) problems.push({ field: "maxPriceImpactBps", value: str(pick(body, IMPACT_KEYS)), hint: "integer basis points 1-1000" });
  const maxReferenceDeviationBps = toBps(pick(body, DEVIATION_KEYS), "deviation");
  if (Number.isNaN(maxReferenceDeviationBps)) problems.push({ field: "maxReferenceDeviationBps", value: str(pick(body, DEVIATION_KEYS)), hint: "integer basis points 1-2000" });

  const cid = str(pick(body, ["clientRequestId", "requestId", "idempotencyKey"]));
  return {
    ownerAddress: owner,
    recipientAddress: recipient,
    inputAssetKey: inEntry?.assetKey ?? null,
    outputAssetKey: outEntry?.assetKey ?? null,
    amountInRaw,
    policyId: policyId || "REFERENCE_CONTEXT",
    maxSlippageBps: Number.isNaN(maxSlippageBps) ? null : maxSlippageBps,
    maxPriceImpactBps: Number.isNaN(maxPriceImpactBps) ? null : maxPriceImpactBps,
    maxReferenceDeviationBps: Number.isNaN(maxReferenceDeviationBps) ? null : maxReferenceDeviationBps,
    clientRequestId: cid || undefined,
    resolved,
    missing,
    problems,
  };
}

/** A2MCP 缺参数/参数错误的统一 200 正文（不能用 4xx：OKX 客户端会判 endpoint_unreachable） */
export function inputRequiredBody(args: { service: string; endpoint: string; method: "POST" | "GET"; schema: unknown; example: unknown; missing: string[]; problems: FriendlyInput["problems"]; resolved: Record<string, string>; reg: AssetRegistry; discovery?: Record<string, string> }) {
  const stables = args.reg.entries.filter((e) => e.role === "stable_input").map((e) => e.displaySymbol);
  const stocks = args.reg.entries.filter((e) => e.role === "stock_output" && e.executionAllowed).map((e) => `${e.displaySymbol} (${e.underlyingId.split(":")[1]})`);
  const need = args.missing.length ? `Missing: ${args.missing.join(", ")}. ` : "";
  const bad = args.problems.length ? `Invalid: ${args.problems.map((p) => `${p.field}="${p.value}" (${p.hint})`).join("; ")}. ` : "";
  return {
    ok: false,
    status: "input_required",
    error: "input_required",
    service: args.service,
    summary: `${need}${bad}Call ${args.method} ${args.endpoint} with ownerAddress, outputAssetKey (stock: ${stocks.join(" / ")}), amount (e.g. "100") or amountInRaw, optional inputAssetKey (${stables.join(" / ")}; default USDG), optional policyId (STRICT_LIVE | REFERENCE_CONTEXT | QUOTE_ONLY; default REFERENCE_CONTEXT), optional maxSlippageBps (default 50). Symbols and 0x addresses are both accepted.`.trim(),
    missingParams: args.missing,
    problems: args.problems,
    resolved: args.resolved,
    schema: args.schema,
    example: args.example,
    supportedAssets: { stablecoins: stables, stocks },
    howToCall: { method: args.method, endpoint: args.endpoint, contentType: "application/json (POST body) or query string (GET)", ...(args.discovery ?? {}) },
  };
}
