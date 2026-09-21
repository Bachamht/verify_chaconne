/**
 * LiveEvidenceProvider · REPLAY（录制于 2026-09-20 的真实 OKX 响应 + 构造的 Finnhub/RPC 应答）。
 * 证明：字段映射、时间语义、路由校验、Finnhub 分类、与规则引擎串起来的结论。不证明当前行情。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { buildReport, validateCreateJob, type EvidenceRecord } from "@chaconne/core/verify";
import { FinnhubClient } from "../src/adapters/finnhub";
import { OkxClient } from "../src/adapters/okx/client";
import { checkRouteAgainstIntent, decodeRouterCalldata } from "../src/adapters/okx/calldata";
import { LiveEvidenceProvider } from "../src/evidence/live";
import { loadRegistry } from "../src/registry";

const FIX = join(__dirname, "fixtures", "okx");
const load = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), "utf8")) as { data: unknown };
const REG = join(__dirname, "..", "config", "registry.xlayer.json");
const registry = loadRegistry({ REGISTRY_MODE: "file", REGISTRY_FILE: REG, EXECUTION_CHAIN_ID: 196 });

const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const GUARD = "0x4444444444444444444444444444444444444444" as const;
const ROUTER = "0x7c5bee2a8091c3ef39072f64f18fac913060aeaf" as const;
const SPENDER = "0x8b773d83bc66be128c60e07e17c8901f7a64f000" as const;

/** 假 fetch：按 URL 路径返回录制响应；Finnhub 按 quote 参数返回 */
function fakeFetch(finnhub: { c: number; pc: number; t: number }): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const body = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/dex/aggregator/quote")) return body({ code: "0", msg: "", data: load("P2_quote_USDG").data });
    if (url.includes("/dex/aggregator/swap")) return body({ code: "0", msg: "", data: load("P3_swap_USDG").data });
    if (url.includes("/dex/market/rwa/tokens")) return body({ code: "0", msg: "", data: load("P1_rwa_tokens").data });
    if (url.includes("finnhub.io")) return body({ c: finnhub.c, pc: finnhub.pc, t: finnhub.t, h: 0, l: 0, o: 0 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function fakeRpc(nowSec: number): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "decimals" ? 18 : "AAPLx"),
    getBlock: async () => ({ number: 71134841n, hash: `0x${"ab".repeat(32)}`, timestamp: BigInt(nowSec) }),
  } as unknown as PublicClient;
}

function provider(finnhub: { c: number; pc: number; t: number }, nowSec: number) {
  const f = fakeFetch(finnhub);
  const clock = () => new Date(nowSec * 1000);
  return new LiveEvidenceProvider({
    okx: new OkxClient({ apiKey: "k", secretKey: "s", passphrase: "p" }, f, clock),
    finnhub: new FinnhubClient("fk", f, undefined, clock),
    rpc: fakeRpc(nowSec),
    now: clock,
    guardAddress: GUARD,
    approvedRouter: ROUTER,
    approvedSpender: SPENDER,
  });
}

function job(policyId: "STRICT_LIVE" | "REFERENCE_CONTEXT" | "QUOTE_ONLY", policyVersion = "1.0.0") {
  const v = validateCreateJob({
    clientRequestId: "replay",
    ownerAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381",
    recipientAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381",
    executionChainId: 196,
    inputAssetKey: USDG,
    outputAssetKey: AAPLX,
    amountInRaw: "5000000",
    mode: "exactIn",
    policyId,
    policyVersion,
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: policyId === "QUOTE_ONLY" ? null : 300,
  });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v;
}

const kinds = (ev: EvidenceRecord[]) => ev.map((e) => e.payload.kind).sort();

