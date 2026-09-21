/**
 * v5 Lane B2 · REPLAY（2026-09-20/21 录制的真实 OKX 响应 + 构造的 Finnhub/RPC 应答）：
 * 阶梯报价（PL-07 上限/并发/指纹）、卖出报价与 calldata（PL-06）、乘数证据（T-03）、收盘分类（T-01/T-02）、单位变化回放样本（T-05 数据侧）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { validateCreateJob, type EvidenceRecord } from "@chaconne/core/verify";
import { FinnhubClient } from "../src/adapters/finnhub";
import { OkxClient } from "../src/adapters/okx/client";
import { decodeRouterCalldata } from "../src/adapters/okx/calldata";
import { XStocksClient } from "../src/adapters/xstocks";
import { multiplierMatchesRatio, multiplierToDecimal, readCurrentMultiplier } from "../src/adapters/xlayer/multiplier";
import { LiveEvidenceProvider, sideOf, type LiveProviderDeps } from "../src/evidence/live";
import { loadRegistry } from "../src/registry";

const FIX = join(__dirname, "fixtures", "okx");
const load = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), "utf8")) as { data: unknown };
const REG11 = join(__dirname, "..", "config", "registry.xlayer.v1.1.json");
const registry = loadRegistry({ REGISTRY_MODE: "file", REGISTRY_FILE: REG11, EXECUTION_CHAIN_ID: 196 });
const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const NVDAX = "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const GUARD = "0x4444444444444444444444444444444444444444" as const;
const ROUTER = "0x7c5bee2a8091c3ef39072f64f18fac913060aeaf" as const;
const SPENDER = "0x8b773d83bc66be128c60e07e17c8901f7a64f000" as const;
const MULT = 1003269012539818700n;

interface FetchOpts {
  finnhub: { c: number; pc: number; t: number };
  /** 第 n 次遇到该金额时返回 50011（模拟限频） */
  rateLimitOnce?: Set<string>;
  candle?: { status: number; body: unknown };
  onCall?: (url: string) => void;
}
function fakeFetch(o: FetchOpts): typeof fetch {
  const limited = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const f = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    o.onCall?.(url);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const body = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
    const u = new URL(url);
    if (u.pathname.endsWith("/dex/aggregator/quote")) {
      const amount = u.searchParams.get("amount")!;
      const from = u.searchParams.get("fromTokenAddress")!.toLowerCase();
      if (o.rateLimitOnce?.has(amount) && !limited.has(amount)) {
        limited.add(amount);
        return body({ code: "50011", msg: "Too Many Requests", data: null }, 200);
      }
      if (from === "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a") return body({ code: "0", msg: "", data: load("V5_sell_quote").data });
      const name = `V5_ladder_quote_${amount}`;
      try {
        return body({ code: "0", msg: "", data: load(name).data });
      } catch {
        return body({ code: "0", msg: "", data: load("V5_ladder_quote_2500000").data });
      }
    }
    if (u.pathname.endsWith("/dex/aggregator/swap")) {
      const from = u.searchParams.get("fromTokenAddress")!.toLowerCase();
      return body({ code: "0", msg: "", data: load(from === "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a" ? "V5_sell_swap" : "P3_swap_USDG").data });
    }
    if (u.pathname.endsWith("/dex/market/rwa/tokens")) return body({ code: "0", msg: "", data: load("V5_rwa_tokens").data });
    if (u.hostname.includes("finnhub.io") && u.pathname.includes("/stock/candle")) return body(o.candle?.body ?? { error: "You don't have access to this resource." }, o.candle?.status ?? 403);
    if (u.hostname.includes("finnhub.io")) return body({ c: o.finnhub.c, pc: o.finnhub.pc, t: o.finnhub.t, h: 0, l: 0, o: 0 });
    if (u.hostname.includes("xstocks.fi") && u.pathname.includes("/multiplier")) return body({ currentMultiplier: 1.0032690125398187, newMultiplier: 0, activationDateTime: 0, reason: null });
    if (u.hostname.includes("xstocks.fi") && u.pathname.includes("corporate-actions")) return body({ error: "Internal server error", message: "Unauthenticated" }, 500);
    return new Response("not found", { status: 404 });
  }) as typeof fetch & { maxInFlight(): number };
  (f as { maxInFlight: () => number }).maxInFlight = () => maxInFlight;
  return f;
}

