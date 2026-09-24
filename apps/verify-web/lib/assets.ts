"use client";
/**
 * 资产登记表（GET /v1/assets）的唯一读取点（V-29）：失败时用上次缓存的列表 + 可重试，不把「登记表不可达」当成空。
 * 缓存只存公开的登记表内容（symbol / decimals / 角色），不含任何用户数据。
 */
import { api, type AssetsResponse } from "./api";

export type AssetEntry = AssetsResponse["assets"][number];
export interface AssetsLoad {
  assets: AssetEntry[];
  /** live = 本次请求成功；cache = 请求失败、显示上次缓存；none = 既失败也无缓存 */
  source: "live" | "cache" | "none";
  evidenceMode: AssetsResponse["evidenceMode"] | null;
}

const KEY = "verify_assets_cache_v1";
let memo: AssetsLoad | null = null;

function readCache(): AssetEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as AssetEntry[]) : [];
    return Array.isArray(arr) ? arr.filter((a) => a && typeof a.assetKey === "string") : [];
  } catch {
    return [];
  }
}
function writeCache(list: AssetEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* 私密窗口等 */
  }
}

export async function loadAssets(opts: { force?: boolean } = {}): Promise<AssetsLoad> {
  if (memo && memo.source === "live" && !opts.force) return memo;
  let r: Awaited<ReturnType<typeof api<AssetsResponse>>> | null = null;
  try {
    r = await api<AssetsResponse>("GET", "v1/assets");
  } catch {
    r = null;
  }
  if (r && r.status === 200 && Array.isArray(r.data.assets)) {
    writeCache(r.data.assets);
    memo = { assets: r.data.assets, source: "live", evidenceMode: r.data.evidenceMode };
    return memo;
  }
  const cached = readCache();
  memo = { assets: cached, source: cached.length ? "cache" : "none", evidenceMode: null };
  return memo;
}

export const stocksOf = (list: AssetEntry[]) => list.filter((a) => a.role === "stock_output" && a.executionAllowed);
export const stablesOf = (list: AssetEntry[]) => list.filter((a) => a.role === "stable_input");
/** 默认支付币种：USDG 优先，其次第一个稳定币 */
export function defaultStable(list: AssetEntry[]): AssetEntry | null {
  const s = stablesOf(list);
  return s.find((a) => /^USDG$/i.test(a.displaySymbol)) ?? s[0] ?? null;
}
export function assetByKey(list: AssetEntry[], key: string | null | undefined): AssetEntry | null {
  if (!key) return null;
  const k = key.toLowerCase();
  return list.find((a) => a.assetKey.toLowerCase() === k) ?? null;
}
