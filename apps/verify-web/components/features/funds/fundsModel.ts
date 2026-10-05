/**
 * 资金页（v8）的纯逻辑：把 portfolio / allowances / 浏览器直读拼成一张资产表与四个 KPI。
 * 规则（V-31）：unavailable 或缺值一律是 null（页面显示「未返回」），绝不当成 0；金额全程字符串 / bigint。
 */
import type { OwnerAllowanceRow, PortfolioView } from "@/lib/api-v2";
import { rawToDecimal } from "@/lib/numbers";
import type { PortfolioBudgetGroup } from "./budgetModel";

export type { PortfolioBudgetGroup } from "./budgetModel";
export { allocationStateLabel, allocationsOf, budgetGroupsOf, normalizeBudgetGroup, periodEnded, type AllocationView } from "./budgetModel";

export interface AssetMeta { assetKey: string; displaySymbol: string; tokenDecimals: number; tokenAddress?: string; role?: string }

/** 浏览器直读结果：raw = 读到；null = 读失败；undefined = 还在读 / 没读 */
export type ChainRead = Record<string, string | null | undefined>;

export interface AllowanceCell {
  token: `0x${string}`;
  onchainRaw: string;
  requiredRaw: string;
  excessRaw: string;
  pendingPermit: boolean;
  /** 服务端的 reclaimSuggested；没给时按「多出 > 0」 */
  suggested: boolean;
}

export interface AssetRow {
  assetKey: string;
  /** null = 登记表与接口都没有这只资产（页面写「未登记资产」，不拿地址片段冒充股票名） */
  symbol: string | null;
  /** null = 精度未知：不换算金额（页面写「未返回」），不猜 6 / 18 */
  decimals: number | null;
  kind: "cash" | "stock";
  token: `0x${string}` | null;
  /** null = 未返回（服务端读不到且浏览器直读也失败 / 还没读完） */
  balanceRaw: string | null;
  balanceSource: "service" | "rpc" | null;
  priceUsd: string | null;
  planGuard: AllowanceCell | null;
}

const RAW = /^\d+$/;
const tokenOf = (assetKey: string): `0x${string}` | null => {
  const t = assetKey.split(":")[2];
  return t && /^0x[0-9a-fA-F]{40}$/.test(t) ? (t.toLowerCase() as `0x${string}`) : null;
};

/** 多出的量：服务端给 excessRaw 就用，否则 onchain − required（不为负）；与 v7 AllowanceSection.excessOf 一致 */
export function excessRawOf(r: Pick<OwnerAllowanceRow, "onchainRaw" | "requiredRaw" | "excessRaw">): string {
  if (r.excessRaw && RAW.test(r.excessRaw)) return r.excessRaw;
  const on = RAW.test(r.onchainRaw) ? BigInt(r.onchainRaw) : 0n;
  const req = RAW.test(r.requiredRaw) ? BigInt(r.requiredRaw) : 0n;
  return (on > req ? on - req : 0n).toString();
}