describe("REPLAY：2026-09-20 周六（休市）录制的 OKX 响应 + Finnhub 周五收盘", () => {
  // 探针时刻 11:31Z 周六；Finnhub c=336.13 t=2026-09-18T20:00:00Z（16:00 ET 收盘），pc=337
  const NOW = "2026-09-20T11:31:36.000Z";
  const nowSec = Math.floor(Date.parse(NOW) / 1000);
  const fh = { c: 336.13, pc: 337, t: 1789761600 };

  it("产出 swap/quote 两条 okx_quote、稳定币美元证据、代币元数据、RWA 条目、Finnhub 实时 tick 与 16:00 最后成交收盘（CV-D06 → last_tick）", async () => {
    const { job: j } = job("REFERENCE_CONTEXT");
    const r = await provider(fh, nowSec).collect(j, registry, NOW);
    expect(kinds(r.evidence)).toEqual(["okx_quote", "okx_quote", "okx_rwa_token", "pyth_reference", "ref_close", "stablecoin_usd", "token_meta"]);
    expect(r.evidence.every((e) => e.mode === "LIVE")).toBe(true);
    const q = r.evidence.find((e) => e.endpoint === "aggregator/quote")!.payload;
    if (q.kind !== "okx_quote") throw new Error();
    expect(q.expectedOutRaw).toBe("14991718755727414");
    expect(q.adverseImpactBps).toBe(0); // "0" → 0 不利
    const usd = r.evidence.find((e) => e.payload.kind === "stablecoin_usd")!.payload;
    if (usd.kind !== "stablecoin_usd") throw new Error();
    expect(usd.usdPerToken).not.toBeNull();
    const close = r.evidence.find((e) => e.payload.kind === "ref_close")!.payload;
    if (close.kind !== "ref_close") throw new Error();
    // CV-D06：t = 2026-09-18T20:00:00Z（16:00:00 ET 整）= 最后一笔成交，不再推断为正式收盘
    expect(close).toMatchObject({ closeUsd: "336.13", tradingDate: "2026-09-18", closeSource: "last_tick", confirmation: null });
    const rwa = r.evidence.find((e) => e.payload.kind === "okx_rwa_token")!.payload;
    if (rwa.kind !== "okx_rwa_token") throw new Error();
    expect(rwa.stockPriceUsd).toBeNull(); // X Layer 列表 stockPrice 为空
    // 路由：swap calldata 解析通过 → route 可用，且 spender 为批准值
    expect(r.route).toEqual({ router: ROUTER, spender: SPENDER, calldata: expect.stringMatching(/^0xf2c42696/) });
  });

  it("REFERENCE_CONTEXT v1.0.0：last_tick 当作 last_regular_observation → limited；v1.1.0：close_last_tick → eligible + CLOSE_UNCONFIRMED(info)，偏差 -78bps", async () => {
    const old = job("REFERENCE_CONTEXT", "1.0.0");
    const r = await provider(fh, nowSec).collect(old.job, registry, NOW);
    const r1 = buildReport({ jobId: "job_replay", reportVersion: 1, job: old.job, policy: old.policy, registry, evidence: r.evidence, evaluatedAt: NOW });
    expect(r1.marketSession).toBe("CLOSED");
    // v1.0.0 无 acceptedCloseKinds：引擎仍标 kind=close_last_tick 但不合格（limited）
    expect(r1.verdict).toBe("limited");
    expect(r1.reference?.kind).toBe("close_last_tick");
    const cur = job("REFERENCE_CONTEXT", "1.1.0");
    const r2 = buildReport({ jobId: "job_replay", reportVersion: 1, job: cur.job, policy: cur.policy, registry, evidence: r.evidence, evaluatedAt: NOW });
    expect(r2.verdict).toBe("eligible");
    expect(r2.reference?.kind).toBe("close_last_tick");
    expect(r2.reasons.map((x) => x.code)).toContain("CLOSE_UNCONFIRMED");
    expect(r2.normalizedQuote?.executableUsdPerShare?.startsWith("333.5")).toBe(true);
    expect(r2.reference?.deviationBps).toBe(-78);
  });

  it("closeClassification=v1（回归对照）：旧规则仍记 official → eligible(official_close)", async () => {
    const { job: j, policy } = job("REFERENCE_CONTEXT");
    const f = fakeFetch(fh);
    const clock = () => new Date(nowSec * 1000);
    const p = new LiveEvidenceProvider({ okx: new OkxClient({ apiKey: "k", secretKey: "s", passphrase: "p" }, f, clock), finnhub: new FinnhubClient("fk", f, undefined, clock), rpc: fakeRpc(nowSec), now: clock, guardAddress: GUARD, approvedRouter: ROUTER, approvedSpender: SPENDER, closeClassification: "v1" });
    const r = await p.collect(j, registry, NOW);
    const close = r.evidence.find((e) => e.payload.kind === "ref_close")!.payload;
    if (close.kind !== "ref_close") throw new Error();
    expect(close).toMatchObject({ closeUsd: "336.13", tradingDate: "2026-09-18", closeSource: "official" });
    const report = buildReport({ jobId: "job_replay", reportVersion: 1, job: j, policy, registry, evidence: r.evidence, evaluatedAt: NOW });
    expect(report.verdict).toBe("eligible");
    expect(report.reference?.kind).toBe("official_close");
  });

  it("STRICT_LIVE 休市 → rejected(MARKET_OUTSIDE_REGULAR)，参考 tick 陈旧", async () => {
    const { job: j, policy } = job("STRICT_LIVE");
    const r = await provider(fh, nowSec).collect(j, registry, NOW);
    const report = buildReport({ jobId: "job_replay", reportVersion: 1, job: j, policy, registry, evidence: r.evidence, evaluatedAt: NOW });
    expect(report.verdict).toBe("rejected");
    expect(report.reasons.map((x) => x.code)).toContain("MARKET_OUTSIDE_REGULAR");
  });

  it("QUOTE_ONLY 休市 → eligible(not_requested)", async () => {
    const { job: j, policy } = job("QUOTE_ONLY");
    const r = await provider(fh, nowSec).collect(j, registry, NOW);
    const report = buildReport({ jobId: "job_replay", reportVersion: 1, job: j, policy, registry, evidence: r.evidence, evaluatedAt: NOW });
    expect(report.verdict).toBe("eligible");
    expect(report.comparisonStatus).toBe("not_requested");
  });
});

