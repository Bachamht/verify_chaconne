/**
 * 公开行情（主站 chaconne.xyz 的 poller 消费）：X Layer 股票代币对 USDG 的 OKX DEX 聚合器报价。
 * 两层（2026-09-22 扩容：OKX RWA 名录在 X Layer 上共 100 只 xStocks，实测 49 只可路由，
 * 其中 41 只美股底层已接，8 只港股底层待另行支持；此前只接了 2 只）：
 *  - **execute**：Verify 登记表里 `executionAllowed` 的代币（当前 AAPLx / NVDAx）。仍取三档
 *    100 / 1,000 / 10,000 USDG（100 ≈ 中间价；1k / 10k = 主站标准手量冲击档），给出 verifyUrl。
 *  - **display**：`config/xlayer.display.json` 里的比价展示层。**只取 100 USDG 一档**作中间价，
 *    execPrice1k/10k 与 impact*Bps 一律 null，verifyUrl 为 null（它们不在 Verify 登记表与 Guard
 *    白名单里，深链过去会失败）。改这份清单不牵动链上配置。
 * 契约冻结于 docs/devday-2026/interfaces.md §10.16（字段不可增删；缺省 null 不省略）。
 *  - 无鉴权、无 x402；响应只含公开数据，不含任何凭据；
 *  - 内存缓存 TTL 30 s + single-flight（并发请求只触发一次刷新）；
 *  - 上游失败：返回上一份快照并 stale:true；失败后 TTL 内冷却不再打上游；从未成功 → null（HTTP 503）；
 *  - OKX 限流（50011 / 429）：至多退避重试一次，仍限流则中止本轮（不重试风暴），errors 记 rate_limited。
 * 与付费核验共用同一把 OKX key：串行 + 档间间隔 350 ms（实测 260 ms 会撞 50011），降低与任务报价
 * 并发撞限流的概率（任务侧自带退避重试）。41 只（执行层 2×3 档 + 展示层 39×1 档 = 45 次）
 * × 350 ms ≈ 16 s，装进 60 s 的缓存 TTL 仍有余量。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdverseImpactBps, type AssetRegistry, type RegistryEntry } from "@chaconne/core/verify";
import { isRateLimited, quote as okxQuote, type OkxCall, type OkxClient, type OkxQuote } from "../adapters/okx/client";
import { log } from "../log";

export const MARKET_XLAYER_SCHEMA = "chaconne-verify/market-xlayer/1";
export const MARKET_XLAYER_TTL_SEC = 60;
export const MARKET_SIZES_USD = [100, 1_000, 10_000] as const;
/** 展示层只取中间价一档 */
export const MARKET_DISPLAY_SIZES_USD = [100] as const;
export type MarketSizeUsd = (typeof MARKET_SIZES_USD)[number];
export type MarketTier = "execute" | "display";
export const DEFAULT_PUBLIC_BASE_URL = "https://verify.chaconne.xyz";
/** OKX 聚合器：无可用路由 / 流动性不足（PL-03 实测 20 万 USDG → 82000） */
const OKX_NO_ROUTE_CODES = new Set(["82000"]);

export type MarketErrorCode = "no_route" | "rate_limited" | "upstream_error";

export interface MarketToken {
  symbol: string;
  underlying: string;
  address: string;
  decimals: number;
  /** execute = 可在本服务核验并执行；display = 只供主站比价展示 */
  tier: MarketTier;
  /** 100 USDG 档成交价（USDG≈USD）≈ 中间价 */
  priceUsd: number | null;
  /** display 层恒为 null（只取中间价一档） */
  execPrice1k: number | null;
  impact1kBps: number | null;
  execPrice10k: number | null;
  impact10kBps: number | null;
  receivedAt: string | null;
  route: string[];
  /** display 层恒为 null：这些代币不在 Verify 登记表里，深链过去会失败 */
  verifyUrl: string | null;
}

/** 展示层清单条目（config/xlayer.display.json） */
export interface DisplayToken {
  symbol: string;
  underlying: string;
  address: string;
  decimals: number;
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
  /** 展示层清单；缺省读 config/xlayer.display.json（测试可传 [] 关掉） */
  display?: DisplayToken[];
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
/** 一个报价目标（执行层来自登记表，展示层来自 config/xlayer.display.json） */
export interface MarketTarget {
  tier: MarketTier;
  symbol: string;
  underlying: string;
  address: string;
  decimals: number;
}
type QuoteOutcome = ({ kind: "ok" } & Leg) | { kind: "err"; code: MarketErrorCode; abort: boolean };

export const DISPLAY_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "xlayer.display.json");

