"use client";
/**
 * /agent/journal：夜班日志（GET /v1/recaps?owner&date）。纽约实际收盘后 45 分钟生成；门槛未到显示 pending 与生成时刻。
 * R-02 账目与时间线一致；R-03 模式标识可见；R-04 默认私密、公开可隐藏资产与金额；R-05 无排行榜，只有个人里程碑与可复用目录。
 * V-35：数据源健康与「重新生成」；来源未接时把任务列表里仍在等待的任务列进「剩余工作」；「翻创」统一改「复用」；金额与阻塞码走统一格式。
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { agentTasks, isRecapPending, notReady, recaps, type RecapPendingView, type RecapView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import { assetByKey, loadAssets, type AssetEntry } from "@/lib/assets";
import { EXPLORER } from "@/lib/wallet";
import type { Task } from "@chaconne/core/verify";
import { Card, Pill } from "@/components/ui";
import { LoadingState, ModeTag, NotReady, OwnerField, Skeleton, Toast, useOwnerInput, useToast } from "../shared";
import { blockerSentence, statusLabel, taskTitle } from "../tasks/taskTitle";

type L = { kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: RecapView | RecapPendingView };

export function Journal() {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const [date, setDate] = useState(sp.get("date") ?? "");
  const [state, setState] = useState<L>({ kind: "idle" });
  const [share, setShare] = useState({ public: false, hideAssets: true, hideAmounts: true });
  const [toast, setToast] = useToast();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [waiting, setWaiting] = useState<Task[] | null>(null);
  const [seq, setSeq] = useState(0);
  const [refresh, setRefresh] = useState(false);
  const reload = useCallback((regen = false) => { setRefresh(regen); setSeq((n) => n + 1); }, []);
  useEffect(() => { void loadAssets().then((r) => setAssets(r.assets)); }, []);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setState({ kind: "busy" });
    recaps.list(owner.toLowerCase(), date || undefined, refresh).then((r) => {
      if (!alive) return;
      if (r.status === 0 || notReady(r)) return setState({ kind: "nr", http: r.status });
      if (r.status !== 200) return setState({ kind: "err", msg: apiError(r, locale) });
      setState({ kind: "ok", v: r.data });
      if (!isRecapPending(r.data)) setShare({ public: r.data.share.public, hideAssets: r.data.share.hideAssets, hideAmounts: r.data.share.hideAmounts });
      if (refresh) setToast({ text: zh ? "已重新生成" : "Regenerated", tone: "ok" });
    }).catch(() => alive && setState({ kind: "nr", http: 0 }));
    // 剩余工作的兜底：任务列表里仍在等待的任务（来源未接时日志里是空的）
    agentTasks.list(owner.toLowerCase()).then((r) => { if (alive && r.status === 200) setWaiting(r.data.tasks.filter((x) => ["WAITING", "ACTIVE", "STEP_PREPARED", "PARTIAL", "AWAITING_AUTHORIZATION"].includes(x.status))); }).catch(() => undefined);
    return () => { alive = false; };
  }, [owner, valid, date, locale, seq, refresh, setToast, zh]);
  async function saveShare(id: string) {
    const r = await recaps.share(id, share).catch(() => null);
    if (!r || r.status !== 200) return setToast({ text: r ? apiError(r, locale) : t("ag_service_unreachable"), tone: "bad" });
    setToast({ text: r.data.share.public && r.data.share.publicUrl ? `${zh ? "已公开，链接" : "Public link"}: ${r.data.share.publicUrl}` : zh ? "已设为私密" : "Set to private", tone: "ok" });
    setState((s) => (s.kind === "ok" && !isRecapPending(s.v) ? { kind: "ok", v: { ...s.v, share: r.data.share } } : s));
  }
  const symbol = (k: string) => assetByKey(assets, k)?.displaySymbol ?? k;
  const amount = (raw: string | null | undefined, k: string) => { const a = assetByKey(assets, k); return formatAmount(raw, a?.tokenDecimals ?? 6, a?.displaySymbol); };
  return (
    <>
      <header><h1 className="ag-h1">{t("ag_journal_h")}</h1><p className="ag-lead">{zh ? "本交易日处理了哪些任务、为什么等、买卖了什么、剩余工作和需要你决定的事项。纽约实际收盘（含提前收盘）后 45 分钟生成；账目与时间线可复算。默认私密。" : "What the crew handled this trading day, why it waited, what was bought or sold, what is left and what needs your decision. Generated 45 minutes after the actual New York close (early closes included); ledger and timeline reconcile. Private by default."}</p></header>
      <Card>
        <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /><label>{zh ? "交易日（纽约）" : "Trading day (New York)"}<input className="field mono" value={date} onChange={(e) => setDate(e.target.value.trim())} placeholder={zh ? "留空 = 最近一个已生成的" : "empty = latest generated"} /></label></div>
        {!valid && <p className="ag-note mt-2">{zh ? "连接钱包或填地址后读取日志。" : "Connect a wallet or type an address to read the journal."}</p>}
        {state.kind === "busy" && <div className="mt-3 space-y-2" aria-busy="true"><LoadingState onRetry={() => reload(false)} /><Skeleton lines={3} /></div>}
        {state.kind === "nr" && <div className="mt-3"><NotReady what="GET /v1/recaps" status={state.http} onRetry={() => reload(false)} /></div>}
        {state.kind === "err" && <p className="mt-2 text-sm text-bad">{state.msg}</p>}
      </Card>
      {state.kind === "ok" && isRecapPending(state.v) && (
        <Card title={`${state.v.date} · ${zh ? "尚未生成" : "not generated yet"}`}>
          <p className="text-sm">{state.v.note}</p>
          <dl className="ag-kv mt-2"><dt>{zh ? "实际收盘" : "actual close"}</dt><dd>{state.v.closeAtUtc ? formatTime(state.v.closeAtUtc, locale) : "—"}{state.v.earlyClose ? ` (${zh ? "提前收盘" : "early close"})` : ""}</dd><dt>{zh ? "生成时刻" : "generated after"}</dt><dd>{state.v.generateAfterUtc ? formatTime(state.v.generateAfterUtc, locale) : "—"}</dd></dl>
          {waiting && waiting.length > 0 && <WaitingTasks tasks={waiting} assets={assets} />}
        </Card>
      )}
      {state.kind === "ok" && !isRecapPending(state.v) && <RecapBody r={state.v} share={share} setShare={setShare} onSave={() => saveShare((state.v as RecapView).id)} onRegen={() => reload(true)} symbol={symbol} amount={amount} waiting={waiting} assets={assets} />}
      <Toast msg={toast} onClose={() => setToast(null)} />
    </>
  );
}

function WaitingTasks({ tasks, assets }: { tasks: Task[]; assets: AssetEntry[] }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "任务列表里仍在等待的任务" : "Tasks still waiting (from your task list)"} · {tasks.length}</p>
      <ul className="ag-list">{tasks.map((x) => <li key={x.id}><div className="ag-actions"><Link className="underline" href={`/agent/tasks/${x.id}`}>{taskTitle(x, null, assets, locale)}</Link><Pill tone="warn">{statusLabel(x.status, locale)}</Pill></div><p className="ag-note">{x.blockers[0] ? blockerSentence(x.blockers[0], locale) : ""}{x.nextCheckAt ? ` · ${zh ? "下次检查" : "next check"} ${formatTime(x.nextCheckAt, locale)}` : ""}</p></li>)}</ul>
    </div>
  );
}

function RecapBody({ r, share, setShare, onSave, onRegen, symbol, amount, waiting, assets }: { r: RecapView; share: { public: boolean; hideAssets: boolean; hideAmounts: boolean }; setShare: (s: { public: boolean; hideAssets: boolean; hideAmounts: boolean }) => void; onSave: () => void; onRegen: () => void; symbol: (k: string) => string; amount: (raw: string | null | undefined, k: string) => string; waiting: Task[] | null; assets: AssetEntry[] }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const { sections } = r;
  const src = (k: "mandates" | "tasks" | "events") => r.coverage?.[k] ?? "unavailable";
  const srcLabel = { mandates: zh ? "授权" : "authorizations", tasks: zh ? "任务" : "tasks", events: zh ? "事件" : "events" };
  const anyDown = (["mandates", "tasks", "events"] as const).some((k) => src(k) === "unavailable");
  return (
    <>
      <div className="ag-actions">
        <h2 className="text-lg font-semibold">{r.date}</h2>
        {r.modes.map((m) => <ModeTag key={m} mode={m} />)}
        {r.earlyClose && <Pill tone="warn">{zh ? "提前收盘" : "early close"}</Pill>}
        <span className="ag-note">{zh ? "收盘" : "close"} {formatTime(r.closeAtUtc, locale)} · {zh ? "生成" : "generated"} {formatTime(r.generatedAt, locale)}</span>
        <button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={onRegen}>{zh ? "重新生成" : "Regenerate"}</button>
      </div>
      <div className="ag-actions text-xs">
        <span className="text-fg-3">{zh ? "数据源" : "Sources"}:</span>
        {(["tasks", "mandates", "events"] as const).map((k) => <Pill key={k} tone={src(k) === "ok" ? "ok" : "warn"}>{srcLabel[k]} · {src(k) === "ok" ? (zh ? "正常" : "ok") : (zh ? "未接入" : "not connected")}</Pill>)}
      </div>
      {anyDown && <p className="ag-warn">{zh ? "有数据源未接入：下面为 0 的分区不代表「什么都没发生」，只代表这份日志没拿到该来源。生成时刻之后建的任务也不在里面，可点「重新生成」。" : "A source is not connected: a section showing 0 below does not mean nothing happened, only that this journal did not receive that source. Tasks created after the generation time are not included either; use Regenerate."}</p>}
      <div className="ag-grid-2">
        <Card title={`${zh ? "处理了哪些任务" : "Handled"} · ${sections.handled.length}`}>{sections.handled.length === 0 ? <p className="ag-note">{src("tasks") === "ok" ? (zh ? "这一天没有任务。" : "No task on this day.") : (zh ? "任务来源未接入，无法列出。" : "Task source not connected; nothing can be listed.")}</p> : <ul className="ag-list">{sections.handled.map((h) => <li key={h.refId}><div className="ag-actions"><ModeTag mode={h.mode} /><Link className="underline" href={h.refKind === "task" ? `/agent/tasks/${h.refId}` : `/tasks/${h.refId}`}>{h.label || (zh ? "查看" : "open")}</Link><Pill tone="neutral">{statusLabel(h.status, locale)}</Pill></div><p className="ag-note">{zh ? "步骤" : "steps"} {h.steps.done}/{h.steps.max}{h.blockers.length ? ` · ${h.blockers.map((b) => blockerSentence(b, locale)).join("；")}` : ""}</p></li>)}</ul>}</Card>
        <Card title={`${zh ? "为什么等" : "Why it waited"} · ${sections.waited.length}`}>{sections.waited.length === 0 ? <p className="ag-note">{zh ? "没有等待记录。" : "No waits recorded."}</p> : <ul className="ag-list">{sections.waited.map((w) => <li key={w.refId}><span className="text-sm">{w.label}</span> · {w.evaluations} {zh ? "次评估" : "evaluation(s)"}<ul className="ag-list mt-1">{w.reasons.map((x) => <li key={x.code} className="text-xs">{blockerSentence(x, locale)}</li>)}</ul></li>)}</ul>}</Card>
        <Card title={`${zh ? "买卖" : "Trades"} · ${sections.trades.length}`}>{sections.trades.length === 0 ? <p className="ag-note">{zh ? "没有已确认的成交。" : "No confirmed fill."}</p> : <ul className="ag-list">{sections.trades.map((x) => <li key={`${x.refId}-${x.stepIndex}`}><div className="ag-actions"><ModeTag mode={x.mode} /><span className="text-sm">{x.side === "buy" ? (zh ? "买入" : "buy") : (zh ? "卖出" : "sell")} {symbol(x.outputAssetKey)}</span><span className="mono text-xs">{amount(x.amountInRaw, x.inputAssetKey)}{x.receivedRaw ? ` → ${amount(x.receivedRaw, x.outputAssetKey)}` : ""}</span>{x.txHash && <a className="mono text-xs underline" href={`${EXPLORER}/tx/${x.txHash}`} target="_blank" rel="noreferrer">{x.txHash.slice(0, 10)}…</a>}</div><p className="ag-note">{formatTime(x.at, locale)} · {zh ? "第" : "step"} {x.stepIndex} {zh ? "步" : ""} · {x.state}</p></li>)}</ul>}</Card>
        <Card title={`${zh ? "账目（= 时间线之和）" : "Ledger (= timeline sum)"} · ${r.ledger.length}`}>{r.ledger.length === 0 ? <p className="ag-note">{zh ? "没有花费。" : "Nothing spent."}</p> : <dl className="ag-kv">{r.ledger.map((l) => <div key={l.assetKey} className="contents"><dt>{symbol(l.assetKey)}</dt><dd className="mono">{zh ? "花" : "spent"} {amount(l.spentRaw, l.assetKey)} · {zh ? "收" : "received"} {l.receivedRaw} · {l.steps} {zh ? "步" : "step(s)"}</dd></div>)}</dl>}</Card>
        <Card title={`${zh ? "剩余工作" : "Remaining"} · ${sections.remaining.length + (sections.remaining.length === 0 ? (waiting?.length ?? 0) : 0)}`}>
          {sections.remaining.length > 0 && <ul className="ag-list">{sections.remaining.map((x) => <li key={x.refId}><span className="text-sm">{x.label}</span> · {x.stepsLeft} {zh ? "步未做" : "step(s) left"} · {zh ? "期限" : "deadline"} {formatTime(x.deadline, locale)}</li>)}</ul>}
          {sections.remaining.length === 0 && (waiting && waiting.length > 0 ? <WaitingTasks tasks={waiting} assets={assets} /> : <p className="ag-note">{zh ? "没有剩余步骤。" : "Nothing left."}</p>)}
        </Card>
        <Card title={`${zh ? "需要你决定" : "Needs your decision"} · ${sections.decisions.length}`}>{sections.decisions.length === 0 ? <p className="ag-note">{zh ? "没有待决事项。" : "Nothing to decide."}</p> : <ul className="ag-list">{sections.decisions.map((d, i) => <li key={`${d.refId}-${d.code}-${i}`}><p className="text-sm">{blockerSentence(d, locale)} <Pill tone="info">{d.action}</Pill></p><p className="ag-note">{d.label}</p></li>)}</ul>}</Card>
      </div>
      <Card title={zh ? "时间线" : "Timeline"}>{r.timeline.length === 0 ? <p className="ag-note">—</p> : <ol className="ag-timeline">{r.timeline.map((e, i) => <li key={i}><span className="text-[11px] text-fg-3">{formatTime(e.at, locale)}</span> · {e.text}{e.amountRaw ? ` · ${amount(e.amountRaw, e.assetKey ?? "")}` : ""}{e.txHash ? <> · <a className="underline" href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noreferrer">tx</a></> : null}</li>)}</ol>}</Card>
      <div className="ag-grid-2">
        <Card title={zh ? "个人里程碑（只按可核对的行为）" : "Personal milestones (verifiable actions only)"}>{r.milestones.length === 0 ? <p className="ag-note">{zh ? "还没有。第一次授权、第一次链上确认、第一次完成——每一条都带证据指针。没有排行榜。" : "None yet. First authorization, first on-chain confirmation, first completion — each with an evidence pointer. No leaderboard."}</p> : <div className="space-y-2">{r.milestones.map((m) => <div key={m.id} className="ag-milestone"><div><p className="font-semibold">{m.label[locale]}</p><p className="ag-note">{formatTime(m.at, locale)}{m.evidence.txHash ? <> · <a className="underline" href={`${EXPLORER}/tx/${m.evidence.txHash}`} target="_blank" rel="noreferrer">tx</a></> : null}</p></div></div>)}</div>}</Card>
        <Card title={zh ? "可复用的任务结构" : "Reusable task structures"}>{r.remixable.length === 0 ? <p className="ag-note">—</p> : <ul className="ag-list">{r.remixable.map((x) => <li key={x.refId}><div className="ag-actions"><span className="text-sm">{x.structure.side === "buy" ? (zh ? "买入" : "buy") : (zh ? "卖出" : "sell")} {x.structure.outputAssetKeys.map(symbol).join("+")} · {x.structure.steps} {zh ? "步" : "step(s)"}</span><Link className="btn-ghost h-7 px-2 text-xs" href={x.remixHref}>{zh ? "再来一单" : "Reuse"}</Link></div><p className="ag-note">{zh ? "只复用结构，不复制金额、钱包、授权。" : "Structure only; no amounts, wallet or authorization are copied."}</p></li>)}</ul>}</Card>
      </div>
      <Card title={zh ? "分享" : "Share"} right={<Pill tone={r.share.public ? "warn" : "ok"}>{r.share.public ? (zh ? "公开" : "public") : (zh ? "私密（默认）" : "private (default)")}</Pill>}>
        <div className="ag-actions">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={share.public} onChange={(e) => setShare({ ...share, public: e.target.checked })} />{zh ? "公开这份日志" : "Make this journal public"}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={share.hideAssets} disabled={!share.public} onChange={(e) => setShare({ ...share, hideAssets: e.target.checked })} />{zh ? "隐藏资产" : "Hide assets"}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={share.hideAmounts} disabled={!share.public} onChange={(e) => setShare({ ...share, hideAmounts: e.target.checked })} />{zh ? "隐藏金额" : "Hide amounts"}</label>
          <button className="btn-ghost" onClick={onSave}>{zh ? "保存" : "Save"}</button>
        </div>
        <p className="ag-note mt-2">{zh ? "公开视图先展示结果摘要；钱包地址永远不出现。" : "The public view shows the result summary first; the wallet address never appears."}</p>
        {r.share.publicUrl && <p className="mono mt-1 text-xs">{r.share.publicUrl}</p>}
      </Card>
    </>
  );
}
