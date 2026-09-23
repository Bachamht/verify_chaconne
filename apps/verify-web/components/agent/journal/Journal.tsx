"use client";
/**
 * /agent/journal：夜班日志（GET /v1/recaps?owner&date）。纽约实际收盘后 45 分钟生成；门槛未到显示 pending 与生成时刻。
 * R-02 账目与时间线一致；R-03 模式标识可见；R-04 默认私密、公开可隐藏资产与金额；R-05 无排行榜，只有个人里程碑与可翻创目录。
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { isRecapPending, notReady, recaps, type RecapPendingView, type RecapView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { fmtLocal, rawToHuman } from "@/lib/format";
import { EXPLORER } from "@/lib/wallet";
import { Card, Pill } from "@/components/ui";
import { ModeTag, NotReady, OwnerField, shortKey, useOwnerInput } from "../shared";

type L = { kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: RecapView | RecapPendingView };

export function Journal() {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const [date, setDate] = useState(sp.get("date") ?? "");
  const [state, setState] = useState<L>({ kind: "idle" });
  const [share, setShare] = useState({ public: false, hideAssets: true, hideAmounts: true });
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setState({ kind: "busy" });
    recaps.list(owner.toLowerCase(), date || undefined).then((r) => {
      if (!alive) return;
      if (notReady(r)) return setState({ kind: "nr", http: r.status });
      if (r.status !== 200) return setState({ kind: "err", msg: apiError(r, locale) });
      setState({ kind: "ok", v: r.data });
      if (!isRecapPending(r.data)) setShare({ public: r.data.share.public, hideAssets: r.data.share.hideAssets, hideAmounts: r.data.share.hideAmounts });
    }).catch(() => alive && setState({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [owner, valid, date, locale]);
  async function saveShare(id: string) {
    setShareMsg(null);
    const r = await recaps.share(id, share).catch(() => null);
    if (!r || r.status !== 200) return setShareMsg(r ? apiError(r, locale) : zh ? "服务不可达" : "Service unreachable");
    setShareMsg(r.data.share.public && r.data.share.publicUrl ? `${zh ? "公开链接" : "Public link"}: ${r.data.share.publicUrl}` : zh ? "已设为私密" : "Set to private");
    setState((s) => (s.kind === "ok" && !isRecapPending(s.v) ? { kind: "ok", v: { ...s.v, share: r.data.share } } : s));
  }
  const asset = (k: string) => shortKey(k);
  return (
    <>
      <header><h1 className="ag-h1">{t("nav_agent_journal")}</h1><p className="ag-lead">{zh ? "本交易日处理了哪些任务、为什么等、买卖了什么、剩余工作和需要你决定的事项。纽约实际收盘（含提前收盘）后 45 分钟生成；账目与时间线可复算。默认私密。" : "What the crew handled this trading day, why it waited, what was bought or sold, what is left and what needs your decision. Generated 45 minutes after the actual New York close (early closes included); ledger and timeline reconcile. Private by default."}</p></header>
      <Card>
        <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /><label>{zh ? "交易日（纽约）" : "Trading day (New York)"}<input className="field mono" value={date} onChange={(e) => setDate(e.target.value.trim())} placeholder={zh ? "留空 = 最近一个已生成的" : "empty = latest generated"} /></label></div>
        {!valid && <p className="ag-note mt-2">{zh ? "连接钱包或填地址后读取日志。" : "Connect a wallet or type an address to read the journal."}</p>}
        {state.kind === "busy" && <p className="ag-note mt-2">{t("ag_loading")}</p>}
        {state.kind === "nr" && <div className="mt-3"><NotReady what="GET /v1/recaps" status={state.http} /></div>}
        {state.kind === "err" && <p className="mt-2 text-sm text-bad">{state.msg}</p>}
      </Card>
      {state.kind === "ok" && isRecapPending(state.v) && (
        <Card title={`${state.v.date} · ${zh ? "尚未生成" : "not generated yet"}`}>
          <p className="text-sm">{state.v.note}</p>
          <dl className="ag-kv mt-2"><dt>{zh ? "实际收盘" : "actual close"}</dt><dd className="mono">{state.v.closeAtUtc ? fmtLocal(state.v.closeAtUtc, locale) : "—"}{state.v.earlyClose ? ` (${zh ? "提前收盘" : "early close"})` : ""}</dd><dt>{zh ? "生成时刻" : "generated after"}</dt><dd className="mono">{state.v.generateAfterUtc ? fmtLocal(state.v.generateAfterUtc, locale) : "—"}</dd></dl>
        </Card>
      )}
      {state.kind === "ok" && !isRecapPending(state.v) && <RecapBody r={state.v} share={share} setShare={setShare} onSave={() => saveShare((state.v as RecapView).id)} shareMsg={shareMsg} asset={asset} />}
    </>
  );
}

function RecapBody({ r, share, setShare, onSave, shareMsg, asset }: { r: RecapView; share: { public: boolean; hideAssets: boolean; hideAmounts: boolean }; setShare: (s: { public: boolean; hideAssets: boolean; hideAmounts: boolean }) => void; onSave: () => void; shareMsg: string | null; asset: (k: string) => string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const { sections } = r;
  return (
    <>
      <div className="ag-actions">
        <h2 className="text-lg font-semibold">{r.date}</h2>
        {r.modes.map((m) => <ModeTag key={m} mode={m} />)}
        {r.earlyClose && <Pill tone="warn">{zh ? "提前收盘" : "early close"}</Pill>}
        <span className="ag-note">{zh ? "收盘" : "close"} {fmtLocal(r.closeAtUtc, locale)} · {zh ? "生成" : "generated"} {fmtLocal(r.generatedAt, locale)}</span>
        {(r.coverage.tasks === "unavailable" || r.coverage.events === "unavailable") && <Pill tone="neutral">{zh ? `来源未接：${[r.coverage.tasks === "unavailable" ? "tasks" : "", r.coverage.events === "unavailable" ? "events" : ""].filter(Boolean).join(", ")}` : `not wired: ${[r.coverage.tasks === "unavailable" ? "tasks" : "", r.coverage.events === "unavailable" ? "events" : ""].filter(Boolean).join(", ")}`}</Pill>}
      </div>
      <div className="ag-grid-2">
        <Card title={`${zh ? "处理了哪些任务" : "Handled"} · ${sections.handled.length}`}>{sections.handled.length === 0 ? <p className="ag-note">{zh ? "这一天没有任务。" : "No task on this day."}</p> : <ul className="ag-list">{sections.handled.map((h) => <li key={h.refId}><div className="ag-actions"><ModeTag mode={h.mode} /><Link className="mono text-xs underline" href={h.refKind === "task" ? `/agent/tasks/${h.refId}` : `/tasks/${h.refId}`}>{h.refId}</Link><Pill tone="neutral">{h.status}</Pill><span className="text-xs text-fg-2">{h.label}</span></div><p className="ag-note">{zh ? "步骤" : "steps"} {h.steps.done}/{h.steps.max}{h.blockers.length ? ` · ${h.blockers.map((b) => b.code).join(", ")}` : ""}</p></li>)}</ul>}</Card>
        <Card title={`${zh ? "为什么等" : "Why it waited"} · ${sections.waited.length}`}>{sections.waited.length === 0 ? <p className="ag-note">{zh ? "没有等待记录。" : "No waits recorded."}</p> : <ul className="ag-list">{sections.waited.map((w) => <li key={w.refId}><span className="mono text-xs">{w.refId}</span> · {w.evaluations} {zh ? "次评估" : "evaluation(s)"}<ul className="ag-list mt-1">{w.reasons.map((x) => <li key={x.code} className="ag-blocker"><code>{x.code}</code><span>{x.text}</span></li>)}</ul></li>)}</ul>}</Card>
        <Card title={`${zh ? "买卖" : "Trades"} · ${sections.trades.length}`}>{sections.trades.length === 0 ? <p className="ag-note">{zh ? "没有已确认的成交。" : "No confirmed fill."}</p> : <ul className="ag-list">{sections.trades.map((x) => <li key={`${x.refId}-${x.stepIndex}`}><div className="ag-actions"><ModeTag mode={x.mode} /><span className="text-sm">{x.side} {asset(x.outputAssetKey)}</span><span className="mono text-xs">{rawToHuman(x.amountInRaw, 6)} {asset(x.inputAssetKey)}</span>{x.txHash && <a className="mono text-xs underline" href={`${EXPLORER}/tx/${x.txHash}`} target="_blank" rel="noreferrer">{x.txHash.slice(0, 10)}…</a>}</div><p className="ag-note">{fmtLocal(x.at, locale)} · step {x.stepIndex} · {x.state}</p></li>)}</ul>}</Card>
        <Card title={`${zh ? "账目（= 时间线之和）" : "Ledger (= timeline sum)"} · ${r.ledger.length}`}>{r.ledger.length === 0 ? <p className="ag-note">{zh ? "没有花费。" : "Nothing spent."}</p> : <dl className="ag-kv">{r.ledger.map((l) => <div key={l.assetKey} className="contents"><dt>{asset(l.assetKey)}</dt><dd className="mono">{zh ? "花" : "spent"} {rawToHuman(l.spentRaw, 6)} · {zh ? "收" : "received"} {l.receivedRaw} · {l.steps} {zh ? "步" : "step(s)"}</dd></div>)}</dl>}</Card>
        <Card title={`${zh ? "剩余工作" : "Remaining"} · ${sections.remaining.length}`}>{sections.remaining.length === 0 ? <p className="ag-note">{zh ? "没有剩余步骤。" : "Nothing left."}</p> : <ul className="ag-list">{sections.remaining.map((x) => <li key={x.refId}><span className="mono text-xs">{x.refId}</span> · {x.stepsLeft} {zh ? "步未做" : "step(s) left"} · {zh ? "期限" : "deadline"} {fmtLocal(x.deadline, locale)}</li>)}</ul>}</Card>
        <Card title={`${zh ? "需要你决定" : "Needs your decision"} · ${sections.decisions.length}`}>{sections.decisions.length === 0 ? <p className="ag-note">{zh ? "没有待决事项。" : "Nothing to decide."}</p> : <ul className="ag-list">{sections.decisions.map((d, i) => <li key={`${d.refId}-${d.code}-${i}`}><div className="ag-blocker"><code>{d.code}</code><span>{d.text} <Pill tone="info">{d.action}</Pill></span></div></li>)}</ul>}</Card>
      </div>
      <Card title={zh ? "时间线" : "Timeline"}>{r.timeline.length === 0 ? <p className="ag-note">—</p> : <ol className="ag-timeline">{r.timeline.map((e, i) => <li key={i}><span className="mono text-[11px] text-fg-3">{fmtLocal(e.at, locale)}</span> · <span className="mono text-[11px]">{e.refId}</span> · {e.text}{e.amountRaw ? ` · ${rawToHuman(e.amountRaw, 6)} ${asset(e.assetKey ?? "")}` : ""}{e.txHash ? <> · <a className="underline" href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noreferrer">tx</a></> : null}</li>)}</ol>}</Card>
      <div className="ag-grid-2">
        <Card title={zh ? "个人里程碑（只按可核对的行为）" : "Personal milestones (verifiable actions only)"}>{r.milestones.length === 0 ? <p className="ag-note">{zh ? "还没有。第一次授权、第一次链上确认、第一次完成——每一条都带证据指针。没有排行榜。" : "None yet. First authorization, first on-chain confirmation, first completion — each with an evidence pointer. No leaderboard."}</p> : <div className="space-y-2">{r.milestones.map((m) => <div key={m.id} className="ag-milestone"><div><p className="font-semibold">{m.label[locale]}</p><p className="ag-note">{fmtLocal(m.at, locale)} · <span className="mono">{m.evidence.refId}</span>{m.evidence.txHash ? <> · <a className="underline" href={`${EXPLORER}/tx/${m.evidence.txHash}`} target="_blank" rel="noreferrer">tx</a></> : null}</p></div></div>)}</div>}</Card>
        <Card title={zh ? "可翻创的任务（只带结构）" : "Remixable tasks (structure only)"}>{r.remixable.length === 0 ? <p className="ag-note">—</p> : <ul className="ag-list">{r.remixable.map((x) => <li key={x.refId}><div className="ag-actions"><span className="text-sm">{x.structure.side} {x.structure.outputAssetKeys.map(asset).join("+")} · {x.structure.steps} {zh ? "步" : "step(s)"}</span><Link className="btn-ghost h-7 px-2 text-xs" href={x.remixHref}>{zh ? "翻创" : "Remix"}</Link></div><p className="ag-note">{zh ? "不复制金额、钱包、授权。" : "No amounts, wallet or authorization are copied."}</p></li>)}</ul>}</Card>
      </div>
      <Card title={zh ? "分享" : "Share"} right={<Pill tone={r.share.public ? "warn" : "ok"}>{r.share.public ? (zh ? "公开" : "public") : (zh ? "私密（默认）" : "private (default)")}</Pill>}>
        <div className="ag-actions">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={share.public} onChange={(e) => setShare({ ...share, public: e.target.checked })} />{zh ? "公开这份日志" : "Make this journal public"}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={share.hideAssets} disabled={!share.public} onChange={(e) => setShare({ ...share, hideAssets: e.target.checked })} />{zh ? "隐藏资产" : "Hide assets"}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={share.hideAmounts} disabled={!share.public} onChange={(e) => setShare({ ...share, hideAmounts: e.target.checked })} />{zh ? "隐藏金额" : "Hide amounts"}</label>
          <button className="btn-ghost" onClick={onSave}>{zh ? "保存" : "Save"}</button>
        </div>
        <p className="ag-note mt-2">{zh ? "公开视图先展示结果摘要；钱包地址永远不出现。" : "The public view shows the result summary first; the wallet address never appears."}</p>
        {shareMsg && <p className="mt-2 text-sm">{shareMsg}</p>}
        {r.share.publicUrl && <p className="mono mt-1 text-xs">{r.share.publicUrl}</p>}
      </Card>
    </>
  );
}
