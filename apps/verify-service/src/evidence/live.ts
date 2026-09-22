/**
 * LIVE 证据提供者（Lane B / v5 Lane B2）：OKX DEX quote/swap + OKX RWA 列表 + X Layer RPC 代币元数据/乘数 + Finnhub 参考价。
 *
 * 每条证据都带 requestedAt / receivedAt / sourcePublishedAt(有则填) / rawHash；模式固定 LIVE。
 * 分类规则（CV-D02 → v5 CV-D06）：
 *  - Finnhub quote.t 落在常规时段内 → `pyth_reference` 形态的实时 tick（provider=finnhub，feedId=finnhub:<SYM>）
 *  - v2（默认）：quote.t == 当日常规收盘整点（16:00:00 ET；半日市 13:00:00）且现在已不在常规时段
 *      → `ref_close(closeSource=last_tick, tradingDate=当日)`（"最后一笔成交 = 收盘"是推断，未经确认）；
 *      日线 candle 确认（免费档 403，见 finnhub.candle）或 次日 pc 与已记录 last_tick 一致 → `official` + confirmation
 *    t < 收盘整点 且 已收盘 → 不生成当日 ref_close（数据缺口，由引擎按 tick 记 last_regular_observation）
 *    盘中 / 无当日收盘 → 用 previousClose 生成上一已完成交易日的 `ref_close(official)`，confirmation 由 priorLastTick 决定
 *  - v1（仅回归对照）：旧规则，t ≥ 收盘 → official
 *  - 稳定币美元计价：OKX quote 的稳定币一侧 tokenUnitPrice（USD/代币），provider=okx
 *  - 乘数（W5）：token_meta.multiplier = 链上 getCurrentMultiplier()（已验证源码，adapters/xlayer/multiplier.ts）；
 *    okx_rwa_token.ratio = OKX 列表 tokenToAssetRatio；两者是否一致由规则引擎判断（TOKEN_UNIT_UNVERIFIED / UNIT_CHANGED）
 *  - 方向：输入/输出哪一侧是 stock_output 决定 buy / sell；卖出时对稳定币也出 token_meta
 * 上游失败 → 抛错（创建任务不落库不收费）；单项缺失 → 该证据缺失，由规则引擎给出信息不足。
 * 限频：OKX 同一 key 2 个并发 quote 即 50011（探针 2026-09-20），阶梯默认串行 + 250 ms 间隔 + 50011 重试。
 */
import { createPublicClient, erc20Abi, getAddress, http, type Hex, type PublicClient } from "viem";
import { sessionAt } from "@chaconne/core";
import {
  bpsToPercentString,
  classifyLastTrade,
  confirmLastTick,
  keccak256Utf8,
  parseAdverseImpactBps,
  PLAN_MAX_QUOTES_PER_LEG,
  type AssetRegistry,
  type EvidenceRecord,
  type EvmAddress,
  type NormalizedJob,
  type RawAmount,
  type RegistryEntry,
} from "@chaconne/core/verify";
import { newId } from "../ids";
import { log } from "../log";
import type { FinnhubClient, FinnhubQuote } from "../adapters/finnhub";
import type { XStocksClient } from "../adapters/xstocks";
import { isRateLimited, OkxClient, quote as okxQuote, rwaTokens as okxRwaTokens, swap as okxSwap, type OkxCall, type OkxQuote, type OkxRwaToken } from "../adapters/okx/client";

/**
 * 上游报价拿不到，或调用方把方向写拧了——都不是服务端内部故障。
 * 证据层不引 HttpError（不想把 HTTP 概念倒灌进来），只带一个机器码，由 http/app.ts 映射状态码。
 * V-24 之前这些全是裸 `Error`，一律被兜底成 500 internal，调用方既看不出是行情问题还是自己参数错。
 */
export class UpstreamEvidenceError extends Error {
  constructor(
    readonly code: "no_quotes" | "upstream_unavailable" | "mixed_sides",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "UpstreamEvidenceError";
  }
}
import { checkRouteAgainstIntent, SUPPORTED_ROUTE_SELECTORS } from "../adapters/okx/calldata";
import { readCurrentMultiplier } from "../adapters/xlayer/multiplier";
import { lastCompletedTradingDate, type CollectedEvidence, type CollectOptions, type EvidenceProvider } from "./provider";

