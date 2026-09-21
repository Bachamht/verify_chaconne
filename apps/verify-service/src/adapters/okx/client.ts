/**
 * OKX Onchain OS REST 客户端（签名规则与官方 x402 SDK 的 OKXFacilitatorClient.createHeaders 一致）：
 *   OK-ACCESS-SIGN = base64(HMAC-SHA256(secret, timestamp + METHOD + path(+query) + body))
 * 每次调用返回：解析后的 data、原文哈希、请求/接收时间（供证据记录）。绝不记录请求头。
 */
import { createHmac } from "node:crypto";
import { keccak256Utf8, type Bytes32, type EvidenceTime } from "@chaconne/core/verify";

export interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  baseUrl?: string;
}

export interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T;
}

export interface OkxCall<T> {
  ok: boolean;
  status: number;
  code: string;
  msg: string;
  data: T | null;
  rawText: string;
  rawHash: Bytes32;
  time: EvidenceTime;
  /** 路径 + 规范化查询串（不含密钥） */
  endpoint: string;
}

export class OkxClient {
  private readonly baseUrl: string;
  constructor(
    private readonly creds: OkxCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.baseUrl = creds.baseUrl ?? "https://web3.okx.com";
  }

  private headers(method: string, pathWithQuery: string, body: string): Record<string, string> {
    const timestamp = new Date().toISOString(); // 签名时间戳必须是真实时钟（OKX 校验时效）
    const prehash = timestamp + method + pathWithQuery + body;
    const sign = createHmac("sha256", this.creds.secretKey).update(prehash).digest("base64");
    return {
      "OK-ACCESS-KEY": this.creds.apiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.creds.passphrase,
      "Content-Type": "application/json",
    };
  }

  async get<T>(path: string, query: Record<string, string | number | boolean | undefined>, timeoutMs = 15_000): Promise<OkxCall<T>> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const pathWithQuery = qs ? `${path}?${qs}` : path;
    return this.request<T>("GET", pathWithQuery, "", timeoutMs);
  }

  async post<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<OkxCall<T>> {
    return this.request<T>("POST", path, JSON.stringify(body), timeoutMs);
  }

  private async request<T>(method: "GET" | "POST", pathWithQuery: string, body: string, timeoutMs: number): Promise<OkxCall<T>> {
    const requestedAt = this.clock().toISOString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let status = 0;
    let rawText = "";
    try {
      const res = await this.fetchImpl(this.baseUrl + pathWithQuery, {
        method,
        headers: this.headers(method, pathWithQuery, body),
        body: method === "POST" ? body : undefined,
        signal: ctrl.signal,
      });
      status = res.status;
      rawText = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const receivedAt = this.clock().toISOString();
    let parsed: OkxResponse<T> | null = null;
    try {
      parsed = JSON.parse(rawText) as OkxResponse<T>;
    } catch {
      parsed = null;
    }
    const code = parsed?.code ?? String(status);
    return {
      ok: status === 200 && code === "0",
      status,
      code,
      msg: parsed?.msg ?? "",
      data: parsed?.data ?? null,
      rawText,
      rawHash: keccak256Utf8(rawText),
      time: { requestedAt, receivedAt, sourcePublishedAt: null, sourceTimeKind: "not_provided" },
      endpoint: pathWithQuery,
    };
  }
}

/* ---------- 端点封装（字段名以官方文档 2026-09-20 读取为准） ---------- */

export interface OkxRwaToken {
  chainIndex: string;
  issuer: string;
  tokenSymbol: string;
  stockCode: string;
  tokenName: string;
  tokenContractAddress: string;
  price: string;
  priceChange24H: string;
  marketCap: string;
  volume24h: string;
  stockPrice: string;
  stockPriceChange24H: string;
  stockMarketCap: string;
  stockVolume24h: string;
  tokenToAssetRatio?: string;
  peRatioTTM?: string;
  logoUrl?: string;
}

export interface OkxRwaList {
  cursor: string;
  list: OkxRwaToken[];
}

export interface OkxQuoteRouter {
  router?: string;
  routerPercent?: string;
  subRouterList?: Array<{ dexProtocol?: Array<{ dexName?: string; percent?: string }>; fromToken?: { tokenContractAddress?: string }; toToken?: { tokenContractAddress?: string } }>;
}

export interface OkxQuote {
  chainIndex: string;
  fromTokenAmount: string;
  toTokenAmount: string;
  priceImpactPercent?: string | null;
  estimateGasFee?: string;
  tradeFee?: string;
  dexRouterList?: OkxQuoteRouter[];
  /** v5 探针 2026-09-20：quote 的 token 对象还带 latestMultiplier（rebasing 乘数，18 位小数串）与 taxRate */
  fromToken?: { tokenContractAddress?: string; decimal?: string; tokenSymbol?: string; tokenUnitPrice?: string; latestMultiplier?: string; taxRate?: string };
  toToken?: { tokenContractAddress?: string; decimal?: string; tokenSymbol?: string; tokenUnitPrice?: string; latestMultiplier?: string; taxRate?: string };
}

/** OKX 限频：code 50011 "Too Many Requests"（探针实测：同一 key 2 个并发 quote 即触发）或 HTTP 429 */
export function isRateLimited(c: { status: number; code: string }): boolean {
  return c.code === "50011" || c.status === 429;
}

export interface OkxSwap {
  routerResult: OkxQuote;
  tx: {
    to: string;
    data: string;
    value: string;
    gas?: string;
    gasPrice?: string;
    minReceiveAmount?: string;
    from?: string;
    signatureData?: unknown;
  };
}

export const OKX_PATHS = {
  rwaTokens: "/api/v6/dex/market/rwa/tokens",
  quote: "/api/v6/dex/aggregator/quote",
  swap: "/api/v6/dex/aggregator/swap",
  approve: "/api/v6/dex/aggregator/approve-transaction",
  price: "/api/v6/dex/market/price",
} as const;

export function rwaTokens(c: OkxClient, q: { chainIndex: string; issuer?: string; limit?: number; cursor?: string }) {
  return c.get<OkxRwaList>(OKX_PATHS.rwaTokens, { chainIndex: q.chainIndex, issuer: q.issuer, category: "47", limit: q.limit ?? 100, cursor: q.cursor });
}

export function quote(c: OkxClient, q: { chainIndex: string; fromTokenAddress: string; toTokenAddress: string; amount: string; slippagePercent?: string }) {
  return c.get<OkxQuote[]>(OKX_PATHS.quote, { chainIndex: q.chainIndex, fromTokenAddress: q.fromTokenAddress, toTokenAddress: q.toTokenAddress, amount: q.amount, swapMode: "exactIn" });
}

export function swap(c: OkxClient, q: { chainIndex: string; fromTokenAddress: string; toTokenAddress: string; amount: string; slippagePercent: string; userWalletAddress: string; swapReceiverAddress?: string }) {
  return c.get<OkxSwap[]>(OKX_PATHS.swap, { ...q, swapMode: "exactIn" });
}

export function approveTransaction(c: OkxClient, q: { chainIndex: string; tokenContractAddress: string; approveAmount: string }) {
  return c.get<Array<{ dexContractAddress?: string; data?: string; gasLimit?: string; gasPrice?: string }>>(OKX_PATHS.approve, q);
}
