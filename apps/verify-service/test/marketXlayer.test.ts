/**
 * 公开行情 GET /pub/market/xlayer（契约 interfaces §10.16）：
 * 假 fetch 按 amount / toTokenAddress 造 OKX quote 响应；时钟可拨；sleep 注入为空。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OkxClient } from "../src/adapters/okx/client";
import { loadRegistry } from "../src/registry";
import { MARKET_XLAYER_SCHEMA, XLayerMarket, type MarketSnapshot } from "../src/market/xlayer";
import { createTestEnv } from "./helpers";

const REG = join(__dirname, "..", "config", "registry.xlayer.v1.1.json");
const registry = loadRegistry({ REGISTRY_MODE: "file", REGISTRY_FILE: REG, EXECUTION_CHAIN_ID: 196 });
const USDG = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const NVDAX = "0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const T0 = Date.parse("2026-09-21T10:00:00.000Z");

/** 每档执行价（USD / 代币）；toTokenAmount = size × 1e18 / price */
const PRICES: Record<string, Record<number, number>> = {
  [AAPLX]: { 100: 250, 1000: 250.5, 10000: 255 },
  [NVDAX]: { 100: 180, 1000: 180.36, 10000: 183.6 },
};
const IMPACT_PCT: Record<number, string> = { 100: "0", 1000: "-0.2", 10000: "-2" };

type Mode = "ok" | "no_impact" | "no_route_10k" | "rate_limited" | "throw" | "http500";
interface Scenario {
  mode: Mode;
  calls: number;
}

function fakeFetch(s: Scenario): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const u = new URL(String(input));
    s.calls += 1;
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (s.mode === "throw") throw new Error("ECONNRESET");
    if (s.mode === "http500") return new Response("bad gateway", { status: 502 });
    if (s.mode === "rate_limited") return json({ code: "50011", msg: "Too Many Requests", data: null });
    expect(u.pathname).toBe("/api/v6/dex/aggregator/quote");
    expect(u.searchParams.get("fromTokenAddress")).toBe(USDG);
    const size = Number(u.searchParams.get("amount")) / 1e6;
    const to = (u.searchParams.get("toTokenAddress") ?? "").toLowerCase();
    if (s.mode === "no_route_10k" && size === 10_000) return json({ code: "82000", msg: "Insufficient liquidity", data: null });
    const price = PRICES[to]?.[size];
    if (!price) return json({ code: "82000", msg: "no route", data: null });
    const out = (BigInt(Math.round(size * 1e6)) * 10n ** 18n) / BigInt(Math.round(price * 1e6));
    return json({
      code: "0",
      msg: "",
      data: [
        {
          chainIndex: "196",
          fromTokenAmount: String(size * 1e6),
          toTokenAmount: out.toString(),
          priceImpactPercent: s.mode === "no_impact" ? null : IMPACT_PCT[size],
          dexRouterList: [{ dexProtocol: { dexName: "Uniswap V3", percent: "100" } }, { dexProtocol: { dexName: "xStocks wrap V2", percent: "100" } }],
        },
      ],
    });
  }) as typeof fetch;
}

function make(mode: Mode = "ok") {
  const s: Scenario = { mode, calls: 0 };
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const okx = new OkxClient({ apiKey: "k", secretKey: "s", passphrase: "p" }, fakeFetch(s), now);
  const market = new XLayerMarket({ okx, registry, now, backoffMs: 0, spacingMs: 0, sleep: async () => {} });
  return { s, clock, market };
}

const SNAPSHOT_KEYS = ["asOf", "chain", "chainIndex", "errors", "input", "schema", "source", "stale", "tokens", "ttlSec"];
const TOKEN_KEYS = ["address", "decimals", "execPrice10k", "execPrice1k", "impact10kBps", "impact1kBps", "priceUsd", "receivedAt", "route", "symbol", "underlying", "verifyUrl"];

