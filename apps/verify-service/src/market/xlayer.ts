/**
 * 公开行情（主站 chaconne.xyz 的 poller 消费）：X Layer 股票代币对 USDG 的 OKX DEX 聚合器报价，
 * 三档买入金额 100 / 1,000 / 10,000 USDG（100 ≈ 中间价；1k / 10k = 主站标准手量冲击档）。
 * 契约冻结于 docs/devday-2026/interfaces.md §10.16（字段不可增删；缺省 null 不省略）。
 *  - 无鉴权、无 x402；响应只含公开数据，不含任何凭据；
 *  - 内存缓存 TTL 30 s + single-flight（并发请求只触发一次刷新）；
 *  - 上游失败：返回上一份快照并 stale:true；失败后 TTL 内冷却不再打上游；从未成功 → null（HTTP 503）；
 *  - OKX 限流（50011 / 429）：至多退避重试一次，仍限流则中止本轮（不重试风暴），errors 记 rate_limited。
 * 与付费核验共用同一把 OKX key：串行 + 档间间隔，降低与任务报价并发撞限流的概率（任务侧自带退避重试）。
 */
import { parseAdverseImpactBps, type AssetRegistry, type RegistryEntry } from "@chaconne/core/verify";
import { isRateLimited, quote as okxQuote, type OkxCall, type OkxClient, type OkxQuote } from "../adapters/okx/client";
import { log } from "../log";

export const MARKET_XLAYER_SCHEMA = "chaconne-verify/market-xlayer/1";
export const MARKET_XLAYER_TTL_SEC = 30;
export const MARKET_SIZES_USD = [100, 1_000, 10_000] as const;
export type MarketSizeUsd = (typeof MARKET_SIZES_USD)[number];
export const DEFAULT_PUBLIC_BASE_URL = "https://verify.chaconne.xyz";
/** OKX 聚合器：无可用路由 / 流动性不足（PL-03 实测 20 万 USDG → 82000） */
const OKX_NO_ROUTE_CODES = new Set(["82000"]);

export type MarketErrorCode = "no_route" | "rate_limited" | "upstream_error";

export interface MarketToken {
  symbol: string;
  underlying: string;
  address: string;
  decimals: number;
  /** 100 USDG 档成交价（USDG≈USD）≈ 中间价 */
  priceUsd: number | null;
  execPrice1k: number | null;
  impact1kBps: number | null;
  execPrice10k: number | null;
  impact10kBps: number | null;
  receivedAt: string | null;
  route: string[];
  verifyUrl: string;
}

export interface MarketError {
  symbol: string;
  code: MarketErrorCode;
  size?: number;
}

export interface MarketSnapshot {
  schema: typeof MARKET_XLAYER_SCHEMA;
  chain: "xlayer";
  chainIndex: string;
  source: "okx_dex_quote";
  asOf: string;
  ttlSec: number;
  stale: boolean;
  input: { symbol: string; address: string; decimals: number };
  tokens: MarketToken[];
  errors: MarketError[];
}