describe("Finnhub 分类（CV-D02）", () => {
  it("常规时段：tick 为实时，收盘用 previousClose 记上一交易日", async () => {
    const NOW = "2026-09-18T15:00:00.000Z"; // 周五 11:00 ET
    const nowSec = Math.floor(Date.parse(NOW) / 1000);
    const { job: j, policy } = job("STRICT_LIVE");
    const r = await provider({ c: 335.9, pc: 337, t: nowSec - 5 }, nowSec).collect(j, registry, NOW);
    const tick = r.evidence.find((e) => e.payload.kind === "pyth_reference")!;
    if (tick.payload.kind !== "pyth_reference") throw new Error();
    expect(tick.payload.sessionAtPublish).toBe("REGULAR");
    expect(tick.time.sourcePublishedAt).toBe(new Date((nowSec - 5) * 1000).toISOString());
    const close = r.evidence.find((e) => e.payload.kind === "ref_close")!.payload;
    if (close.kind !== "ref_close") throw new Error();
    expect(close).toMatchObject({ closeUsd: "337", tradingDate: "2026-09-17" });
    const report = buildReport({ jobId: "job_replay", reportVersion: 1, job: j, policy, registry, evidence: r.evidence, evaluatedAt: NOW });
    // 常规时段 + 5 秒新的 tick + 可执行单价 333.5 vs 335.9（-71bps ≤ 300）→ STRICT_LIVE 合格
    expect(report.verdict).toBe("eligible");
    expect(report.comparisonStatus).toBe("live");
    expect(report.reference?.deviationBps).toBe(-71);
  });

  it("路由 spender/router 与批准值不符 → routeSupported=false，route=null", async () => {
    const NOW = "2026-09-20T11:31:36.000Z";
    const f = fakeFetch({ c: 336.13, pc: 337, t: 1789761600 });
    const clock = () => new Date(NOW);
    const p = new LiveEvidenceProvider({
      okx: new OkxClient({ apiKey: "k", secretKey: "s", passphrase: "p" }, f, clock),
      finnhub: null,
      rpc: fakeRpc(Math.floor(Date.parse(NOW) / 1000)),
      now: clock,
      guardAddress: GUARD,
      approvedRouter: "0x1234567890123456789012345678901234567890",
      approvedSpender: SPENDER,
    });
    const { job: j } = job("QUOTE_ONLY");
    const r = await p.collect(j, registry, NOW);
    expect(r.route).toBeNull();
    const swapEv = r.evidence.find((e) => e.endpoint === "aggregator/swap")!.payload;
    if (swapEv.kind !== "okx_quote") throw new Error();
    expect(swapEv.routeSupported).toBe(false);
  });
});

describe("calldata 解码", () => {
  it("dagSwapByOrderId：from/to/amount/minReturn/deadline", () => {
    const tx = (load("P3_swap_USDG").data as Array<{ tx: { data: `0x${string}`; minReceiveAmount: string } }>)[0]!.tx;
    const d = decodeRouterCalldata(tx.data)!;
    expect(d).toMatchObject({ functionName: "dagSwapByOrderId", fromToken: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", toToken: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", fromTokenAmount: "5000000" });
    expect(d.minReturnAmount).toBe(tx.minReceiveAmount);
    expect(decodeRouterCalldata("0xdeadbeef00")).toBeNull();
  });
});

describe("calldata 解码：dagSwapTo（显式收款人）", () => {
  it("receiver 解析并校验必须等于 Guard；换个 Guard 地址 → receiver_not_guard", () => {
    const tx = (load("P3_swapTo_USDG").data as Array<{ tx: { data: `0x${string}`; minReceiveAmount: string } }>)[0]!.tx;
    const d = decodeRouterCalldata(tx.data)!;
    expect(d.functionName).toBe("dagSwapTo");
    expect(d.receiver).toBe("0x4444444444444444444444444444444444444444");
    expect(d.fromTokenAmount).toBe("5000000");
    const base = { inputToken: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", outputToken: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", amountInRaw: "5000000", deadlineUnix: 0 };
    expect(checkRouteAgainstIntent(tx.data, { ...base, expectedReceiver: "0x4444444444444444444444444444444444444444" }).ok).toBe(true);
    expect(checkRouteAgainstIntent(tx.data, { ...base, expectedReceiver: "0x5555555555555555555555555555555555555555" }).reasons).toContain("receiver_not_guard");
  });
});