/** 读展示层清单；文件缺失或格式不符 → 空数组（端点降级为只报执行层，不影响核验主链路） */
export function loadDisplayTokens(file: string = DISPLAY_CONFIG_PATH): DisplayToken[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    log.warn("公开行情：展示层清单读取失败，本次只报执行层", { file, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
  const list = (raw as { tokens?: unknown })?.tokens;
  if (!Array.isArray(list)) {
    log.warn("公开行情：展示层清单缺 tokens 数组，本次只报执行层", { file });
    return [];
  }
  const out: DisplayToken[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const x = t as Record<string, unknown>;
    const address = typeof x["address"] === "string" ? x["address"].toLowerCase() : "";
    const decimals = typeof x["decimals"] === "number" ? x["decimals"] : NaN;
    if (!/^0x[0-9a-f]{40}$/.test(address) || !Number.isInteger(decimals)) continue;
    if (typeof x["symbol"] !== "string" || typeof x["underlying"] !== "string") continue;
    out.push({ symbol: x["symbol"], underlying: x["underlying"], address, decimals });
  }
  return out;
}

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
  private readonly display: DisplayToken[];
  private last: MarketSnapshot | null = null;
  private lastOkAt = 0;
  private lastAttemptAt = 0;
  private inflight: Promise<MarketSnapshot | null> | null = null;

  constructor(private readonly d: XLayerMarketDeps) {
    this.ttlMs = d.ttlMs ?? MARKET_XLAYER_TTL_SEC * 1000;
    this.now = d.now ?? (() => new Date());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.backoffMs = d.backoffMs ?? 600;
    this.spacingMs = d.spacingMs ?? 350;
    this.base = (d.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");
    // 执行层地址优先：同一代币既在登记表又在展示清单时，只按执行层报（避免重复与多余调用）
    const execAddrs = new Set(
      d.registry.entries.filter((e) => e.role === "stock_output" && e.executionAllowed).map((e) => e.tokenAddress.toLowerCase()),
    );
    this.display = (d.display ?? loadDisplayTokens()).filter((t) => !execAddrs.has(t.address.toLowerCase()));
  }

  /**
   * 报价目标：输入稳定币（USDG 优先）+ 两层输出侧代币。
   * 顺序 = 先登记表（执行层，AAPLx / NVDAx…）再展示层清单顺序；契约里 tokens 按此顺序返回。
   */
  universe(): { stable: RegistryEntry | null; targets: MarketTarget[] } {
    const stables = this.d.registry.entries.filter((e) => e.role === "stable_input");
    const stable = stables.find((e) => e.displaySymbol === "USDG") ?? stables[0] ?? null;
    const targets: MarketTarget[] = [];
    for (const e of this.d.registry.entries) {
      if (e.role !== "stock_output" || !e.executionAllowed) continue;
      targets.push({
        tier: "execute",
        symbol: e.displaySymbol,
        underlying: underlyingOf(e.underlyingId),
        address: e.tokenAddress,
        decimals: e.tokenDecimals,
      });
    }
    for (const t of this.display) targets.push({ tier: "display", ...t });
    return { stable, targets };
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
    const { stable, targets } = this.universe();
    if (!stable || targets.length === 0) {
      log.warn("公开行情：登记表缺稳定币或股票代币，无法报价");
      return this.staleCopy();
    }
    const chainIndex = String(this.d.registry.chainId);
    const tokens: MarketToken[] = [];
    const errors: MarketError[] = [];
    let aborted: MarketErrorCode | null = null;
    let calls = 0;
    for (const target of targets) {
      const symbol = target.symbol;
      const sizes = target.tier === "execute" ? MARKET_SIZES_USD : MARKET_DISPLAY_SIZES_USD;
      const legs = new Map<number, Leg>();
      for (const size of sizes) {
        if (aborted) {
          errors.push({ symbol, code: aborted, size });
          continue;
        }
        if (calls > 0 && this.spacingMs > 0) await this.sleep(this.spacingMs);
        calls += 1;
        const amount = (BigInt(size) * 10n ** BigInt(stable.tokenDecimals)).toString();
        let r: QuoteOutcome;
        try {
          r = await this.quoteOnce(chainIndex, stable, target, amount, size);
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
        underlying: target.underlying,
        address: target.address,
        decimals: target.decimals,
        tier: target.tier,
        priceUsd: mid ? round6(mid.price) : null,
        execPrice1k: l1k ? round6(l1k.price) : null,
        impact1kBps: l1k ? impactBpsOf(l1k, mid?.price ?? null) : null,
        execPrice10k: l10k ? round6(l10k.price) : null,
        impact10kBps: l10k ? impactBpsOf(l10k, mid?.price ?? null) : null,
        receivedAt: first?.receivedAt ?? null,
        route: l1k?.route.length ? l1k.route : (first?.route ?? []),
        // 展示层不给深链：它们不在 Verify 登记表里，/new?stock= 过去会解析失败
        verifyUrl: target.tier === "execute" ? `${this.base}/new?stock=${encodeURIComponent(symbol)}&from=main` : null,
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
  private async quoteOnce(chainIndex: string, stable: RegistryEntry, stock: MarketTarget, amount: string, sizeUsd: number): Promise<QuoteOutcome> {
    let call: OkxCall<OkxQuote[]> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      call = await okxQuote(this.d.okx, { chainIndex, fromTokenAddress: stable.tokenAddress, toTokenAddress: stock.address, amount });
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
    const tokensOut = Number(outRaw) / 10 ** stock.decimals;
    if (!Number.isFinite(tokensOut) || tokensOut <= 0) return { kind: "err", code: "no_route", abort: false };
    return { kind: "ok", price: sizeUsd / tokensOut, impactBps: parseAdverseImpactBps(qd.priceImpactPercent ?? null), receivedAt: call.time.receivedAt, route: routeNames(qd) };
  }
}
