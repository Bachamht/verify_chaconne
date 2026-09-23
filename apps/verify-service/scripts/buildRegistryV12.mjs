/**
 * 生成 xlayer-registry/1.2.0：把展示层里体检合格的 xStocks 提升进执行层。
 *
 * 为什么是脚本而不是手改：展示层配置里那句「新增代币必须走同样的双源核验并记录，勿凭记忆添加」
 * 对执行层只会更严。这里把提升的判据与出处一起写死，任何人重跑都能得到同一份文件。
 *
 * 判据（2026-09-23 实测，全部有脚本留痕）：
 *   ① 链上 eth_call 读 symbol() / decimals() 与名录一致 —— 39/39 通过；
 *   ② OKX 聚合器**双向**可路由（买 100 USDG 档 + 把买到的量原路卖回）—— 38/39 通过，NKEx 卖出 82000；
 *   ③ Finnhub 有美股参考价 —— 39/39 通过。
 * 三条全过才给 executionAllowed=true。NKEx 只过 ①③，**买得进卖不出**，因此留在登记表里但
 * executionAllowed=false —— 与 SPYx 此前的处理一致，把"为什么不放行"记在表里而不是删掉了事。
 *
 *   node apps/verify-service/scripts/buildRegistryV12.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = join(HERE, "..", "config");
const NEW_VERSION = "xlayer-registry/1.2.0";
const VERIFIED_AT = "2026-09-23T02:55:00.000Z";
/** 买得进卖不出：OKX 卖出方向返回 82000（无池）。不放行执行，避免用户买进去出不来。 */
const SELL_BLOCKED = new Set(["NKEx"]);

const base = JSON.parse(readFileSync(join(CFG, "registry.xlayer.v1.1.json"), "utf8"));
const display = JSON.parse(readFileSync(join(CFG, "xlayer.display.json"), "utf8"));

const provenanceFor = (sym, underlying) => [
  { source: `OKX RWA 名录 API（category=47, chainIndex=196）登记项：${sym} / ${underlying}`, url: "https://web3.okx.com/api/v6/dex/market/rwa/tokens", verifiedAt: display.verifiedAt + "T00:00:00.000Z" },
  { source: `X Layer 节点 eth_call：symbol()=${sym}、decimals()=18，与名录一致；sharesOf() 存在（份额记账/rebasing）`, verifiedAt: VERIFIED_AT },
  { source: "OKX 聚合器双向报价实测：买入 100 USDG 档可路由；把买到的数量原路卖回亦可路由（提升进执行层的硬条件）", verifiedAt: VERIFIED_AT },
  { source: `Finnhub 美股参考价可取（${underlying}），参考价管线覆盖该底层`, verifiedAt: VERIFIED_AT },
];

const entries = base.entries.map((e) => ({ ...e, registryVersion: NEW_VERSION }));
const bySymbol = new Map(entries.map((e) => [e.displaySymbol, e]));

// SPYx 早就在表里但 executionAllowed=false（当时 decimals 待链上确认）。现已确认，放行。
const spy = bySymbol.get("SPYx");
if (spy) {
  spy.executionAllowed = true;
  spy.executionSides = ["buy", "sell"];
  spy.unitSource = { ...spy.unitSource, description: spy.unitSource.description.replace("decimals to be confirmed on-chain before executionAllowed.", "decimals 已于 2026-09-23 链上确认为 18，双向报价实测可路由，放行执行。") };
  spy.provenance = [...spy.provenance, ...provenanceFor("SPYx", "SPY").slice(1)];
}

let added = 0;
for (const t of display.tokens) {
  if (bySymbol.has(t.symbol)) continue; // SPYx 已在表内
  const allowed = !SELL_BLOCKED.has(t.symbol);
  entries.push({
    assetKey: `eip155:${display.chainId}:${t.address.toLowerCase()}`,
    chainId: display.chainId,
    tokenAddress: t.address.toLowerCase(),
    tokenDecimals: t.decimals,
    issuerId: "xstocks",
    displaySymbol: t.symbol,
    underlyingId: `us-equity:${t.underlying}`,
    tokenForm: "rebasing",
    registryVersion: NEW_VERSION,
    role: "stock_output",
    sharesPerToken: "1",
    unitSource: {
      description: "xStocks EVM 版为 rebasing ERC-20：balanceOf() 返回已按股权调整的余额，1 个可转移单位 = 当前乘数下 1 股的经济敞口。每次执行前重新核对公司行动。",
      verifiedAt: VERIFIED_AT,
    },
    usdPegSource: null,
    provenance: allowed
      ? provenanceFor(t.symbol, t.underlying)
      : [...provenanceFor(t.symbol, t.underlying).filter((p) => !p.source.startsWith("OKX 聚合器双向")), { source: "OKX 聚合器双向报价实测：买入可路由，**卖出返回 82000（X Layer 上无池）**。买得进卖不出，因此不放行执行；待卖出侧有池后再提升。", verifiedAt: VERIFIED_AT }],
    executionAllowed: allowed,
    ...(allowed ? { executionSides: ["buy", "sell"] } : {}),
  });
  added += 1;
}

const out = {
  version: NEW_VERSION,
  chainId: base.chainId,
  entries,
  notes: [
    ...(base.notes ?? []),
    `1.2.0（2026-09-23）：展示层 ${display.tokens.length} 只逐只体检后提升进执行层，新增 ${added} 条，放行 ${entries.filter((e) => e.role === "stock_output" && e.executionAllowed).length} 只股票。`,
    "提升判据：链上 symbol/decimals 一致 + OKX 聚合器双向可路由 + Finnhub 有美股参考价，三条全过才放行。",
    "NKEx 只过两条（卖出无池），留在表内但 executionAllowed=false，理由记在其 provenance 里。",
    "全部股票代币都是 rebasing（份额记账）：每笔转账少 1 wei，v1 Guard 无容差故单笔任务的卖出必然 revert，卖出须走 PlanGuard 授权计划。此限制与 AAPLx/NVDAx 相同，不因本次扩容而改变。",
  ],
};
writeFileSync(join(CFG, "registry.xlayer.v1.2.json"), JSON.stringify(out, null, 2) + "\n");
const stocks = entries.filter((e) => e.role === "stock_output");
console.log(`已写 registry.xlayer.v1.2.json：条目 ${entries.length}（稳定币 ${entries.length - stocks.length}，股票 ${stocks.length}）`);
console.log(`  新增 ${added} 条；放行执行的股票 ${stocks.filter((e) => e.executionAllowed).length} 只；不放行 ${stocks.filter((e) => !e.executionAllowed).map((e) => e.displaySymbol).join(", ") || "无"}`);
