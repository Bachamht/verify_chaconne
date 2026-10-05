"use client";
/** 本任务持仓（P3）：买入 / 卖出 / 净持仓（本任务）/ 最多可卖（= 链上全部余额，D-092 2026-10-02 简化）。 */
import { useCallback, useEffect, useState } from "react";
import { notReady, v7, type TaskPosition } from "@/lib/api-v2";
import { formatAmount } from "@/lib/format";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { Card } from "@/components/ui";
import { NotReady } from "../../shared";
import { fxPositions } from "@/lib/v7fixtures";
import { useV7 } from "./useV7";

export function usePositions(taskId: string, fixture: boolean, initial: TaskPosition[] | null | undefined, refreshKey?: unknown) {
  const [rows, setRows] = useState<TaskPosition[] | null>(fixture ? fxPositions() : (initial ?? null));
  const [nr, setNr] = useState<number | null>(null);
  const load = useCallback(async () => {
    if (fixture) return;
    const r = await v7.positions(taskId).catch(() => null);
    if (!r || r.status === 0) return;
    if (notReady(r)) { setNr(r.status); return; }
    if (r.status === 200) { setRows(r.data.positions); setNr(null); }
  }, [fixture, taskId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return { rows, nr, reload: load };
}

export function PositionsCard({ rows, nr, assets, onRetry }: { rows: TaskPosition[] | null; nr: number | null; assets: AssetEntry[]; onRetry: () => void }) {
  const { s } = useV7();
  const sym = (k: string) => assetByKey(assets, k)?.displaySymbol ?? k.slice(-6);
  const dec = (k: string) => assetByKey(assets, k)?.tokenDecimals ?? 18;
  const amt = (raw: string | null | undefined, k: string) => (raw === null || raw === undefined ? "—" : formatAmount(raw, dec(k), undefined, 6));
  return (
    <Card title={s("pos_h")}>
      {nr !== null ? <NotReady what="GET /v1/tasks/:id/positions" status={nr} onRetry={onRetry} /> : !rows ? <p className="ag-note">{s("loading")}</p> : rows.length === 0 ? <p className="ag-note">{s("pos_empty")}</p> : (
        <div className="v7-rows">
          <div className="v7-row v7-row-head"><span /><span>{s("pos_net")}</span><span>{s("pos_sellable")}</span><span>{s("pos_avg")}</span></div>
          {rows.map((p) => (
            <div key={p.assetKey} className="v7-row">
              <span><strong>{sym(p.assetKey)}</strong><span className="ag-note block">{s("pos_bought")} {amt(p.boughtRaw, p.assetKey)} · {s("pos_sold")} {amt(p.soldRaw, p.assetKey)}{p.onchainRaw !== null ? ` · ${s("pos_onchain")} ${amt(p.onchainRaw, p.assetKey)}` : ""}</span></span>
              <span><span className="v7-k">{s("pos_net")}</span><span className="mono">{amt(p.netRaw, p.assetKey)}</span></span>
              <span><span className="v7-k">{s("pos_sellable")}</span><span className="mono">{amt(p.sellableRaw, p.assetKey)}</span></span>
              <span><span className="v7-k">{s("pos_avg")}</span><span className="mono">{p.avgCostUsd ? `$${p.avgCostUsd}` : "—"}</span></span>
            </div>
          ))}
        </div>
      )}
      <p className="ag-note mt-2">{s("pos_note")}</p>
    </Card>
  );
}