describe("公开行情 /pub/market/xlayer（契约 §10.16）", () => {
  it("三档正常：两只允许执行的代币按登记表顺序（SPYx 不在列），字段齐全，冲击优先取 OKX priceImpactPercent", async () => {
    const { s, market } = make();
    const snap = (await market.snapshot())!;
    expect(snap).not.toBeNull();
    expect(Object.keys(snap).sort()).toEqual(SNAPSHOT_KEYS);
    expect(snap).toMatchObject({ schema: MARKET_XLAYER_SCHEMA, chain: "xlayer", chainIndex: "196", source: "okx_dex_quote", ttlSec: 30, stale: false, errors: [] });
    expect(snap.asOf).toBe("2026-09-21T10:00:00.000Z");
    expect(snap.input).toEqual({ symbol: "USDG", address: USDG, decimals: 6 });
    expect(snap.tokens.map((t) => t.symbol)).toEqual(["AAPLx", "NVDAx"]);
    expect(s.calls).toBe(6);
    const a = snap.tokens[0]!;
    expect(Object.keys(a).sort()).toEqual(TOKEN_KEYS);
    expect(a).toMatchObject({ underlying: "AAPL", address: AAPLX, decimals: 18, impact1kBps: 20, impact10kBps: 200, receivedAt: "2026-09-21T10:00:00.000Z", route: ["Uniswap V3", "xStocks wrap V2"], verifyUrl: "https://verify.chaconne.xyz/new?stock=AAPLx&from=main" });
    expect(a.priceUsd).toBeCloseTo(250, 4);
    expect(a.execPrice1k).toBeCloseTo(250.5, 4);
    expect(a.execPrice10k).toBeCloseTo(255, 4);
    const n = snap.tokens[1]!;
    expect(n).toMatchObject({ underlying: "NVDA", address: NVDAX, impact1kBps: 20, impact10kBps: 200, verifyUrl: "https://verify.chaconne.xyz/new?stock=NVDAx&from=main" });
    expect(n.priceUsd).toBeCloseTo(180, 4);
  });

  it("OKX 不给 priceImpactPercent → 按执行价相对 100 档中间价计算（取非负）", async () => {
    const { market } = make("no_impact");
    const snap = (await market.snapshot())!;
    expect(snap.tokens.map((t) => [t.impact1kBps, t.impact10kBps])).toEqual([
      [20, 200],
      [20, 200],
    ]);
  });

  it("某档无路由（82000）→ 该档 null + errors{no_route,size}，其它档照报，不算失败", async () => {
    const { s, market } = make("no_route_10k");
    const snap = (await market.snapshot())!;
    expect(snap.stale).toBe(false);
    expect(s.calls).toBe(6);
    for (const t of snap.tokens) {
      expect(t.priceUsd).not.toBeNull();
      expect(t.execPrice1k).not.toBeNull();
      expect(t.execPrice10k).toBeNull();
      expect(t.impact10kBps).toBeNull();
    }
    expect(snap.errors).toEqual([
      { symbol: "AAPLx", code: "no_route", size: 10_000 },
      { symbol: "NVDAx", code: "no_route", size: 10_000 },
    ]);
  });

  it("缓存：TTL 内命中不打上游；过期后并发请求 single-flight 只刷新一次", async () => {
    const { s, clock, market } = make();
    const a = await market.snapshot();
    const b = await market.snapshot();
    expect(b).toBe(a);
    expect(s.calls).toBe(6);
    clock.ms = T0 + 29_000;
    expect(await market.snapshot()).toBe(a);
    expect(s.calls).toBe(6);
    clock.ms = T0 + 31_000;
    const [c, d] = await Promise.all([market.snapshot(), market.snapshot()]);
    expect(s.calls).toBe(12);
    expect(c).toBe(d);
    expect(c!.asOf).toBe("2026-09-21T10:00:31.000Z");
    expect(c!.stale).toBe(false);
  });

  it("限流：至多退避重试一次即中止本轮（不重试风暴），返回上一份 stale:true；TTL 内冷却不再打上游；恢复后重新新鲜", async () => {
    const { s, clock, market } = make();
    const good = (await market.snapshot())!;
    clock.ms = T0 + 31_000;
    s.mode = "rate_limited";
    const st = (await market.snapshot())!;
    expect(s.calls).toBe(8); // 6 + 1 + 重试 1
    expect(st.stale).toBe(true);
    expect(st.asOf).toBe(good.asOf);
    expect(st.tokens).toEqual(good.tokens);
    expect(st.errors).toEqual(good.errors);
    clock.ms = T0 + 40_000;
    expect((await market.snapshot())!.stale).toBe(true);
    expect(s.calls).toBe(8); // 冷却中
    clock.ms = T0 + 62_000;
    s.mode = "ok";
    const fresh = (await market.snapshot())!;
    expect(fresh.stale).toBe(false);
    expect(fresh.asOf).toBe("2026-09-21T10:01:02.000Z");
    expect(s.calls).toBe(14);
  });

  it("上游 5xx / 网络异常 → 中止本轮，返回上一份 stale:true", async () => {
    const { s, clock, market } = make();
    await market.snapshot();
    clock.ms = T0 + 31_000;
    s.mode = "http500";
    expect((await market.snapshot())!.stale).toBe(true);
    expect(s.calls).toBe(7);
    clock.ms = T0 + 62_000;
    s.mode = "throw";
    expect((await market.snapshot())!.stale).toBe(true);
    expect(s.calls).toBe(8);
  });

  it("从未成功 → null（HTTP 503 unavailable, no-store）；未接行情的服务同样 503", async () => {
    const { s, market } = make("throw");
    expect(await market.snapshot()).toBeNull();
    expect(s.calls).toBe(1);
    const env = await createTestEnv({ market });
    try {
      const r = await fetch(`${env.url}/pub/market/xlayer`);
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({ error: "unavailable" });
    } finally {
      await env.close();
    }
    const bare = await createTestEnv();
    try {
      const r = await fetch(`${bare.url}/pub/market/xlayer`);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "unavailable" });
    } finally {
      await bare.close();
    }
  });

  it("HTTP 200：契约 Cache-Control 与正文；无鉴权", async () => {
    const { market } = make();
    const env = await createTestEnv({ market });
    try {
      const r = await fetch(`${env.url}/pub/market/xlayer`);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("public, max-age=15, s-maxage=30");
      const body = (await r.json()) as MarketSnapshot;
      expect(body.schema).toBe(MARKET_XLAYER_SCHEMA);
      expect(body.tokens.map((t) => t.symbol)).toEqual(["AAPLx", "NVDAx"]);
      expect(body.tokens[1]!.priceUsd).toBeCloseTo(180, 4);
      expect(JSON.stringify(body)).not.toMatch(/OK-ACCESS|secret|passphrase/i);
    } finally {
      await env.close();
    }
  });
});