function fakeRpc(nowSec: number, mult: bigint | null = MULT): PublicClient {
  return {
    readContract: async ({ functionName, address }: { functionName: string; address: string }) => {
      if (functionName === "decimals") return address.toLowerCase() === "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8" ? 6 : 18;
      if (functionName === "symbol") return address.toLowerCase() === "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8" ? "USDG" : "AAPLx";
      if (functionName === "getCurrentMultiplier") {
        if (mult === null) throw new Error("execution reverted");
        return [mult, 0n, 5n];
      }
      throw new Error("unexpected");
    },
    getBlock: async () => ({ number: 71134841n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(nowSec) }),
  } as unknown as PublicClient;
}

function provider(nowIso: string, fetchOpts: FetchOpts, extra: Partial<LiveProviderDeps> = {}, mult: bigint | null = MULT) {
  const f = fakeFetch(fetchOpts);
  const nowSec = Math.floor(Date.parse(nowIso) / 1000);
  const clock = () => new Date(nowSec * 1000);
  const p = new LiveEvidenceProvider({
    okx: new OkxClient({ apiKey: "k", secretKey: "s", passphrase: "p" }, f, clock),
    finnhub: new FinnhubClient("fk", f, undefined, clock),
    rpc: fakeRpc(nowSec, mult),
    now: clock,
    guardAddress: GUARD,
    approvedRouter: ROUTER,
    approvedSpender: SPENDER,
    ladder: { spacingMs: 0, backoffMs: 1 },
    ...extra,
  });
  return { p, f: f as typeof fetch & { maxInFlight(): number } };
}

const SAT = "2026-09-20T11:31:36.000Z"; // 周六休市
const FRI_CLOSE_T = 1789761600; // 2026-09-18T20:00:00Z = 16:00:00 ET
const kinds = (ev: EvidenceRecord[]) => ev.map((e) => e.payload.kind).sort();

describe("quoteLadder（PL-07 / W1 数据）", () => {
  it("每个金额一条 okx_quote（指纹含金额）、共享证据各一条、串行不并发、默认阶梯", async () => {
    const { p, f } = provider(SAT, { finnhub: { c: 336.13, pc: 337, t: FRI_CLOSE_T } });
    const r = await p.quoteLadder([{ legIndex: 0, inputAssetKey: USDG, outputAssetKey: AAPLX, amounts: ["5000000", "3750000", "2500000", "1250000", "500000"] }], registry, SAT);
    expect(r.side).toBe("buy");
    expect(r.quotes.map((q) => q.amountInRaw)).toEqual(["5000000", "3750000", "2500000", "1250000", "500000"]);
    expect(r.quotes.every((q) => q.ok && q.evidenceId)).toBe(true);
    const qs = r.evidence.filter((e) => e.payload.kind === "okx_quote");
    expect(qs).toHaveLength(5);
    expect(new Set(qs.map((e) => e.requestFingerprint)).size).toBe(5);
    expect(qs[0]!.requestFingerprint).toMatch(/:5000000$/);
    const fixtureOut = (a: string) => (load(`V5_ladder_quote_${a}`).data as Array<{ toTokenAmount: string }>)[0]!.toTokenAmount;
    expect(qs.map((e) => (e.payload as { expectedOutRaw: string }).expectedOutRaw)).toEqual(["5000000", "3750000", "2500000", "1250000", "500000"].map(fixtureOut));
    expect(r.evidence.filter((e) => e.payload.kind === "stablecoin_usd")).toHaveLength(1);
    expect(r.evidence.filter((e) => e.payload.kind === "token_meta")).toHaveLength(1);
    expect(r.evidence.filter((e) => e.payload.kind === "okx_rwa_token")).toHaveLength(1);
    expect(r.evidence.filter((e) => e.payload.kind === "pyth_reference")).toHaveLength(1);
    expect(r.quoteCalls).toBe(5);
    expect(f.maxInFlight()).toBe(1);
  });

  it("每腿上限 PLAN_MAX_QUOTES_PER_LEG=8：第 9 个金额标 skipped_cap 且不调用上游", async () => {
    let quoteCalls = 0;
    const { p } = provider(SAT, { finnhub: { c: 336.13, pc: 337, t: FRI_CLOSE_T }, onCall: (u) => u.includes("aggregator/quote") && quoteCalls++ });
    const amounts = Array.from({ length: 9 }, (_, i) => String(5_000_000 - i * 100_000));
    const r = await p.quoteLadder([{ legIndex: 0, inputAssetKey: USDG, outputAssetKey: AAPLX, amounts }], registry, SAT);
    expect(quoteCalls).toBe(8);
    expect(r.quotes.filter((q) => q.error === "skipped_cap")).toHaveLength(1);
    expect(r.quotes.filter((q) => q.ok)).toHaveLength(8);
  });

  it("50011 限频：退避重试后成功，quoteCalls 计入重试；两腿（AAPLx/NVDAx）各自共享证据", async () => {
    const { p } = provider(SAT, { finnhub: { c: 336.13, pc: 337, t: FRI_CLOSE_T }, rateLimitOnce: new Set(["2500000"]) });
    const r = await p.quoteLadder(
      [
        { legIndex: 0, inputAssetKey: USDG, outputAssetKey: AAPLX, amounts: ["2500000", "1250000"] },
        { legIndex: 1, inputAssetKey: USDG, outputAssetKey: NVDAX, amounts: ["2500000"] },
      ],
      registry,
      SAT,
    );
    expect(r.quotes.filter((q) => q.ok)).toHaveLength(3);
    expect(r.quoteCalls).toBe(4);
    expect(r.evidence.filter((e) => e.payload.kind === "token_meta")).toHaveLength(2);
    expect(r.evidence.filter((e) => e.payload.kind === "okx_rwa_token").map((e) => (e.payload as { tokenAddress: string }).tokenAddress).sort()).toEqual(["0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", "0xc845b2894dbddd03858fd2d643b4ef725fe0849d"]);
    expect(r.evidence.filter((e) => e.payload.kind === "stablecoin_usd")).toHaveLength(1);
  });

  it("买卖混合的腿拒绝；非法资产对拒绝", async () => {
    const { p } = provider(SAT, { finnhub: { c: 336.13, pc: 337, t: FRI_CLOSE_T } });
    await expect(p.quoteLadder([{ legIndex: 0, inputAssetKey: USDG, outputAssetKey: AAPLX, amounts: ["1"] }, { legIndex: 1, inputAssetKey: AAPLX, outputAssetKey: USDG, amounts: ["1"] }], registry, SAT)).rejects.toThrow(/混合/);
    const usdg = registry.entries.find((e) => e.assetKey === USDG)!;
    expect(() => sideOf(usdg, usdg)).toThrow(/不支持/);
  });
});

