/**
 * Lane B 首日探针 P1–P4（v3 执行计划 §9）。只读，不动资金。
 * 用法：pnpm --filter @chaconne/verify-service probe   （读 apps/verify-service/.env；Finnhub/Pyth key 可选自根 .env）
 * 原始响应存到 PROBE_OUT_DIR（默认 ../../.probes/，gitignore），摘要打印到 stdout。
 * ⚠ 本脚本输出的任何地址都只是候选；进入 registry/Guard 白名单前须双源核验 + 运营者批准。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, erc20Abi, getAddress } from "viem";
import { OkxClient, approveTransaction, quote, rwaTokens, swap } from "../src/adapters/okx/client";

const OUT = process.env["PROBE_OUT_DIR"] ?? join(process.cwd(), "..", "..", "OKX dev day", "probes");
mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const save = (name: string, obj: unknown) => writeFileSync(join(OUT, `${stamp}_${name}.json`), JSON.stringify(obj, null, 2));

const chainIndex = process.env["EXECUTION_CHAIN_ID"] ?? "196";
const creds = { apiKey: process.env["OKX_API_KEY"] ?? "", secretKey: process.env["OKX_SECRET_KEY"] ?? "", passphrase: process.env["OKX_PASSPHRASE"] ?? "" };
if (!creds.apiKey) throw new Error("缺 OKX_API_KEY");
const okx = new OkxClient(creds);
const rpc = createPublicClient({ transport: http(process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech") });

// 候选稳定币（来源：OKX 支付网络文档 + x402-evm SDK 内置；仍需链上核验 symbol/decimals）
const STABLE_CANDIDATES: Record<string, string> = {
  USDG: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8",
  USDC: "0xb6ceceab302e2e4948951ee7843fc24e92933061",
  USDT0: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
};

async function tokenMeta(addr: string) {
  const a = getAddress(addr);
  const [symbol, decimals, name] = await Promise.all([
    rpc.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }).catch(() => null),
    rpc.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }).catch(() => null),
    rpc.readContract({ address: a, abi: erc20Abi, functionName: "name" }).catch(() => null),
  ]);
  const code = await rpc.getCode({ address: a }).catch(() => undefined);
  return { address: a.toLowerCase(), symbol, decimals, name, hasCode: !!code && code !== "0x", codeSize: code ? (code.length - 2) / 2 : 0 };
}

async function main() {
  const summary: Record<string, unknown> = { chainIndex, at: new Date().toISOString() };
  const block = await rpc.getBlock();
  summary["rpc"] = { chainId: await rpc.getChainId(), block: Number(block.number), blockTs: new Date(Number(block.timestamp) * 1000).toISOString() };

  /* P1 RWA 列表（xstocks=36） */
  const p1 = await rwaTokens(okx, { chainIndex, issuer: "36" });
  save("P1_rwa_tokens", { call: { status: p1.status, code: p1.code, msg: p1.msg, endpoint: p1.endpoint, time: p1.time, rawHash: p1.rawHash }, data: p1.data });
  const list = p1.data?.list ?? [];
  summary["P1"] = { ok: p1.ok, count: list.length, code: p1.code, msg: p1.msg, tokens: list.slice(0, 30).map((t) => ({ sym: t.tokenSymbol, stock: t.stockCode, addr: t.tokenContractAddress, price: t.price, stockPrice: t.stockPrice, ratio: t.tokenToAssetRatio, vol24h: t.volume24h })) };
  const aapl = list.find((t) => t.stockCode === "AAPL" || t.tokenSymbol === "AAPLx");
  const candidates = [aapl, ...list.filter((t) => t !== aapl).slice(0, 2)].filter(Boolean) as typeof list;

  /* 稳定币链上元数据 */
  const stables: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(STABLE_CANDIDATES)) stables[k] = await tokenMeta(v);
  summary["stables"] = stables;

  /* 目标股票代币链上元数据 */
  const stockMeta: Record<string, unknown> = {};
  for (const t of candidates) stockMeta[t.tokenSymbol] = await tokenMeta(t.tokenContractAddress);
  summary["stockMeta"] = stockMeta;

  /* P2 报价：每个候选稳定币 × AAPLx，$5 */
  const p2: Record<string, unknown> = {};
  if (aapl) {
    for (const [k, v] of Object.entries(STABLE_CANDIDATES)) {
      const dec = (stables[k] as { decimals: number | null }).decimals ?? 6;
      const amount = (5n * 10n ** BigInt(dec)).toString();
      const q = await quote(okx, { chainIndex, fromTokenAddress: v, toTokenAddress: aapl.tokenContractAddress, amount });
      save(`P2_quote_${k}`, { call: { status: q.status, code: q.code, msg: q.msg, endpoint: q.endpoint, time: q.time, rawHash: q.rawHash }, data: q.data });
      const d = q.data?.[0];
      p2[k] = { ok: q.ok, code: q.code, msg: q.msg, toTokenAmount: d?.toTokenAmount, priceImpactPercent: d?.priceImpactPercent, routers: d?.dexRouterList?.map((r) => ({ router: r.router, pct: r.routerPercent, dex: r.subRouterList?.flatMap((s) => s.dexProtocol?.map((p) => `${p.dexName}:${p.percent}`) ?? []) })), toDecimal: d?.toToken?.decimal, fromDecimal: d?.fromToken?.decimal, toUnitPrice: d?.toToken?.tokenUnitPrice };
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  summary["P2"] = p2;

  /* P3 swap（以 Guard 占位地址作为 userWalletAddress，只取 tx.to / spender，不广播） */
  const p3: Record<string, unknown> = {};
  if (aapl) {
    const guardPlaceholder = process.env["GUARD_ADDRESS"] || "0x4444444444444444444444444444444444444444";
    for (const [k, v] of Object.entries(STABLE_CANDIDATES)) {
      const dec = (stables[k] as { decimals: number | null }).decimals ?? 6;
      const amount = (5n * 10n ** BigInt(dec)).toString();
      const s = await swap(okx, { chainIndex, fromTokenAddress: v, toTokenAddress: aapl.tokenContractAddress, amount, slippagePercent: "0.5", userWalletAddress: guardPlaceholder });
      save(`P3_swap_${k}`, { call: { status: s.status, code: s.code, msg: s.msg, endpoint: s.endpoint, time: s.time, rawHash: s.rawHash }, data: s.data });
      const d = s.data?.[0];
      p3[k] = { ok: s.ok, code: s.code, msg: s.msg, txTo: d?.tx?.to, selector: d?.tx?.data?.slice(0, 10), value: d?.tx?.value, minReceive: d?.tx?.minReceiveAmount, gas: d?.tx?.gas, dataLen: d?.tx?.data ? (d.tx.data.length - 2) / 2 : 0 };
      await new Promise((r) => setTimeout(r, 400));
    }
    const ap = await approveTransaction(okx, { chainIndex, tokenContractAddress: STABLE_CANDIDATES["USDG"]!, approveAmount: "1000000" });
    save("P3_approve", { call: { status: ap.status, code: ap.code, msg: ap.msg, endpoint: ap.endpoint }, data: ap.data });
    p3["approveSpender"] = { ok: ap.ok, code: ap.code, msg: ap.msg, dexContractAddress: ap.data?.[0]?.dexContractAddress };
  }
  summary["P3"] = p3;

  /* P4 参考价来源：Pyth Hermes（公开元数据 + 价格是否需要授权）与 Finnhub */
  const p4: Record<string, unknown> = {};
  const hermes = process.env["PYTH_HERMES_URL"] ?? "https://hermes.pyth.network";
  const feeds = (await (await fetch(`${hermes}/v2/price_feeds?asset_type=equity&query=AAPL`)).json()) as Array<{ id: string; attributes: Record<string, string>; market_hours?: unknown }>;
  const aaplFeed = feeds.find((f) => f.attributes["symbol"] === "Equity.US.AAPL/USD");
  p4["hermesFeed"] = aaplFeed ? { id: aaplFeed.id, symbol: aaplFeed.attributes["symbol"], market_hours: aaplFeed.market_hours } : null;
  if (aaplFeed) {
    for (const [label, headers] of [["public", {}], ["with_key", process.env["PYTH_API_KEY"] ? { Authorization: `Bearer ${process.env["PYTH_API_KEY"]}` } : null]] as Array<[string, Record<string, string> | null]>) {
      if (!headers) continue;
      const r = await fetch(`${hermes}/v2/updates/price/latest?ids[]=${aaplFeed.id}&parsed=true`, { headers });
      const text = await r.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
      const pp = (parsed as { parsed?: Array<{ price?: { price: string; expo: number; publish_time: number } }> } | null)?.parsed?.[0]?.price;
      p4[`hermesPrice_${label}`] = { status: r.status, price: pp ? Number(pp.price) * 10 ** pp.expo : null, publish_time: pp?.publish_time ?? null, publishIso: pp ? new Date(pp.publish_time * 1000).toISOString() : null, bodyHead: text.slice(0, 120) };
    }
  }
  if (process.env["FINNHUB_API_KEY"]) {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${process.env["FINNHUB_API_KEY"]}`);
    const j = (await r.json()) as { c?: number; t?: number; pc?: number };
    p4["finnhub"] = { status: r.status, current: j.c, previousClose: j.pc, t: j.t, tIso: j.t ? new Date(j.t * 1000).toISOString() : null };
  }
  summary["P4"] = p4;

  save("SUMMARY", summary);
  console.info(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