export type CloseClassification = "v1" | "v2";
export type TradeSide = "buy" | "sell";

export interface LadderOptions {
  /** 并发数；OKX 限频实测 2 并发即 50011，默认 1 */
  concurrency?: number;
  /** 相邻调用间隔（ms），默认 250 */
  spacingMs?: number;
  /** 50011 重试次数，默认 2；退避基数 ms 默认 600 */
  retries?: number;
  backoffMs?: number;
}

export interface LiveProviderDeps {
  okx: OkxClient;
  finnhub: FinnhubClient | null;
  /** 可选：发行商 API（公开乘数端点），仅监测/探针用，不进 collect 证据 */
  xstocks?: XStocksClient | null;
  rpc?: PublicClient;
  rpcUrl?: string;
  guardAddress: EvmAddress | null;
  /** 路由/授权对象的运营者批准值（Guard 白名单同源）；swap 响应若给出不同地址 → routeSupported=false */
  approvedRouter: EvmAddress | null;
  approvedSpender: EvmAddress | null;
  now?: () => Date;
  /** CV-D06 收盘分类；默认 v2 */
  closeClassification?: CloseClassification;
  /** 已记录的 last_tick 收盘（C2 接库）：返回该标的该交易日的 closeUsd 串或 null；用于次日 pc 确认 */
  priorLastTick?: (underlyingId: string, tradingDate: string) => Promise<string | null>;
  /** 是否尝试 Finnhub 日线 candle 确认（免费档 403；默认 false，避免白费配额） */
  useCandle?: boolean;
  ladder?: LadderOptions;
}

/** 阶梯报价输入：一条腿 = 一个 (输入, 输出) 对 + 若干金额（按输入最小单位） */
export interface LadderLeg {
  legIndex: number;
  inputAssetKey: string;
  outputAssetKey: string;
  amounts: RawAmount[];
}
export interface LadderQuote {
  legIndex: number;
  inputAssetKey: string;
  outputAssetKey: string;
  amountInRaw: RawAmount;
  /** 对应 okx_quote 证据；失败时 null */
  evidenceId: string | null;
  ok: boolean;
  /** 失败原因（rate_limited / upstream:<code> / skipped_cap） */
  error: string | null;
}
export interface LadderResult {
  side: TradeSide;
  quotes: LadderQuote[];
  /** 全部证据：每个金额一条 okx_quote + 共享的 stablecoin_usd / token_meta / okx_rwa_token / 参考价 */
  evidence: EvidenceRecord[];
  /** 实际发出的 quote 调用数（含重试） */
  quoteCalls: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function sideOf(inEntry: RegistryEntry, outEntry: RegistryEntry): TradeSide {
  if (outEntry.role === "stock_output" && inEntry.role === "stable_input") return "buy";
  if (inEntry.role === "stock_output" && outEntry.role === "stable_input") return "sell";
  throw new Error(`不支持的资产对: ${inEntry.role} → ${outEntry.role}`);
}

export class LiveEvidenceProvider implements EvidenceProvider {
  readonly mode = "LIVE" as const;
  private readonly rpc: PublicClient;
  private rwaCache: { at: number; list: OkxRwaToken[]; time: EvidenceRecord["time"]; rawHash: EvidenceRecord["rawHash"] } | null = null;
  private candleCache = new Map<string, { at: number; close: number | null }>();

  constructor(private readonly d: LiveProviderDeps) {
    this.rpc = d.rpc ?? createPublicClient({ transport: http(d.rpcUrl ?? "https://rpc.xlayer.tech") });
  }