export interface XLayerMarketDeps {
  okx: OkxClient;
  registry: AssetRegistry;
  /** verifyUrl 的公网前缀（缺省 https://verify.chaconne.xyz） */
  publicBaseUrl?: string;
  now?: () => Date;
  ttlMs?: number;
  /** 限流退避 / 档间间隔（测试置 0 并注入 sleep） */
  backoffMs?: number;
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Leg = { price: number; impactBps: number | null; receivedAt: string; route: string[] };
type QuoteOutcome = ({ kind: "ok" } & Leg) | { kind: "err"; code: MarketErrorCode; abort: boolean };

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const underlyingOf = (id: string): string => (id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 路由 DEX 名（去重保序）。quote v6 实测 dexRouterList[].dexProtocol 为对象；类型上另有 subRouterList[].dexProtocol[]，两种都收。 */
export function routeNames(qd: OkxQuote): string[] {
  const names: string[] = [];
  const add = (n: unknown) => {
    if (typeof n === "string" && n && !names.includes(n)) names.push(n);
  };
  for (const r of qd.dexRouterList ?? []) {
    const direct = (r as { dexProtocol?: unknown }).dexProtocol;
    if (Array.isArray(direct)) for (const p of direct) add((p as { dexName?: unknown })?.dexName);
    else if (direct && typeof direct === "object") add((direct as { dexName?: unknown }).dexName);
    for (const s of r.subRouterList ?? []) for (const p of s.dexProtocol ?? []) add(p.dexName);
  }
  return names;
}

/** 冲击 bps：OKX priceImpactPercent 优先（非负，向不利方向取整）；缺失则按执行价相对中间价计算（取非负） */
export function impactBpsOf(leg: Leg, midPrice: number | null): number | null {
  if (leg.impactBps !== null) return leg.impactBps;
  if (midPrice === null || midPrice <= 0) return null;
  return Math.max(0, Math.round((leg.price / midPrice - 1) * 10_000));
}

export class XLayerMarket {
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: number;
  private readonly spacingMs: number;
  private readonly base: string;
  private last: MarketSnapshot | null = null;
  private lastOkAt = 0;
  private lastAttemptAt = 0;
  private inflight: Promise<MarketSnapshot | null> | null = null;

  constructor(private readonly d: XLayerMarketDeps) {
    this.ttlMs = d.ttlMs ?? MARKET_XLAYER_TTL_SEC * 1000;
    this.now = d.now ?? (() => new Date());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.backoffMs = d.backoffMs ?? 600;
    this.spacingMs = d.spacingMs ?? 200;
    this.base = (d.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
  }

  /** 登记表：输入稳定币（USDG 优先）与允许执行的输出侧股票代币（登记表顺序 = 契约顺序 AAPLx, NVDAx） */
  universe(): { stable: RegistryEntry | null; stocks: RegistryEntry[] } {
    const stables = this.d.registry.entries.filter((e) => e.role === "stable_input");
    const stable = stables.find((e) => e.displaySymbol === "USDG") ?? stables[0] ?? null;
    const stocks = this.d.registry.entries.filter((e) => e.role === "stock_output" && e.executionAllowed);
    return { stable, stocks };
  }

  /** 新鲜则直接返回；过期则刷新（single-flight）；刷新失败返回上一份 stale:true 并冷却一个 TTL；从未成功 → null */
  async snapshot(): Promise<MarketSnapshot | null> {
    const nowMs = this.now().getTime();
    if (this.last && nowMs - this.lastOkAt < this.ttlMs) return this.last;
    if (this.inflight) return this.inflight;
    if (this.lastAttemptAt > this.lastOkAt && nowMs - this.lastAttemptAt < this.ttlMs) return this.staleCopy();
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private staleCopy(): MarketSnapshot | null {
    return this.last ? { ...this.last, stale: true } : null;
  }

  private async refresh(): Promise<MarketSnapshot | null> {
    this.lastAttemptAt = this.now().getTime();
    const { stable, stocks } = this.universe();
    if (!stable || stocks.length === 0) {
      log.warn("公开行情：登记表缺稳定币或股票代币，无法报价");
      return this.staleCopy();
    }
    const chainIndex = String(this.d.registry.chainId);
    const tokens: MarketToken[] = [];
    const errors: MarketError[] = [];
    let aborted: MarketErrorCode | null = null;
    let calls = 0;
    for (const stock of stocks) {
      const symbol = stock.displaySymbol;
      const legs = new Map<MarketSizeUsd, Leg>();
      for (const size of MARKET_SIZES_USD) {
        if (aborted) {
          errors.push({ symbol, code: aborted, size });
          continue;
        }
        if (calls > 0 && this.spacingMs > 0) await this.sleep(this.spacingMs);
        calls += 1;
        const amount = (BigInt(size) * 10n ** BigInt(stable.tokenDecimals)).toString();
        let r: QuoteOutcome;
        try {
          r = await this.quoteOnce(chainIndex, stable, stock, amount, size);
        } catch (e) {
          log.warn("公开行情：OKX quote 上游异常，本轮中止", { symbol, size, error: errMsg(e) });
          aborted = "upstream_error";
          errors.push({ symbol, code: "upstream_error", size });
          continue;
        }
        if (r.kind === "ok") {
          legs.set(size, r);
          continue;
        }
        errors.push({ symbol, code: r.code, size });
        if (r.abort) {
          aborted = r.code;
          log.warn("公开行情：本轮中止", { symbol, size, code: r.code });
        }
      }
      const mid = legs.get(100) ?? null;
      const l1k = legs.get(1_000) ?? null;
      const l10k = legs.get(10_000) ?? null;
      const first = mid ?? l1k ?? l10k;
      tokens.push({
        symbol,
        underlying: underlyingOf(stock.underlyingId),
        address: stock.tokenAddress,
        decimals: stock.tokenDecimals,
        priceUsd: mid ? round6(mid.price) : null,
        execPrice1k: l1k ? round6(l1k.price) : null,
        impact1kBps: l1k ? impactBpsOf(l1k, mid?.price ?? null) : null,
        execPrice10k: l10k ? round6(l10k.price) : null,
        impact10kBps: l10k ? impactBpsOf(l10k, mid?.price ?? null) : null,
        receivedAt: first?.receivedAt ?? null,
        route: l1k?.route.length ? l1k.route : (first?.route ?? []),
        verifyUrl: `${this.base}/new?stock=${encodeURIComponent(symbol)}&from=main`,
      });
    }
    const anyPrice = tokens.some((t) => t.priceUsd !== null || t.execPrice1k !== null || t.execPrice10k !== null);
    if (!anyPrice) {
      log.warn("公开行情：本轮无任何报价，沿用上一份", { errors: errors.map((e) => `${e.symbol}:${e.code}`).join(",") || "none", hadPrevious: this.last !== null });
      return this.staleCopy();
    }
    const snap: MarketSnapshot = {
      schema: MARKET_XLAYER_SCHEMA,
      chain: "xlayer",
      chainIndex,
      source: "okx_dex_quote",
      asOf: this.now().toISOString(),
      ttlSec: MARKET_XLAYER_TTL_SEC,
      stale: false,
      input: { symbol: stable.displaySymbol, address: stable.tokenAddress, decimals: stable.tokenDecimals },
      tokens,
      errors,
    };
    this.last = snap;
    this.lastOkAt = this.now().getTime();
    return snap;
  }

  /** 单档报价：限流至多退避重试一次；5xx/网络异常 → 中止本轮；82000 → 无路由（不中止，其它档照报） */
  private async quoteOnce(chainIndex: string, stable: RegistryEntry, stock: RegistryEntry, amount: string, sizeUsd: number): Promise<QuoteOutcome> {
    let call: OkxCall<OkxQuote[]> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      call = await okxQuote(this.d.okx, { chainIndex, fromTokenAddress: stable.tokenAddress, toTokenAddress: stock.tokenAddress, amount });
      if (!isRateLimited(call)) break;
      if (attempt === 0 && this.backoffMs > 0) await this.sleep(this.backoffMs);
    }
    if (!call) throw new Error("unreachable");
    if (isRateLimited(call)) return { kind: "err", code: "rate_limited", abort: true };
    if (call.status === 0 || call.status >= 500) return { kind: "err", code: "upstream_error", abort: true };
    if (!call.ok) return { kind: "err", code: OKX_NO_ROUTE_CODES.has(call.code) ? "no_route" : "upstream_error", abort: false };
    const qd = call.data?.[0];
    const outRaw = qd?.toTokenAmount && /^\d+$/.test(qd.toTokenAmount) ? BigInt(qd.toTokenAmount) : 0n;
    if (!qd || outRaw <= 0n) return { kind: "err", code: "no_route", abort: false };
    const tokensOut = Number(outRaw) / 10 ** stock.tokenDecimals;
    if (!Number.isFinite(tokensOut) || tokensOut <= 0) return { kind: "err", code: "no_route", abort: false };
    return { kind: "ok", price: sizeUsd / tokensOut, impactBps: parseAdverseImpactBps(qd.priceImpactPercent ?? null), receivedAt: call.time.receivedAt, route: routeNames(qd) };
  }
}
