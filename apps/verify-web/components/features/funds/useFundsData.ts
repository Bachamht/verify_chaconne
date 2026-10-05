"use client";
/**
 * 资金页取数：组合（GET /v1/portfolio/:owner）+ 给 PlanGuard 的额度（GET /v1/owners/:owner/allowances）+ 资产登记表。
 * 浏览器只读兜底（不弹窗）：服务端读不到的余额直读一次 balanceOf。单笔交易用的 Guard 合约 10/5 起不再展示（Agent 任务只用 PlanGuard）。
 */
import { useEffect, useMemo, useState } from "react";
import { portfolio, v7 } from "@/lib/api-v2";
import { loadAssets } from "@/lib/assets";
import { useAccount } from "@/lib/useAccount";
import { useResource } from "@/lib/useResource";
import { balanceOf } from "@/lib/wallet";
import { budgetGroupsOf, buildAssetRows, fundsKpis, type AssetMeta, type ChainRead } from "./fundsModel";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

function useChainReads(key: string | null, targets: Array<{ assetKey: string; token: `0x${string}` }>, read: (token: `0x${string}`) => Promise<bigint>): ChainRead {
  const [out, setOut] = useState<ChainRead>({});
  useEffect(() => {
    if (!key || targets.length === 0) return;
    let alive = true;
    setOut({});
    for (const t of targets) {
      read(t.token)
        .then((v) => alive && setOut((m) => ({ ...m, [t.assetKey]: v.toString() })))
        .catch(() => alive && setOut((m) => ({ ...m, [t.assetKey]: null })));
    }
    return () => { alive = false; };
    // targets / read 由 key 决定（key 里含 owner、spender 与资产列表），key 变化时才重读
  }, [key]);
  return out;
}

export function useFundsData() {
  const account = useAccount();
  const owner = account && ADDR.test(account) ? account.toLowerCase() : null;
  const assets = useResource("assets", async () => ({ status: 200, data: (await loadAssets()).assets as AssetMeta[] }));
  const pf = useResource(owner ? `pf:${owner}` : null, () => portfolio.get(owner!), { intervalMs: 60_000 });
  const al = useResource(owner ? `al:${owner}` : null, () => v7.ownerAllowances(owner!), { intervalMs: 60_000 });

  const tokenTargets = (keys: string[]) => keys.flatMap((k) => {
    const t = k.split(":")[2];
    return t && ADDR.test(t) ? [{ assetKey: k, token: t as `0x${string}` }] : [];
  });
  const unavailableKeys = useMemo(() => {
    const v = pf.data;
    return v ? [...(v.cash ?? []), ...v.holdings].filter((x) => x.unavailable).map((x) => x.assetKey) : [];
  }, [pf.data]);

  const rpcBalances = useChainReads(owner && unavailableKeys.length ? `bal:${owner}:${unavailableKeys.join(",")}` : null, tokenTargets(unavailableKeys), (t) => balanceOf(t, owner as `0x${string}`));

  const assetList = assets.data ?? [];
  const rows = useMemo(() => buildAssetRows({ portfolio: pf.data, allowances: al.data?.allowances ?? null, assets: assetList, rpcBalances }),
    [pf.data, al.data, assetList, rpcBalances]);
  const groups = useMemo(() => budgetGroupsOf(pf.data), [pf.data]);
  const kpis = useMemo(() => fundsKpis(rows, groups, assetList, pf.data !== null), [rows, groups, assetList, pf.data]);
  const readingChain = unavailableKeys.some((k) => rpcBalances[k] === undefined);

  return { owner, assets: assetList, pf, al, rows, groups, kpis, readingChain };
}