  private clock(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  /* ================================================================ */
  /* collect：单笔任务（买入或卖出）                                     */
  /* ================================================================ */
  async collect(job: NormalizedJob, registry: AssetRegistry, nowIso: string, opts: CollectOptions = {}): Promise<CollectedEvidence> {
    const inEntry = registry.entries.find((e) => e.assetKey === job.inputAssetKey);
    const outEntry = registry.entries.find((e) => e.assetKey === job.outputAssetKey);
    if (!inEntry || !outEntry) throw new Error("registry entry missing");
    const side = sideOf(inEntry, outEntry);
    if ((job.side ?? "buy") !== side) throw new Error(`job.side=${job.side ?? "buy"} 与资产角色（${side}）不一致（CV-D09）`);
    const stockEntry = side === "buy" ? outEntry : inEntry;
    const stableEntry = side === "buy" ? inEntry : outEntry;
    const chainIndex = String(job.executionChainId);
    const evidence: EvidenceRecord[] = [];
    const now = Date.parse(nowIso);

    /* ---- 1. OKX quote（exactIn） ---- */
    const { call: q, qd } = await this.quoteOnce(chainIndex, inEntry, outEntry, job.amountInRaw);
    if (q.status === 0 || q.status >= 500) throw new Error(`OKX quote 上游不可用: status=${q.status}`);
    if (isRateLimited(q)) throw new Error("OKX quote 限频（50011），稍后重试");
    let route: CollectedEvidence["route"] = null;
    let routeSupported = false;

    /* ---- 2. OKX swap calldata（Guard 作为 userWalletAddress 与收款地址） ---- */
    const guardForRoute = opts.executorContract ?? this.d.guardAddress;
    if (q.ok && qd && guardForRoute && this.d.approvedRouter && this.d.approvedSpender) {
      const s = await okxSwap(this.d.okx, {
        chainIndex,
        fromTokenAddress: inEntry.tokenAddress,
        toTokenAddress: outEntry.tokenAddress,
        amount: job.amountInRaw,
        slippagePercent: bpsToPercentString(job.params.maxSlippageBps),
        userWalletAddress: guardForRoute,
        swapReceiverAddress: guardForRoute,
      });
      const sd = s.data?.[0];
      if (s.ok && sd?.tx?.to && sd.tx.data) {
        const to = sd.tx.to.toLowerCase();
        const check = checkRouteAgainstIntent(sd.tx.data as Hex, {
          inputToken: inEntry.tokenAddress,
          outputToken: outEntry.tokenAddress,
          amountInRaw: job.amountInRaw,
          deadlineUnix: Math.floor(now / 1000),
          expectedReceiver: guardForRoute,
        });
        const valueZero = !sd.tx.value || BigInt(sd.tx.value) === 0n;
        routeSupported = to === this.d.approvedRouter.toLowerCase() && check.ok && valueZero && SUPPORTED_ROUTE_SELECTORS.has((sd.tx.data as string).slice(0, 10).toLowerCase());
        if (!routeSupported) log.warn("swap 路由不在已验证范围", { to, reasons: check.reasons, valueZero });
        else route = { router: this.d.approvedRouter, spender: this.d.approvedSpender, calldata: sd.tx.data as Hex };
        evidence.push({
          evidenceId: newId("ev"),
          provider: "okx-dex",
          endpoint: "aggregator/swap",
          requestFingerprint: `${chainIndex}:${inEntry.tokenAddress}:${outEntry.tokenAddress}:${job.amountInRaw}:guard`,
          time: s.time,
          block: null,
          rawHash: s.rawHash,
          parserVersion: "okx-swap/1",
          mode: "LIVE",
          payload: {
            kind: "okx_quote",
            chainId: job.executionChainId,
            fromToken: inEntry.tokenAddress,
            toToken: outEntry.tokenAddress,
            amountInRaw: job.amountInRaw,
            expectedOutRaw: sd.routerResult?.toTokenAmount ?? "0",
            priceImpactPercentRaw: sd.routerResult?.priceImpactPercent ?? null,
            adverseImpactBps: parseAdverseImpactBps(sd.routerResult?.priceImpactPercent ?? null),
            routeSummary: [`to:${to}`, `selector:${(sd.tx.data as string).slice(0, 10)}`, ...(check.decoded ? [check.decoded.functionName] : [])],
            routeSupported,
          },
        });
      }
    }

    if (qd) {
      evidence.push(this.quoteRecord(q, qd, inEntry, outEntry, job.amountInRaw, routeSupported || (!guardForRoute && true), ""));
      evidence.push(this.stableUsdRecord(q, qd, stableEntry, side));
    }

    /* ---- 3. 代币链上元数据（股票代币；卖出时稳定币也出一条供输出 decimals 核对） ---- */
    evidence.push(await this.tokenMeta(stockEntry));
    if (side === "sell") evidence.push(await this.tokenMeta(stableEntry));

    /* ---- 4. OKX RWA 列表条目（stockPrice / ratio 乘数） ---- */
    const rwa = await this.rwaEntry(chainIndex, stockEntry, now);
    if (rwa) evidence.push(rwa);

    /* ---- 5. Finnhub 参考价（实时 tick + 收盘） ---- */
    evidence.push(...(await this.referenceRecords(stockEntry, now)));

    return { evidence, route };
  }

  /* ================================================================ */
  /* quoteLadder：规划器的阶梯报价（W1）                                 */
  /* ================================================================ */
  async quoteLadder(legs: LadderLeg[], registry: AssetRegistry, nowIso: string, opts: LadderOptions = {}): Promise<LadderResult> {
    const o = { concurrency: 1, spacingMs: 250, retries: 2, backoffMs: 600, ...this.d.ladder, ...opts };
    const now = Date.parse(nowIso);
    const evidence: EvidenceRecord[] = [];
    const quotes: LadderQuote[] = [];
    let quoteCalls = 0;
    let side: TradeSide | null = null;

    type Task = { leg: LadderLeg; inEntry: RegistryEntry; outEntry: RegistryEntry; amount: RawAmount };
    const tasks: Task[] = [];
    for (const leg of legs) {
      const inEntry = registry.entries.find((e) => e.assetKey === leg.inputAssetKey);
      const outEntry = registry.entries.find((e) => e.assetKey === leg.outputAssetKey);
      if (!inEntry || !outEntry) throw new Error(`registry entry missing for leg ${leg.legIndex}`);
      const s = sideOf(inEntry, outEntry);
      if (side && side !== s) throw new UpstreamEvidenceError("mixed_sides", "一个规划里不能混合买入与卖出", { legIndex: leg.legIndex });
      side = s;
      const chainIndex = String(inEntry.chainId);
      leg.amounts.forEach((amount, i) => {
        if (i >= PLAN_MAX_QUOTES_PER_LEG) {
          quotes.push({ legIndex: leg.legIndex, inputAssetKey: leg.inputAssetKey, outputAssetKey: leg.outputAssetKey, amountInRaw: amount, evidenceId: null, ok: false, error: "skipped_cap" });
          return;
        }
        tasks.push({ leg, inEntry, outEntry, amount });
        void chainIndex;
      });
    }
    if (!side) throw new Error("无腿可报价");

    const stableUsdSeen = new Set<string>();
    const runOne = async (t: Task) => {
      const chainIndex = String(t.inEntry.chainId);
      let call: OkxCall<OkxQuote[]> | null = null;
      let qd: OkxQuote | undefined;
      for (let attempt = 0; attempt <= o.retries; attempt++) {
        const r = await okxQuote(this.d.okx, { chainIndex, fromTokenAddress: t.inEntry.tokenAddress, toTokenAddress: t.outEntry.tokenAddress, amount: t.amount });
        quoteCalls += 1;
        call = r;
        qd = r.data?.[0];
        if (!isRateLimited(r)) break;
        await sleep(o.backoffMs * (attempt + 1));
      }
      if (!call) throw new Error("unreachable");
      if (call.status === 0 || call.status >= 500) throw new UpstreamEvidenceError("upstream_unavailable", `OKX quote 上游不可用: status=${call.status}`, { status: call.status });
      const base = { legIndex: t.leg.legIndex, inputAssetKey: t.leg.inputAssetKey, outputAssetKey: t.leg.outputAssetKey, amountInRaw: t.amount };
      if (!call.ok || !qd) {
        quotes.push({ ...base, evidenceId: null, ok: false, error: isRateLimited(call) ? "rate_limited" : `upstream:${call.code}` });
        return;
      }
      const rec = this.quoteRecord(call, qd, t.inEntry, t.outEntry, t.amount, true, "#ladder");
      evidence.push(rec);
      quotes.push({ ...base, evidenceId: rec.evidenceId, ok: true, error: null });
      const stable = side === "buy" ? t.inEntry : t.outEntry;
      if (!stableUsdSeen.has(stable.assetKey)) {
        stableUsdSeen.add(stable.assetKey);
        evidence.push(this.stableUsdRecord(call, qd, stable, side!));
      }
    };

    // 受限并发池（默认串行）+ 间隔
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, o.concurrency) }, async () => {
      while (cursor < tasks.length) {
        const t = tasks[cursor++]!;
        await runOne(t);
        if (cursor < tasks.length && o.spacingMs > 0) await sleep(o.spacingMs);
      }
    });
    await Promise.all(workers);
    if (tasks.length > 0 && quotes.every((x) => !x.ok)) {
      const first = quotes.find((x) => x.error && x.error !== "skipped_cap");
      throw new UpstreamEvidenceError("no_quotes", `阶梯报价全部失败: ${first?.error ?? "unknown"}`, { firstError: first?.error ?? null, legs: quotes.map((q) => ({ legIndex: q.legIndex, amountInRaw: q.amountInRaw, error: q.error })) });
    }

