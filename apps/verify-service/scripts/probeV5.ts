/**
 * v5 Lane B2 探针（只读，不动资金）：阶梯 quote、卖出 quote/swap、RWA ratio、Finnhub candle 免费档、链上乘数函数候选。
 * 用法：pnpm --filter @chaconne/verify-service probe:v5  → 原文存 PROBE_OUT_DIR（默认 ../../.probes，gitignore）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OkxClient, quote, rwaTokens, swap } from "../src/adapters/okx/client";
import { checkRouteAgainstIntent, decodeRouterCalldata } from "../src/adapters/okx/calldata";

const OUT = process.env["PROBE_OUT_DIR"] ?? join(process.cwd(), "..", "..", "OKX dev day", "probes");
mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const save = (name: string, obj: unknown) => writeFileSync(join(OUT, `${stamp}_${name}.json`), JSON.stringify(obj, null, 2));
const chainIndex = "196";
const okx = new OkxClient({ apiKey: process.env["OKX_API_KEY"] ?? "", secretKey: process.env["OKX_SECRET_KEY"] ?? "", passphrase: process.env["OKX_PASSPHRASE"] ?? "" });
const USDG = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const GUARD = process.env["GUARD_ADDRESS"] ?? "0x02834e26bbd851eedb888bafba666bc0af72770c";
const FINN = process.env["FINNHUB_API_KEY"] ?? "";
const strip = <T extends { rawText: string }>(c: T) => ({ ...c, rawText: undefined });

async function main() {
  const summary: Record<string, unknown> = { at: new Date().toISOString() };
  /* V1 阶梯 quote：5 档 */
  const ladder = ["5000000", "3750000", "2500000", "1250000", "500000"];
  const lq = await Promise.all(ladder.map((amount) => quote(okx, { chainIndex, fromTokenAddress: USDG, toTokenAddress: AAPLX, amount })));
  save("V1_ladder_quotes", lq.map(strip));
  summary["V1_ladder"] = lq.map((c, i) => ({ amount: ladder[i], ok: c.ok, code: c.code, out: c.data?.[0]?.toTokenAmount, impact: c.data?.[0]?.priceImpactPercent, ms: Date.parse(c.time.receivedAt) - Date.parse(c.time.requestedAt) }));
  /* V2 卖出 quote + swap（AAPLx → USDG，0.005 AAPLx） */
  const sellAmt = "5000000000000000";
  const sq = await quote(okx, { chainIndex, fromTokenAddress: AAPLX, toTokenAddress: USDG, amount: sellAmt });
  save("V2_sell_quote", strip(sq));
  summary["V2_sell_quote"] = { ok: sq.ok, code: sq.code, msg: sq.msg, out: sq.data?.[0]?.toTokenAmount, impact: sq.data?.[0]?.priceImpactPercent, fromUnit: sq.data?.[0]?.fromToken?.tokenUnitPrice, toUnit: sq.data?.[0]?.toToken?.tokenUnitPrice, fromDecimal: sq.data?.[0]?.fromToken?.decimal };
  const ss = await swap(okx, { chainIndex, fromTokenAddress: AAPLX, toTokenAddress: USDG, amount: sellAmt, slippagePercent: "0.5", userWalletAddress: GUARD, swapReceiverAddress: GUARD });
  save("V2_sell_swap", strip(ss));
  const sd = ss.data?.[0];
  const decoded = sd?.tx?.data ? decodeRouterCalldata(sd.tx.data as `0x${string}`) : null;
  summary["V2_sell_swap"] = { ok: ss.ok, code: ss.code, msg: ss.msg, to: sd?.tx?.to, selector: sd?.tx?.data?.slice(0, 10), value: sd?.tx?.value, minReceive: sd?.tx?.minReceiveAmount, decoded, check: sd?.tx?.data ? checkRouteAgainstIntent(sd.tx.data as `0x${string}`, { inputToken: AAPLX, outputToken: USDG, amountInRaw: sellAmt, deadlineUnix: Math.floor(Date.now() / 1000), expectedReceiver: GUARD }) : null };
  /* V3 RWA 列表 ratio */
  const rw = await rwaTokens(okx, { chainIndex, issuer: "36" });
  save("V3_rwa_tokens", strip(rw));
  summary["V3_rwa"] = { ok: rw.ok, tokens: (rw.data?.list ?? []).map((t) => ({ sym: t.tokenSymbol, addr: t.tokenContractAddress, price: t.price, stockPrice: t.stockPrice, ratio: t.tokenToAssetRatio })) };
  /* V4 Finnhub candle 免费档 + quote */
  if (FINN) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 14 * 86400;
    const h = { "X-Finnhub-Token": FINN };
    const cr = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=AAPL&resolution=D&from=${from}&to=${to}`, { headers: h });
    const ct = await cr.text();
    const qr = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL`, { headers: h });
    const qt = await qr.text();
    save("V4_finnhub", { candle: { status: cr.status, body: ct.slice(0, 2000) }, quote: { status: qr.status, body: qt } });
    summary["V4_finnhub"] = { candleStatus: cr.status, candleHead: ct.slice(0, 200), quote: qt };
  }
  save("V5_SUMMARY", summary);
  console.info(JSON.stringify(summary, null, 1));
}
main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
