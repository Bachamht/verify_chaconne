"use client";
/**
 * P2 委托向导（v7 外观）：状态与签名编排在 useDelegationWizard（v7 / v8 外观共用，签名代码只有一处）。
 * 计数器只读服务端 counts；拒签保留已签项、从断点继续；409 permit_nonce_stale / permit_pending 自动重取；
 * 全部签完后轮询 permit 上链（平台执行身份代付 gas），完成后显示「Chaconne Agent 已接班」。
 * 服务端永不代签：签名只在你的钱包里发生；本组件不发任何交易。
 */
import Link from "next/link";
import type { DelegationItem } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { tv, type V7Key } from "@/lib/i18n.v7";
import { assetByKey } from "@/lib/assets";
import { EXPLORER, short } from "@/lib/wallet";
import { Pill } from "@/components/ui";
import { LoadingState, ModeTag, NotReady } from "../shared";
import { counterView, itemPosition, nextItem, orderItems, sellAssetOf } from "./delegationModel";
import { useDelegationWizard } from "./useDelegationWizard";
import "../v7.css";

const STATUS_TONE: Record<DelegationItem["status"], "ok" | "info" | "bad" | "neutral"> = { confirmed: "ok", not_needed: "ok", submitted: "info", failed: "bad", todo: "neutral" };

export function DelegationWizard({ taskId, owner, fixture = false, onComplete }: { taskId: string; owner?: string | null; fixture?: boolean; onComplete?: () => void }) {
  const { locale } = useI18n();
  const { assets, list, load, step, msg, phase, fetchList, run, refreshSell } = useDelegationWizard({ taskId, owner, fixture, onComplete });

  if (load.kind === "busy") return <LoadingState label={tv(locale, "loading")} onRetry={() => void fetchList()} />;
  if (load.kind === "nr") return <NotReady what="GET /v1/tasks/:id/delegation" status={load.http} onRetry={() => void fetchList()} />;
  if (load.kind === "err") return <p className="text-sm text-bad" role="alert">{load.msg}</p>;
  if (!list) return null;

  const items = orderItems(list.items);
  const c = counterView(list.counts);
  const next = nextItem(list);
  const nextK = next ? itemPosition(list, next.id) : 0;
  const started = c.done > 0;
  const sym = (k: string) => assetByKey(assets, k)?.displaySymbol ?? (k.length > 12 ? `${k.slice(-6)}` : k);
  const busy = step.kind !== "idle";
  const gas = c.gasZero ? tv(locale, "d_gas_zero") : tv(locale, "d_gas_user");
  return (
    <div className="space-y-4">
      {fixture && <p className="ag-warn"><ModeTag mode="FIXTURE" /> {tv(locale, "fixture_note")}</p>}
      <div className="v7-counter" role="status" aria-live="polite" data-testid="delegation-counter">
        <span>{tv(locale, "d_counter", { done: c.done, needed: c.needed, tx: c.tx, gas })}</span>
      </div>
      {c.tx > 0 && <p className="ag-warn">{tv(locale, "d_fallback_tx", { n: c.tx })}</p>}
      {phase === "signing" && (
        <div className="v7-prewarn">
          <h3>{tv(locale, "d_prewarn_h")}</h3>
          <ul><li>{tv(locale, "d_prewarn_1")}</li><li>{tv(locale, "d_prewarn_2")}</li>{c.tx === 0 && <li>{tv(locale, "d_prewarn_3")}</li>}</ul>
        </div>
      )}
      {phase === "empty" ? <p className="ag-note">{tv(locale, "d_empty")}</p> : (
        <ol className="v7-items">
          {items.map((it) => {
            const current = (step.kind === "signing" || step.kind === "submitting") && itemPosition(list, it.id) === step.k;
            const kindKey = (it.kind === "mandate_buy" ? "d_kind_mandate_buy" : it.kind === "mandate_sell" ? "d_kind_mandate_sell" : "d_kind_permit") as V7Key;
            const statusKey = `d_status_${it.status}` as V7Key;
            const sellAsset = sellAssetOf(it.id);
            return (
              <li key={it.id} className="v7-item" data-status={it.status} data-current={current ? "1" : "0"}>
                <div className="v7-item-head">
                  <strong>{it.title[locale] || `${tv(locale, kindKey)} · ${sym(it.assetKey)}`}</strong>
                  <Pill tone={STATUS_TONE[it.status]}>{tv(locale, statusKey)}</Pill>
                  {current && <span className="ag-note">{step.kind === "signing" ? tv(locale, "d_signing", { k: step.k }) : tv(locale, "d_submitting", { k: step.k })}</span>}
                </div>
                <p>{it.explain[locale]}</p>
                {it.status === "not_needed" && <p className="ag-note">{tv(locale, "d_not_needed_note")}</p>}
                {it.status === "failed" && it.error && <p className="text-sm text-bad">{tv(locale, "d_item_failed", { why: it.error.message || it.error.code })}</p>}
                {it.status === "failed" && sellAsset && !it.typedData && <button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={() => void refreshSell()}>{tv(locale, "d_refresh_sell")}</button>}
                {it.kind === "permit" && it.txHash && <a className="mono text-xs underline" href={`${EXPLORER}/tx/${it.txHash}`} target="_blank" rel="noreferrer">{tv(locale, "d_tx_link")} · {short(it.txHash)} ↗</a>}
              </li>
            );
          })}
        </ol>
      )}
      {step.kind === "refetch" && <p className="ag-note" role="status">{tv(locale, "d_refetching")}</p>}
      {msg && <p className={msg.tone === "bad" ? "text-sm text-bad" : "ag-warn"} role="alert">{msg.text}</p>}
      {phase === "signing" && (
        <div className="ag-actions">
          <button type="button" className="btn" disabled={busy || fixture} onClick={() => void run()}>{busy ? (step.kind === "signing" ? tv(locale, "d_signing", { k: step.k }) : step.kind === "submitting" ? tv(locale, "d_submitting", { k: step.k }) : tv(locale, "loading")) : started || msg ? tv(locale, "d_resume", { k: nextK }) : tv(locale, "d_start")}</button>
        </div>
      )}
      {phase === "onchain" && (
        <div className="v7-prewarn" role="status" aria-live="polite">
          <h3>{tv(locale, "d_onchain_h")}</h3>
          <p className="ag-loading ag-note"><span className="ag-spinner" aria-hidden="true" />{tv(locale, "d_onchain_wait")}</p>
          <div className="ag-actions mt-2">
            {list.buyReady && <Pill tone="ok">{tv(locale, "d_buy_ready")}</Pill>}
            {Object.entries(list.sellReady).filter(([, v]) => v).map(([k]) => <Pill key={k} tone="ok">{tv(locale, "d_sell_ready", { asset: sym(k) })}</Pill>)}
          </div>
        </div>
      )}
      {phase === "done" && (
        <div className="v7-done" role="status">
          <h3>{tv(locale, "d_done_h")}</h3>
          <p>{tv(locale, "d_done_p", { tx: c.tx, gas })}</p>
          <div className="ag-actions"><Link className="btn" href={`/agent/tasks/${taskId}${fixture ? "?v7fixture=1" : ""}`}>{tv(locale, "d_open_task")}</Link></div>
        </div>
      )}
      <p className="ag-note">{tv(locale, "proof_scope")}</p>
    </div>
  );
}