    // 共享证据：每个股票代币一次 token_meta + rwa + 参考价
    const stocks = new Map<string, RegistryEntry>();
    for (const t of tasks) {
      const st = side === "buy" ? t.outEntry : t.inEntry;
      stocks.set(st.assetKey, st);
    }
    for (const st of stocks.values()) {
      evidence.push(await this.tokenMeta(st));
      const rwa = await this.rwaEntry(String(st.chainId), st, now);
      if (rwa) evidence.push(rwa);
      evidence.push(...(await this.referenceRecords(st, now)));
    }
    if (side === "sell") for (const t of tasks) if (!evidence.some((e) => e.payload.kind === "token_meta" && e.payload.tokenAddress === t.outEntry.tokenAddress)) evidence.push(await this.tokenMeta(t.outEntry));

    quotes.sort((a, b) => a.legIndex - b.legIndex || (BigInt(b.amountInRaw) > BigInt(a.amountInRaw) ? 1 : -1));
    return { side, quotes, evidence, quoteCalls };
  }

  /* ================================================================ */
  /* 内部构件                                                           */
  /* ================================================================ */
  private async quoteOnce(chainIndex: string, inEntry: RegistryEntry, outEntry: RegistryEntry, amount: RawAmount): Promise<{ call: OkxCall<OkxQuote[]>; qd: OkxQuote | undefined }> {
    const o = { retries: 2, backoffMs: 600, ...this.d.ladder };
    let call: OkxCall<OkxQuote[]> | null = null;
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      call = await okxQuote(this.d.okx, { chainIndex, fromTokenAddress: inEntry.tokenAddress, toTokenAddress: outEntry.tokenAddress, amount });
      if (!isRateLimited(call)) break;
      await sleep(o.backoffMs * (attempt + 1));
    }
    return { call: call!, qd: call!.data?.[0] };
  }

  private quoteRecord(q: OkxCall<OkxQuote[]>, qd: OkxQuote, inEntry: RegistryEntry, outEntry: RegistryEntry, amount: RawAmount, routeSupported: boolean, suffix: string): EvidenceRecord {
    return {
      evidenceId: newId("ev"),
      provider: "okx-dex",
      endpoint: `aggregator/quote${suffix}`,
      requestFingerprint: `${inEntry.chainId}:${inEntry.tokenAddress}:${outEntry.tokenAddress}:${amount}`,
      time: q.time,
      block: null,
      rawHash: q.rawHash,
      parserVersion: "okx-quote/1",
      mode: "LIVE",
      payload: {
        kind: "okx_quote",
        chainId: inEntry.chainId,
        fromToken: inEntry.tokenAddress,
        toToken: outEntry.tokenAddress,
        amountInRaw: amount,
        expectedOutRaw: qd.toTokenAmount ?? "0",
        priceImpactPercentRaw: qd.priceImpactPercent ?? null,
        adverseImpactBps: parseAdverseImpactBps(qd.priceImpactPercent ?? null),
        routeSummary: (qd.dexRouterList ?? []).flatMap((r) => (r.subRouterList ?? []).flatMap((s) => (s.dexProtocol ?? []).map((p) => `${p.dexName ?? "?"}:${p.percent ?? "?"}`))),
        routeSupported,
      },
    };
  }

  /** 稳定币美元计价：稳定币在哪一侧就取哪一侧的 tokenUnitPrice */
  private stableUsdRecord(q: OkxCall<OkxQuote[]>, qd: OkxQuote, stableEntry: RegistryEntry, side: TradeSide): EvidenceRecord {
    const tok = side === "buy" ? qd.fromToken : qd.toToken;
    const unit = tok?.tokenUnitPrice;
    return {
      evidenceId: newId("ev"),
      provider: "okx-dex",
      endpoint: side === "buy" ? "aggregator/quote#fromToken.tokenUnitPrice" : "aggregator/quote#toToken.tokenUnitPrice",
      requestFingerprint: `${stableEntry.chainId}:${stableEntry.tokenAddress}:usd`,
      time: q.time,
      block: null,
      rawHash: q.rawHash,
      parserVersion: "okx-quote-unitprice/1",
      mode: "LIVE",
      payload: {
        kind: "stablecoin_usd",
        tokenAddress: stableEntry.tokenAddress,
        chainId: stableEntry.chainId,
        usdPerToken: unit && /^\d+(\.\d+)?$/.test(unit) && Number(unit) > 0 ? unit : null,
        method: side === "buy" ? "okx_quote_from_token_unit_price" : "okx_quote_to_token_unit_price",
      },
    };
  }

  /** 代币链上元数据；xStocks rebasing 代币加读链上乘数（已验证函数 getCurrentMultiplier，1e18） */
  private async tokenMeta(entry: RegistryEntry): Promise<EvidenceRecord> {
    const requestedAt = this.clock().toISOString();
    const addr = getAddress(entry.tokenAddress);
    const wantMultiplier = entry.tokenForm === "rebasing" && entry.issuerId === "xstocks";
    const [decimals, symbol, block, mult] = await Promise.all([
      this.rpc.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
      this.rpc.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
      this.rpc.getBlock().catch(() => null),
      wantMultiplier ? readCurrentMultiplier(this.rpc, addr) : Promise.resolve(null),
    ]);
    const receivedAt = this.clock().toISOString();
    const raw = JSON.stringify({ decimals, symbol, block: block ? block.number.toString() : null, multiplier: mult ? mult.raw.toString() : null, multiplierNonce: mult ? mult.nonce.toString() : null });
    return {
      evidenceId: newId("ev"),
      provider: "xlayer-rpc",
      endpoint: wantMultiplier ? "eth_call:erc20(decimals,symbol)+getCurrentMultiplier()" : "eth_call:erc20(decimals,symbol)",
      requestFingerprint: `${entry.chainId}:${entry.tokenAddress}:meta`,
      time: { requestedAt, receivedAt, sourcePublishedAt: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null, sourceTimeKind: block ? "block" : "not_provided" },
      block: block ? { chainId: entry.chainId, blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString() } : null,
      rawHash: keccak256Utf8(raw),
      parserVersion: wantMultiplier ? "erc20-meta/2" : "erc20-meta/1",
      mode: "LIVE",
      payload: { kind: "token_meta", chainId: entry.chainId, tokenAddress: entry.tokenAddress, decimals: typeof decimals === "number" ? decimals : null, symbol: typeof symbol === "string" ? symbol : null, multiplier: mult ? mult.decimal : null },
    };
  }

  private async rwaEntry(chainIndex: string, entry: RegistryEntry, now: number): Promise<EvidenceRecord | null> {
    if (!this.rwaCache || now - this.rwaCache.at > 60_000) {
      const r = await okxRwaTokens(this.d.okx, { chainIndex, issuer: "36" });
      if (!r.ok) return null;
      this.rwaCache = { at: now, list: r.data?.list ?? [], time: r.time, rawHash: r.rawHash };
    }
    const t = this.rwaCache.list.find((x) => x.tokenContractAddress.toLowerCase() === entry.tokenAddress);
    if (!t) return null;
    const dec = (v: string | undefined) => (v && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? v : null);
    return {
      evidenceId: newId("ev"),
      provider: "okx-market",
      endpoint: "dex/market/rwa/tokens",
      requestFingerprint: `${chainIndex}:issuer36`,
      time: this.rwaCache.time,
      block: null,
      rawHash: this.rwaCache.rawHash,
      parserVersion: "okx-rwa/2",
      mode: "LIVE",
      payload: { kind: "okx_rwa_token", chainId: Number(chainIndex), tokenAddress: entry.tokenAddress, issuer: t.issuer, priceUsd: dec(t.price), stockPriceUsd: dec(t.stockPrice), ratio: dec(t.tokenToAssetRatio) },
    };
  }

  /** Finnhub 参考价记录（含 CV-D06 确认输入的解析） */
  private async referenceRecords(stockEntry: RegistryEntry, now: number): Promise<EvidenceRecord[]> {
    if (!this.d.finnhub || stockEntry.role !== "stock_output") return [];
    const sym = stockEntry.underlyingId.split(":")[1] ?? stockEntry.displaySymbol.replace(/x$/, "");
    const f = await this.d.finnhub.quote(sym);
    if (!f.ok || !f.data) {
      log.warn("Finnhub 参考价不可用", { status: f.status, sym });
      return [];
    }
    const tInfo = sessionAt(new Date(f.data.t * 1000));
    const prevDate = lastCompletedTradingDate(new Date(now));
    const confirm: CloseConfirmInputs = { candleClose: null, priorLastTickPrev: null };
    if ((this.d.closeClassification ?? "v2") === "v2") {
      if (this.d.priorLastTick) confirm.priorLastTickPrev = await this.d.priorLastTick(stockEntry.underlyingId, prevDate).catch(() => null);
      if (this.d.useCandle) confirm.candleClose = await this.candleClose(sym, tInfo.nyDate, now);
    }
    return this.classifyFinnhub(sym, stockEntry, f.data, f.time, f.rawHash, now, confirm);
  }

  private async candleClose(sym: string, nyDate: string, now: number): Promise<number | null> {
    if (!this.d.finnhub) return null;
    const key = `${sym}:${nyDate}`;
    const c = this.candleCache.get(key);
    if (c && now - c.at < 10 * 60_000) return c.close;
    const to = Math.floor(now / 1000);
    const r = await this.d.finnhub.candle(sym, to - 7 * 86_400, to).catch(() => null);
    let close: number | null = null;
    if (r?.ok && r.data) {
      const i = r.data.times.findIndex((t) => new Date(t * 1000).toISOString().slice(0, 10) === nyDate);
      close = i >= 0 ? (r.data.closes[i] ?? null) : null;
    }
    this.candleCache.set(key, { at: now, close });
    return close;
  }

  /** Finnhub tick → 实时参考 / 收盘参考（CV-D02 v1 / CV-D06 v2 分类规则） */
  classifyFinnhub(sym: string, entry: RegistryEntry, qd: FinnhubQuote, time: EvidenceRecord["time"], rawHash: EvidenceRecord["rawHash"], now: number, confirm: CloseConfirmInputs = { candleClose: null, priorLastTickPrev: null }): EvidenceRecord[] {
    const out: EvidenceRecord[] = [];
    const tInfo = sessionAt(new Date(qd.t * 1000));
    const regularEnd = tInfo.isHalfDay ? 13 * 60 : 16 * 60;
    const v2 = (this.d.closeClassification ?? "v2") === "v2";
    const base = { provider: "finnhub", requestFingerprint: `quote:${sym}`, block: null, rawHash, parserVersion: v2 ? "finnhub-quote/2" : "finnhub-quote/1", mode: "LIVE" as const };

    // 实时 tick（源时间 = 最新成交时间）
    out.push({
      evidenceId: newId("ev"),
      ...base,
      endpoint: "quote#c",
      time,
      payload: { kind: "pyth_reference", underlyingId: entry.underlyingId, feedId: `finnhub:${sym}`, priceUsd: String(qd.current), confBps: null, sessionAtPublish: tInfo.session, tradingDate: tInfo.nyDate },
    });

    const pushPrevClose = (confirmation: NonNullable<Extract<EvidenceRecord["payload"], { kind: "ref_close" }>["confirmation"]> | null) => {
      if (!(qd.previousClose > 0)) return;
      const prevDate = lastCompletedTradingDate(new Date(now));
      out.push({
        evidenceId: newId("ev"),
        ...base,
        endpoint: "quote#pc",
        time: { ...time, sourcePublishedAt: null, sourceTimeKind: "not_provided" },
        payload: { kind: "ref_close", underlyingId: entry.underlyingId, closeUsd: String(qd.previousClose), tradingDate: prevDate, closeSource: "official", ...(v2 ? { confirmation } : {}) },
      });
    };

    if (!v2) {
      // 旧规则（CV-D02）：最新成交已到该交易日收盘 → 当日 official；否则 previousClose
      const tIsClose = (tInfo.session === "REGULAR" || tInfo.session === "POST" || tInfo.session === "CLOSED") && tInfo.nyMinutes >= regularEnd - 1 && tInfo.nyMinutes <= 20 * 60;
      if (tIsClose && qd.current > 0) {
        out.push({ evidenceId: newId("ev"), ...base, endpoint: "quote#c@close", time, payload: { kind: "ref_close", underlyingId: entry.underlyingId, closeUsd: String(qd.current), tradingDate: tInfo.nyDate, closeSource: "official" } });
      } else pushPrevClose(null);
      return out;
    }

    // v2（CV-D06）：分类交给 core.classifyLastTrade（与规则引擎同一口径）
    const nowIso = new Date(now).toISOString();
    const cls = qd.current > 0 ? classifyLastTrade({ tUnixSec: qd.t, nowIso }) : null;
    if (cls) {
      const recorded: Extract<EvidenceRecord["payload"], { kind: "ref_close" }> = { kind: "ref_close", underlyingId: entry.underlyingId, closeUsd: String(qd.current), tradingDate: cls.tradingDate, closeSource: cls.closeSource, confirmation: null };
      const confirmed = cls.closeSource === "last_tick" && confirm.candleClose !== null ? confirmLastTick(recorded, { method: "candle", closeUsd: String(confirm.candleClose), confirmedAt: time.receivedAt }) : null;
      out.push({ evidenceId: newId("ev"), ...base, endpoint: confirmed ? "quote#c@close+candle" : cls.closeSource === "last_tick" ? "quote#c@close" : "quote#c@gap", time, payload: confirmed ?? recorded });
      return out;
    }
    // 盘中 / 盘后新 tick：只用 previousClose 记上一已完成交易日；若已记录该日 last_tick 且与 pc 一致 → 次日 pc 确认（official + confirmation）
    const prevDate = lastCompletedTradingDate(new Date(now));
    const prior = confirm.priorLastTickPrev !== null ? confirmLastTick({ kind: "ref_close", underlyingId: entry.underlyingId, closeUsd: confirm.priorLastTickPrev, tradingDate: prevDate, closeSource: "last_tick", confirmation: null }, { method: "next_day_pc", closeUsd: String(qd.previousClose), confirmedAt: time.receivedAt }) : null;
    pushPrevClose(prior?.confirmation ?? null);
    return out;
  }
}

export interface CloseConfirmInputs {
  /** 日线 candle 当日收盘（免费档不可用 → null） */
  candleClose: number | null;
  /** 已记录的上一交易日 last_tick closeUsd（C2 接库）；null = 无记录 */
  priorLastTickPrev: string | null;
}
