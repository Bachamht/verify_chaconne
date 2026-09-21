/**
 * xStocks（Backed）公开 API 适配。基址与端点来自官方文档 https://docs.xstocks.fi/apis/v1/openapi.md（2026-09-21 读取）：
 *   GET https://api.xstocks.fi/api/v1/token/{tokenSymbol}/multiplier?network=XLayer   → 公开，无需 key
 *       响应 { currentMultiplier: number, newMultiplier: number, activationDateTime: number, reason: string|null }
 *   GET /corporate-actions、/pending-corporate-actions                                  → 需 X-API-KEY（探针实测无 key 返回 "Unauthenticated"）
 *   GET /token?limit=…                                                                  → 公开（含各链部署地址，X Layer network 枚举值 = "XLayer"）
 * 只做数据搬运与哈希；乘数的主证据仍是链上 getCurrentMultiplier()（见 adapters/xlayer/multiplier.ts）。
 */
import { keccak256Utf8, type Bytes32, type EvidenceTime } from "@chaconne/core/verify";

export const XSTOCKS_API_BASE = "https://api.xstocks.fi/api/v1";
export const XSTOCKS_NETWORK_XLAYER = "XLayer";

export interface XStocksMultiplier {
  currentMultiplier: number;
  newMultiplier: number;
  activationDateTime: number;
  reason: string | null;
}
export interface XStocksCorporateAction {
  [k: string]: unknown;
}
export interface XStocksCall<T> {
  ok: boolean;
  status: number;
  data: T | null;
  rawHash: Bytes32;
  time: EvidenceTime;
  endpoint: string;
}

export class XStocksClient {
  constructor(
    private readonly apiKey: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = XSTOCKS_API_BASE,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async call<T>(path: string, parse: (j: unknown) => T | null, timeoutMs = 10_000): Promise<XStocksCall<T>> {
    const requestedAt = this.clock().toISOString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let status = 0;
    let text = "";
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${path}`, { headers: { accept: "application/json", ...(this.apiKey ? { "X-API-KEY": this.apiKey } : {}) }, signal: ctrl.signal });
      status = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const receivedAt = this.clock().toISOString();
    let data: T | null = null;
    try {
      data = status === 200 ? parse(JSON.parse(text)) : null;
    } catch {
      data = null;
    }
    return { ok: data !== null, status, data, rawHash: keccak256Utf8(text), time: { requestedAt, receivedAt, sourcePublishedAt: null, sourceTimeKind: "not_provided" }, endpoint: path.replace(/\?.*$/, "") };
  }

  /** 公开：当前乘数（与链上 getCurrentMultiplier 同源，发行商口径） */
  tokenMultiplier(tokenSymbol: string, network = XSTOCKS_NETWORK_XLAYER): Promise<XStocksCall<XStocksMultiplier>> {
    return this.call(`token/${encodeURIComponent(tokenSymbol)}/multiplier?network=${encodeURIComponent(network)}`, (j) => {
      const o = j as Partial<XStocksMultiplier>;
      return typeof o.currentMultiplier === "number" && o.currentMultiplier > 0 ? { currentMultiplier: o.currentMultiplier, newMultiplier: Number(o.newMultiplier ?? 0), activationDateTime: Number(o.activationDateTime ?? 0), reason: o.reason ?? null } : null;
    });
  }

  /** 需 API key：历史公司行动（无 key → ok=false，status 500 "Unauthenticated"，探针 2026-09-21） */
  corporateActions(params: { tokenSymbol?: string; limit?: number; pending?: boolean } = {}): Promise<XStocksCall<XStocksCorporateAction[]>> {
    const qs = new URLSearchParams();
    if (params.tokenSymbol) qs.set("tokenSymbol", params.tokenSymbol);
    qs.set("limit", String(params.limit ?? 20));
    return this.call(`${params.pending ? "pending-corporate-actions" : "corporate-actions"}?${qs.toString()}`, (j) => {
      const o = j as { nodes?: unknown[] } | unknown[];
      const arr = Array.isArray(o) ? o : Array.isArray(o.nodes) ? o.nodes : null;
      return arr as XStocksCorporateAction[] | null;
    });
  }
}
