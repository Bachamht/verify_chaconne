"use client";
/**
 * 可交易资产（登记表）的四态读取：/start 与 /agent/new 共用。
 * fixture（?v7fixture=1）用固定三项，不发请求；登记表不可达且没有缓存 → error（不是空）。
 */
import { useMemo, useRef } from "react";
import { loadAssets, stablesOf, stocksOf, type AssetEntry, type AssetsLoad } from "@/lib/assets";
import { useResource } from "@/lib/useResource";
import { FX_AAPLX, FX_NVDAX, FX_USDG } from "@/lib/v7fixtures";

export const FIXTURE_ASSETS: AssetEntry[] = [
  { assetKey: FX_USDG, tokenAddress: FX_USDG.split(":")[2]!, tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", underlyingId: "fiat:USD", executionAllowed: true },
  { assetKey: FX_AAPLX, tokenAddress: FX_AAPLX.split(":")[2]!, tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output", underlyingId: "NASDAQ:AAPL", executionAllowed: true },
  { assetKey: FX_NVDAX, tokenAddress: FX_NVDAX.split(":")[2]!, tokenDecimals: 18, displaySymbol: "NVDAx", role: "stock_output", underlyingId: "NASDAQ:NVDA", executionAllowed: true },
] as AssetEntry[];

export function useTradableAssets(fixture: boolean) {
  const force = useRef(false);
  const r = useResource<AssetsLoad>(fixture ? "assets:fixture" : "assets", async () => {
    if (fixture) return { status: 200, data: { assets: FIXTURE_ASSETS, source: "live", evidenceMode: null } };
    const a = await loadAssets({ force: force.current });
    force.current = false;
    return { status: a.source === "none" ? 503 : 200, data: a };
  }, { isEmpty: (d) => stocksOf(d.assets).length === 0 || stablesOf(d.assets).length === 0 });
  const assets = useMemo(() => r.data?.assets ?? [], [r.data]);
  const stocks = useMemo(() => stocksOf(assets), [assets]);
  const stables = useMemo(() => stablesOf(assets), [assets]);
  const reload = () => { force.current = true; r.reload(); };
  return { state: r.state, status: r.status, source: r.data?.source ?? "none", assets, stocks, stables, reload };
}
export type TradableAssets = ReturnType<typeof useTradableAssets>;