describe("卖出方向（PL-06 数据 / W2 前提）", () => {
  const sellJob = () => {
    const v = validateCreateJob({ clientRequestId: "sell", ownerAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", recipientAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", executionChainId: 196, inputAssetKey: AAPLX, outputAssetKey: USDG, amountInRaw: "5000000000000000", mode: "exactIn", side: "sell", policyId: "QUOTE_ONLY", policyVersion: "1.0.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: null });
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    return v.job;
  };
  it("collect：AAPLx → USDG 报价、swap(dagSwapTo, receiver=Guard) 路由可用、稳定币美元取 toToken、两条 token_meta、乘数在股票一侧；缺 side=sell 拒绝（CV-D09）", async () => {
    const { p } = provider(SAT, { finnhub: { c: 336.13, pc: 337, t: FRI_CLOSE_T } });
    await expect(p.collect({ ...sellJob(), side: undefined }, registry, SAT)).rejects.toThrow(/CV-D09/);
    const r = await p.collect(sellJob(), registry, SAT);
    expect(r.route).not.toBeNull();
    const d = decodeRouterCalldata(r.route!.calldata)!;
    expect(d).toMatchObject({ functionName: "dagSwapTo", fromToken: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", toToken: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", fromTokenAmount: "5000000000000000", receiver: GUARD });
    expect(BigInt(d.minReturnAmount) > 1_600_000n).toBe(true); // ≈1.66 USDG for 0.005 AAPLx
    const usd = r.evidence.find((e) => e.payload.kind === "stablecoin_usd")!;
    expect(usd.endpoint).toBe("aggregator/quote#toToken.tokenUnitPrice");
    expect(usd.payload).toMatchObject({ tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", usdPerToken: "1", method: "okx_quote_to_token_unit_price" });
    const metas = r.evidence.filter((e) => e.payload.kind === "token_meta").map((e) => e.payload as { tokenAddress: string; decimals: number | null; multiplier: string | null });
    expect(metas).toHaveLength(2);
    expect(metas.find((m) => m.tokenAddress === "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a")).toMatchObject({ decimals: 18, multiplier: "1.003269012539818700" });
    expect(metas.find((m) => m.tokenAddress === "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8")).toMatchObject({ decimals: 6, multiplier: null });
    expect(kinds(r.evidence)).toEqual(["okx_quote", "okx_quote", "okx_rwa_token", "pyth_reference", "ref_close", "stablecoin_usd", "token_meta", "token_meta"]);
  });
});

describe("乘数证据（T-03 数据侧）", () => {
  it("token_meta.multiplier 来自链上 getCurrentMultiplier（1e18 → 18 位小数串）；okx_rwa_token.ratio 来自列表；一致性判断", async () => {
    const { p } = provider(SAT, { finnhub: { c: 336.13, pc: 337, t: FRI_CLOSE_T } });
    const v = validateCreateJob({ clientRequestId: "buy", ownerAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", recipientAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", executionChainId: 196, inputAssetKey: USDG, outputAssetKey: AAPLX, amountInRaw: "2500000", mode: "exactIn", policyId: "QUOTE_ONLY", policyVersion: "1.0.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: null });
    if (!v.ok) throw new Error();
    const r = await p.collect(v.job, registry, SAT);
    const meta = r.evidence.find((e) => e.payload.kind === "token_meta")!;
    expect(meta.endpoint).toContain("getCurrentMultiplier()");
    expect((meta.payload as { multiplier: string }).multiplier).toBe("1.003269012539818700");
    const rwa = r.evidence.find((e) => e.payload.kind === "okx_rwa_token")!.payload as { ratio: string | null };
    expect(rwa.ratio).toBe("1.003269");
    expect(multiplierMatchesRatio("1.003269012539818700", "1.003269")).toBe(true);
    expect(multiplierMatchesRatio("1.003269012539818700", "1.010000")).toBe(false);
    expect(multiplierMatchesRatio("1.003269012539818700", null)).toBeNull();
  });

  it("合约无该函数（非 xStocks）→ multiplier=null 不报错；multiplierToDecimal 精确", async () => {
    const { p } = provider(SAT, { finnhub: { c: 336.13, pc: 337, t: FRI_CLOSE_T } }, {}, null);
    const v = validateCreateJob({ clientRequestId: "buy", ownerAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", recipientAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", executionChainId: 196, inputAssetKey: USDG, outputAssetKey: AAPLX, amountInRaw: "2500000", mode: "exactIn", policyId: "QUOTE_ONLY", policyVersion: "1.0.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: null });
    if (!v.ok) throw new Error();
    const r = await p.collect(v.job, registry, SAT);
    expect((r.evidence.find((e) => e.payload.kind === "token_meta")!.payload as { multiplier: string | null }).multiplier).toBeNull();
    expect(multiplierToDecimal(1003269012539818700n)).toBe("1.003269012539818700");
    expect(multiplierToDecimal(5n * 10n ** 18n)).toBe("5.000000000000000000");
    expect(multiplierToDecimal(511136000000000000n)).toBe("0.511136000000000000");
    expect(await readCurrentMultiplier(fakeRpc(0, null), "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a")).toBeNull();
  });

  it("xStocks 公开乘数端点解析；公司行动端点无 key → ok=false", async () => {
    const f = fakeFetch({ finnhub: { c: 0, pc: 0, t: 0 } });
    const x = new XStocksClient(null, f);
    const m = await x.tokenMultiplier("AAPLx");
    expect(m.ok).toBe(true);
    expect(m.data?.currentMultiplier).toBeCloseTo(1.0032690125398187, 12);
    expect(m.endpoint).toBe("token/AAPLx/multiplier");
    const ca = await x.corporateActions({ tokenSymbol: "AAPLx" });
    expect(ca.ok).toBe(false);
    expect(ca.status).toBe(500);
  });
});

describe("收盘分类 CV-D06（T-01 / T-02 数据侧）", () => {
  const refClose = (ev: EvidenceRecord[]) => ev.filter((e) => e.payload.kind === "ref_close").map((e) => e.payload as Extract<EvidenceRecord["payload"], { kind: "ref_close" }>);
  const tick = (ev: EvidenceRecord[]) => ev.find((e) => e.payload.kind === "pyth_reference")!.payload as Extract<EvidenceRecord["payload"], { kind: "pyth_reference" }>;
  const stock = registry.entries.find((e) => e.assetKey === AAPLX)!;
  const mk = (nowIso: string, fh: { c: number; pc: number; t: number }, extra: Partial<LiveProviderDeps> = {}) => provider(nowIso, { finnhub: fh, candle: extra.useCandle ? { status: 200, body: { s: "ok", c: [336.13], t: [Math.floor(Date.UTC(2026, 8, 18) / 1000)] } } : undefined }, extra).p;
  const classify = (p: LiveEvidenceProvider, nowIso: string, fh: { c: number; pc: number; t: number }, confirm?: { candleClose: number | null; priorLastTickPrev: string | null }) =>
    p.classifyFinnhub("AAPL", stock, { current: fh.c, previousClose: fh.pc, t: fh.t, high: 0, low: 0, open: 0 }, { requestedAt: nowIso, receivedAt: nowIso, sourcePublishedAt: new Date(fh.t * 1000).toISOString(), sourceTimeKind: "published" }, `0x${"11".repeat(32)}`, Date.parse(nowIso), confirm);

  it("T-01 9/18 真实样本（c=336.13, t=16:00:00 ET, pc=337）在周六 → close_last_tick，未确认；pc 不再当作 9/18 收盘", () => {
    const out = classify(mk(SAT, { c: 336.13, pc: 337, t: FRI_CLOSE_T }), SAT, { c: 336.13, pc: 337, t: FRI_CLOSE_T });
    expect(refClose(out)).toEqual([expect.objectContaining({ closeUsd: "336.13", tradingDate: "2026-09-18", closeSource: "last_tick", confirmation: null })]);
    expect(tick(out)).toMatchObject({ sessionAtPublish: "POST", tradingDate: "2026-09-18" });
  });

  it("t = 15:59:30（收盘前最后成交）且当日已收盘 → 数据缺口：当日记 closeSource=pyth（引擎 → last_regular_observation），不用 pc 冒充", () => {
    const t = FRI_CLOSE_T - 30;
    const out = classify(mk(SAT, { c: 336.0, pc: 337, t }), SAT, { c: 336.0, pc: 337, t });
    const closes = refClose(out);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ closeUsd: "336", tradingDate: "2026-09-18", closeSource: "pyth", confirmation: null });
    expect(out.find((e) => e.payload.kind === "ref_close")!.endpoint).toBe("quote#c@gap");
  });

  it("盘后新成交（16:00:05）→ tick 记 POST，无当日收盘", () => {
    const t = FRI_CLOSE_T + 5;
    const out = classify(mk(SAT, { c: 336.2, pc: 337, t }), SAT, { c: 336.2, pc: 337, t });
    expect(refClose(out).every((c) => c.tradingDate !== "2026-09-18" || c.closeSource === "official")).toBe(true);
    expect(refClose(out).find((c) => c.closeSource === "last_tick")).toBeUndefined();
    expect(tick(out).sessionAtPublish).toBe("POST");
  });

  it("T-02 次日 pc 确认：周一盘中 pc=336.13 且已记录 9/18 的 last_tick=336.13 → 9/18 official + next_day_pc；无记录 → confirmation=null", async () => {
    const MON = "2026-09-21T15:00:00.000Z"; // 周一 11:00 ET
    const monT = Math.floor(Date.parse(MON) / 1000) - 5;
    const fh = { c: 338.5, pc: 336.13, t: monT };
    const withRecord = mk(MON, fh, { priorLastTick: async (u, d) => (u === "us-equity:AAPL" && d === "2026-09-18" ? "336.13" : null) });
    const v = validateCreateJob({ clientRequestId: "mon", ownerAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", recipientAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", executionChainId: 196, inputAssetKey: USDG, outputAssetKey: AAPLX, amountInRaw: "2500000", mode: "exactIn", policyId: "REFERENCE_CONTEXT", policyVersion: "1.0.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300 });
    if (!v.ok) throw new Error();
    const r1 = await withRecord.collect(v.job, registry, MON);
    expect(refClose(r1.evidence)).toEqual([expect.objectContaining({ closeUsd: "336.13", tradingDate: "2026-09-18", closeSource: "official", confirmation: expect.objectContaining({ method: "next_day_pc", matchedUsd: "336.13" }) })]);
    expect(tick(r1.evidence)).toMatchObject({ sessionAtPublish: "REGULAR", tradingDate: "2026-09-21" });
    const noRecord = mk(MON, fh, { priorLastTick: async () => null });
    const r2 = await noRecord.collect(v.job, registry, MON);
    expect(refClose(r2.evidence)[0]).toMatchObject({ closeSource: "official", confirmation: null });
    const mismatch = mk(MON, fh, { priorLastTick: async () => "336.00" });
    const r3 = await mismatch.collect(v.job, registry, MON);
    expect(refClose(r3.evidence)[0]).toMatchObject({ closeSource: "official", confirmation: null });
  });

  it("candle 确认（若上游可用）：当日收盘与 last_tick 一致 → official + candle；免费档 403 → 保持 last_tick", async () => {
    const v = validateCreateJob({ clientRequestId: "c", ownerAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", recipientAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", executionChainId: 196, inputAssetKey: USDG, outputAssetKey: AAPLX, amountInRaw: "2500000", mode: "exactIn", policyId: "REFERENCE_CONTEXT", policyVersion: "1.0.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300 });
    if (!v.ok) throw new Error();
    const fh = { c: 336.13, pc: 337, t: FRI_CLOSE_T };
    const withCandle = mk(SAT, fh, { useCandle: true });
    const r1 = await withCandle.collect(v.job, registry, SAT);
    expect(refClose(r1.evidence)[0]).toMatchObject({ closeSource: "official", tradingDate: "2026-09-18", confirmation: expect.objectContaining({ method: "candle", matchedUsd: "336.13" }) });
    const noCandle = provider(SAT, { finnhub: fh, candle: { status: 403, body: { error: "You don't have access to this resource." } } }, { useCandle: true }).p;
    const r2 = await noCandle.collect(v.job, registry, SAT);
    expect(refClose(r2.evidence)[0]).toMatchObject({ closeSource: "last_tick", confirmation: null });
    const f = new FinnhubClient("fk", fakeFetch({ finnhub: fh, candle: { status: 403, body: { error: "x" } } }));
    const c = await f.candle("AAPL", 0, 1);
    expect(c.ok).toBe(false);
    expect(c.status).toBe(403);
  });

  it("半日市（2026-11-27 13:00:00 ET 最后成交）：core.classifyLastTrade 只认 16:00:00 整 → 当前不记当日收盘，只用 pc（已报 I2/A2 作为已知缺口）", () => {
    const t = Math.floor(Date.UTC(2026, 10, 27, 18, 0, 0) / 1000); // 13:00 ET = 18:00Z
    const now = "2026-11-28T10:00:00.000Z";
    const out = classify(mk(now, { c: 300, pc: 299, t }), now, { c: 300, pc: 299, t });
    expect(refClose(out).find((c) => c.closeSource === "last_tick")).toBeUndefined();
    expect(refClose(out)[0]).toMatchObject({ closeUsd: "299", closeSource: "official" });
  });
});

describe("单位变化回放样本（T-05 数据侧）", () => {
  it("REPLAY 样本：before 为构造值、after 为真实观测；三源乘数一致；before/after 不同即 UNIT_CHANGED 的输入", () => {
    const s = JSON.parse(readFileSync(join(__dirname, "fixtures", "replay", "xstocks_unit_change_AAPLx.json"), "utf8")) as { constructed: boolean; mode: string; before: { onchainMultiplier: string; okxRatio: string }; after: { onchainMultiplier: string; okxRatio: string; xstocksApiMultiplier: number; onchainMultiplierRaw: string } };
    expect(s.mode).toBe("REPLAY");
    expect(s.constructed).toBe(true);
    expect(multiplierToDecimal(BigInt(s.after.onchainMultiplierRaw))).toBe(s.after.onchainMultiplier);
    expect(multiplierMatchesRatio(s.after.onchainMultiplier, s.after.okxRatio)).toBe(true);
    expect(Math.abs(Number(s.after.onchainMultiplier) - s.after.xstocksApiMultiplier) < 1e-12).toBe(true);
    expect(s.before.onchainMultiplier).not.toBe(s.after.onchainMultiplier);
    expect(multiplierMatchesRatio(s.before.onchainMultiplier, s.after.okxRatio)).toBe(false);
  });
});

describe("registry v1.1.0", () => {
  it("版本升级、股票条目带 executionSides，哈希与 v1.0.0 不同；v1.0.0 文件不变", () => {
    const v1 = loadRegistry({ REGISTRY_MODE: "file", REGISTRY_FILE: join(__dirname, "..", "config", "registry.xlayer.json"), EXECUTION_CHAIN_ID: 196 });
    expect(v1.version).toBe("xlayer-registry/1.0.0");
    expect(registry.version).toBe("xlayer-registry/1.1.0");
    const aapl = registry.entries.find((e) => e.assetKey === AAPLX) as unknown as { executionSides?: string[] };
    expect(aapl.executionSides).toEqual(["buy", "sell"]);
    const spy = registry.entries.find((e) => e.displaySymbol === "SPYx") as unknown as { executionSides?: string[]; executionAllowed: boolean };
    expect(spy.executionAllowed).toBe(false);
    expect(spy.executionSides).toEqual([]);
  });
});