export function buildAssetRows(input: {
  portfolio: PortfolioView | null;
  allowances: Array<OwnerAllowanceRow & { symbol?: string; decimals?: number; reclaimSuggested?: boolean }> | null;
  assets: AssetMeta[];
  rpcBalances: ChainRead;
}): AssetRow[] {
  const { portfolio, allowances, assets, rpcBalances } = input;
  const meta = new Map(assets.map((a) => [a.assetKey, a]));
  const rows = new Map<string, AssetRow>();
  const ensure = (assetKey: string, kind: AssetRow["kind"], symbol?: string, decimals?: number): AssetRow => {
    const have = rows.get(assetKey);
    if (have) return have;
    const m = meta.get(assetKey);
    const row: AssetRow = {
      assetKey, kind,
      symbol: m?.displaySymbol ?? symbol ?? null,
      decimals: m?.tokenDecimals ?? (typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 ? decimals : null),
      token: tokenOf(assetKey), balanceRaw: null, balanceSource: null, priceUsd: null, planGuard: null,
    };
    rows.set(assetKey, row);
    return row;
  };
  const setBalance = (row: AssetRow, raw: string, unavailable: boolean | undefined) => {
    if (!unavailable && RAW.test(raw)) { row.balanceRaw = raw; row.balanceSource = "service"; return; }
    const direct = rpcBalances[row.assetKey];
    if (typeof direct === "string") { row.balanceRaw = direct; row.balanceSource = "rpc"; }
  };
  for (const c of portfolio?.cash ?? []) setBalance(ensure(c.assetKey, "cash", c.symbol, c.decimals), c.balanceRaw, c.unavailable);
  for (const h of portfolio?.holdings ?? []) {
    const row = ensure(h.assetKey, "stock", h.symbol ?? h.displaySymbol, h.decimals);
    setBalance(row, h.balanceRaw, h.unavailable);
    row.priceUsd = h.priceUsd ?? null;
  }
  for (const a of allowances ?? []) {
    const kind = meta.get(a.assetKey)?.role === "stable_input" || rows.get(a.assetKey)?.kind === "cash" ? "cash" : "stock";
    const row = ensure(a.assetKey, kind, a.symbol, a.decimals);
    row.planGuard = { token: a.token, onchainRaw: a.onchainRaw, requiredRaw: a.requiredRaw, excessRaw: excessRawOf(a), pendingPermit: a.pendingPermit, suggested: a.reclaimSuggested !== false };
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? (a.symbol ?? "\uffff").localeCompare(b.symbol ?? "\uffff") : a.kind === "cash" ? -1 : 1));
}

/** 收回按钮只在「多出 > 0、没有在途 permit、服务端没说不建议（仍在用的额度里的零头）」时出现 */
export function reclaimable(row: AssetRow): boolean {
  return Boolean(row.planGuard && !row.planGuard.pendingPermit && row.planGuard.suggested && BigInt(row.planGuard.excessRaw) > 0n);
}

/** 稳定币按 1 美元合计（不同精度对齐到 18 位）；任何一项金额或精度是 null → 整体 null（未返回） */
export function sumStable(items: Array<{ raw: string | null; decimals: number | null }>): string | null {
  let total = 0n;
  for (const it of items) {
    if (it.raw === null || !RAW.test(it.raw) || it.decimals === null) return null;
    total += BigInt(it.raw) * 10n ** BigInt(18 - Math.min(18, it.decimals));
  }
  return rawToDecimal(total, 18, 2);
}

/** 持仓市值：余额 × 价格；任何一项余额或价格缺失 → null */
export function marketValueUsd(rows: AssetRow[]): string | null {
  const stocks = rows.filter((r) => r.kind === "stock" && (r.balanceRaw === null || r.balanceRaw !== "0"));
  let cents = 0n;
  for (const r of stocks) {
    if (r.balanceRaw === null || r.decimals === null || !r.priceUsd || !/^\d+(\.\d+)?$/.test(r.priceUsd)) return null;
    const [i = "0", f = ""] = r.priceUsd.split(".");
    const priceMicros = BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
    cents += (BigInt(r.balanceRaw) * priceMicros) / 10n ** BigInt(r.decimals + 4);
  }
  return rawToDecimal(cents, 2, 2);
}

export interface FundsKpis {
  available: string | null;
  authorized: string | null;
  marketValue: string | null;
  reserved: string | null;
  groupCount: number | null;
}

/** portfolioLoaded：资产接口确实返回了。返回了但一行现金都没有 = 真的没有现金（0），不说成读取失败 */
export function fundsKpis(rows: AssetRow[], groups: PortfolioBudgetGroup[] | null, assets: AssetMeta[], portfolioLoaded = true): FundsKpis {
  const cash = rows.filter((r) => r.kind === "cash");
  const available = cash.length ? sumStable(cash.map((r) => ({ raw: r.balanceRaw, decimals: r.decimals }))) : portfolioLoaded ? "0" : null;
  const pg = cash.filter((r) => r.planGuard).map((r) => ({ raw: r.planGuard!.onchainRaw, decimals: r.decimals }));
  const authorized = pg.length ? sumStable(pg) : null;
  const dec = (k: string) => assets.find((a) => a.assetKey === k)?.tokenDecimals ?? null;
  const reserved = groups ? sumStable(groups.map((g) => ({ raw: g.reservedRaw, decimals: dec(g.inputAssetKey) }))) : null;
  return { available, authorized, marketValue: marketValueUsd(rows), reserved, groupCount: groups ? groups.length : null };
}
