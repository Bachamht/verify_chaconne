"use client";
/**
 * /start 体验（CV-D16 批次 6）：连接钱包 → 选一个复杂任务（目标式：目标 + 策略 + 范围，没有条件规则）→ 选允许的资产与模拟预算
 * → 建一个 SIMULATION 目标任务 → 由访客自己扮演 Agent 走一轮（提交加仓意图 / 先持币要证据 / 修订计划）→ 看四道核验与决策时间线
 * → 准备真实运行（同一份目标交给 /agent 的目标表单）。两步之间用 ?step=result 进历史记录，浏览器回退回到上一步。
 */
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, ArrowRight, BookOpenCheck, CalendarClock, FlaskConical, LoaderCircle, Scale, ShieldCheck, Target, CircleHelp } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { assetByKey, defaultStable, loadAssets, stablesOf, stocksOf, type AssetEntry, type AssetsLoad } from "@/lib/assets";
import { agentTasks, marketContext, type AgentTradeIntent, type CreateTaskBody } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import type { MarketEvent } from "@chaconne/core/verify";
import { WalletGate } from "@/components/WalletGate";
import { COMPLEX_TASKS, type ComplexTask } from "../agent/home/entries";
import { stashGoalDraft } from "../agent/tasks/taskDraft";
import { DecisionTimeline } from "../agent/tasks/DecisionTimeline";
import { turnReasonLabel, turnStateLabel } from "../agent/tasks/decisionTimelineLabels";
import { buildGoalRequest, isSimulationTask, liveGoalDraft, splitSimulationBudget, type SimulationTask } from "./model";
import "./onboarding.css";

const ICONS = [Activity, CalendarClock, Scale, BookOpenCheck, ShieldCheck];
const PRESETS = ["100", "500", "1000"];
const ROLE_NAME = { zh: "你（浏览器扮演）", en: "you (playing the agent)" } as const;

function Character({ busy = false }: { busy?: boolean }) {
  return <div className="start-character" data-busy={busy}><Image src="/brand/conductor-v1.jpg" alt="" width={768} height={768} sizes="180px" unoptimized draggable={false} /></div>;
}

export function Onboarding() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return <WalletGate title={zh ? "连接钱包，把一个任务交给 Agent" : "Connect a wallet to hand a task to an agent"} description={zh ? "钱包地址就是你的账户，模拟任务会记在它名下。连接不会签名、不会花钱。" : "Your wallet address is your account; the simulation is recorded under it. Connecting never signs or spends."}>{(account) => <OnboardingFlow account={account} />}</WalletGate>;
}

function OnboardingFlow({ account }: { account: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const sp = useSearchParams();
  const stage: "setup" | "result" = sp.get("step") === "result" ? "result" : "setup";
  const [assets, setAssets] = useState<AssetsLoad>({ assets: [], source: "none", evidenceMode: null });
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [taskIndex, setTaskIndex] = useState(0);
  const [assetKeys, setAssetKeys] = useState<string[] | null>(null);
  const [stableKey, setStableKey] = useState("");
  const [budget, setBudget] = useState(PRESETS[0]!);
  const [result, setResult] = useState<{ view: SimulationTask; request: CreateTaskBody; task: ComplexTask; totalHuman: string } | null>(null);
  const [intents, setIntents] = useState<AgentTradeIntent[]>([]);
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<"intent" | "hold" | "revise" | null>(null);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [claim, setClaim] = useState("");
  const [intentAsset, setIntentAsset] = useState("");
  const [holdNote, setHoldNote] = useState("");
  const [planText, setPlanText] = useState("");
  /** 三张决定卡的就地反馈（此前结果只出现在下方时间线 / 页底错误框，看起来像「没反应」） */
  const [outcome, setOutcome] = useState<{ kind: "intent" | "hold" | "revise"; ok: boolean; text: string } | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const requestLock = useRef(false);
  const requestIdentity = useRef<{ fingerprint: string; id: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const task = COMPLEX_TASKS[taskIndex]!;
  const stocks = stocksOf(assets.assets).filter((s) => s.executionAllowed);
  const stables = stablesOf(assets.assets);
  const chosen = (assetKeys ?? stocks.slice(0, task.assets).map((s) => s.assetKey)).map((k) => assetByKey(stocks, k)).filter((s): s is AssetEntry => !!s);
  const stable = assetByKey(stables, stableKey) ?? defaultStable(assets.assets);
  const amount = stable ? splitSimulationBudget(budget, stable.tokenDecimals, task.steps) : null;
  const amountError = stable && !amount ? (zh ? "请输入有效的总预算：金额须足够分到每一笔，且不超过资金币种的小数精度。" : "Enter a positive total budget large enough for each tranche, within the funding token's decimal precision.") : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reloadAssets = useCallback(async (force = false) => {
    setLoadingAssets(true);
    const value = await loadAssets({ force });
    if (mounted.current) { setAssets(value); setLoadingAssets(false); }
  }, []);
  useEffect(() => { void reloadAssets(); }, [reloadAssets]);
  useEffect(() => { if (stage === "result" && !result) router.replace("/start"); }, [stage, result, router]);
  useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [busy]);
  useEffect(() => { if (stage === "result") heading.current?.focus({ preventScroll: false }); }, [stage]);

  const refresh = useCallback(async (id: string) => {
    const [v, li, ctx] = await Promise.all([agentTasks.get(id, account), agentTasks.intents(id, account), marketContext.get({ tier: "agent", taskId: id })]);
    if (!mounted.current) return;
    if (v.status === 200 && isSimulationTask(v.data)) setResult((cur) => (cur && cur.view.task.id === id ? { ...cur, view: v.data } : cur));
    if (li.status === 200) setIntents(li.data.intents);
    if (ctx.status === 200 && Array.isArray(ctx.data.events)) setEvents(ctx.data.events as MarketEvent[]);
  }, [account]);

  async function simulate() {
    if (requestLock.current || !stable || !amount || chosen.length === 0) return;
    const draft = buildGoalRequest(task, chosen, stable, budget, account, "", locale);
    if (!draft) return;
    const fingerprint = JSON.stringify({ ...draft, scope: { ...draft.scope, deadline: undefined } });
    if (requestIdentity.current?.fingerprint !== fingerprint) requestIdentity.current = { fingerprint, id: "web-start-" + crypto.randomUUID() };
    const request = { ...draft, clientRequestId: requestIdentity.current.id };
    requestLock.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await agentTasks.create(request);
      if (response.status !== 200 && response.status !== 201) { if (mounted.current) setError(apiError(response, locale)); return; }
      if (!isSimulationTask(response.data)) { if (mounted.current) setError(zh ? "服务返回的任务没有标明是模拟，这里已停止，没有创建任何真实任务。可以重试。" : "The service did not label the returned task as a simulation, so this page stopped here and no live task was created. Retry."); return; }
      requestIdentity.current = null;
      const id = response.data.task.id;
      // 访客扮演 agent：先「接管」，页面就能显示谁在处理
      await agentTasks.agentStatus(id, { status: "accepted", note: zh ? "我在这个页面上扮演 Agent 走一轮。" : "I am playing the agent on this page for one round.", agent: { name: ROLE_NAME[locale] }, plan: { text: task.strategy[locale].slice(0, 200) } }).catch(() => null);
      if (mounted.current) {
        setResult({ view: response.data, request, task, totalHuman: budget });
        setIntents([]);
        setRationale(task.sampleIntent.rationale[locale]);
        setClaim(task.sampleIntent.claim[locale]);
        setIntentAsset(chosen[0]!.assetKey);
        setHoldNote(zh ? "还没拿到实际数据，先持币；想看：下一次发布的实际值与预期。" : "No actual data yet; keep cash. I want the next release's actual value versus expectations.");
        setPlanText(zh ? "先只买一笔试探，其余预算等下一份数据再分配。" : "Take one probing tranche only; allocate the rest after the next release.");
        router.push("/start?step=result");
        void refresh(id);
      }
    } catch {
      if (mounted.current) setError(zh ? "暂时无法取得模拟结果。可以重试，同一份计划会复用请求编号。" : "The simulation could not be loaded. Retry safely with the same request identifier.");
    } finally {
      requestLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function act(kind: "intent" | "hold" | "revise") {
    if (!result || acting || !stable) return;
    setActing(kind);
    setError(null);
    setOutcome(null);
    const id = result.view.task.id;
    const fail = (text: string) => { setOutcome({ kind, ok: false, text }); };
    try {
      if (kind === "intent") {
        const r = await agentTasks.submitIntent(id, { clientRequestId: "web-start-" + crypto.randomUUID(), outputAssetKey: intentAsset || result.task.id, amountInRaw: String(result.request.scope?.perStepCapRaw ?? "0"), decision: { rationale: rationale.trim() || result.task.sampleIntent.rationale[locale], claims: claim.trim() ? [{ kind: result.task.trustTier === "platform_only" ? "platform_fact" : result.task.trustTier === "agent_research" ? "agent_research" : "agent_data", text: claim.trim(), ...(result.task.trustTier === "platform_only" ? { source: { evidenceId: "unknown" } } : { source: { name: zh ? "扮演 agent 的访客" : "visitor playing the agent" } }) }] : [], alternatives: [zh ? "再等一轮" : "wait one more round"] } });
        if (r.status !== 201 && r.status !== 200 && r.status !== 422) { fail(apiError(r, locale)); return; }
        const verdict = (r.data as { intent?: { status?: string } } | null)?.intent?.status;
        setOutcome({ kind, ok: true, text: verdict === "rejected" ? (zh ? "意图已提交，四道核验没通过——原因在下方时间线。" : "Intent submitted; it failed the four checks. See the timeline below.") : (zh ? "意图已提交并核验，结果在下方时间线。" : "Intent submitted and verified. See the timeline below.") });
      } else if (kind === "hold") {
        const r = await agentTasks.agentStatus(id, { status: "needs_evidence", note: holdNote.trim() || "hold", requestedEvidence: [zh ? "下一次发布的实际值 vs 预期" : "next release: actual vs expected"], agent: { name: ROLE_NAME[locale] } });
        if (r.status !== 200) { fail(apiError(r, locale)); return; }
        setOutcome({ kind, ok: true, text: zh ? "已记录：持币、等更多证据。时间线里多了一条。" : "Recorded: holding cash, asking for evidence. It is now on the timeline." });
      } else {
        const r = await agentTasks.agentStatus(id, { status: "plan_revised", note: zh ? "按新信息调整计划" : "plan adjusted on new information", plan: { text: planText.trim() || "revised" }, agent: { name: ROLE_NAME[locale] } });
        if (r.status !== 200) { fail(apiError(r, locale)); return; }
        setOutcome({ kind, ok: true, text: zh ? "修订已提交，成为当前计划的新版本。时间线里多了一条。" : "Revision submitted as the new current plan. It is now on the timeline." });
      }
      await refresh(id);
      timelineRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {
      if (mounted.current) fail(zh ? "这一步没有提交成功，可以重试。" : "That action did not go through; retry.");
    } finally {
      if (mounted.current) setActing(null);
    }
  }
  function prepareLive() {
    if (!result || !stable) return;
    const draft = liveGoalDraft(result.request, result.task, stable, result.totalHuman);
    if (!draft || !stashGoalDraft(draft)) { setError(zh ? "浏览器无法暂存这份草稿。可以打开完整表单手动填写。" : "This browser could not retain the draft. Open the full form and fill it in."); return; }
    router.push("/agent");
  }

  const current = stage === "result" ? result : null;
  const cTask = current?.task ?? task;
  const cStable = current ? assetByKey(stables, String(current.request.scope?.inputAssetKey)) ?? stable : stable;
  const cAssets = current ? (current.request.scope?.outputAssetKeys ?? []).map((k) => assetByKey(stocks, k)).filter((s): s is AssetEntry => !!s) : chosen;
  const cTotal = current ? String(current.request.scope?.budgetCapRaw) : amount?.totalRaw ?? null;
  const cPer = current ? String(current.request.scope?.perStepCapRaw) : amount?.perStepRaw ?? null;
  const formatMoney = (raw: string | null) => {
    if (!cStable || raw === null) return "—";
    const n = Number(raw) / 10 ** cStable.tokenDecimals;
    if (!Number.isFinite(n)) return formatAmount(raw, cStable.tokenDecimals, cStable.displaySymbol);
    return `${(Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${cStable.displaySymbol}`;
  };
  const turn = current?.view.agentTurn ?? null;
  const nowMs = Date.now();
  const watched = events.filter((e) => cTask.watch.includes(e.kind)).map((e) => ({ e, at: Date.parse(e.scheduledAtUtc ?? `${e.dateLocal}T13:30:00.000Z`) })).filter(({ at }) => at >= nowMs - 6 * 3600_000 && at <= nowMs + 48 * 3600_000).sort((a, b) => a.at - b.at).slice(0, 5);
  const summary = <aside className="start-summary">
    <div className="start-summary-head"><span className="start-overline">YOUR AGENT&apos;S BRIEF</span><h2>{cTask.title[locale]}</h2></div>
    <div className="start-summary-body">
      <p>{cTask.objective[locale]}</p>
      <div className="start-values"><div><span>{zh ? "总额（签名）" : "Total (signed)"}</span><strong>{formatMoney(cTotal)}</strong></div><div><span>{zh ? "每笔上限（签名）" : "Per-step cap (signed)"}</span><strong>{formatMoney(cPer)}</strong></div></div>
      <p className="start-muted">{zh ? `允许买入：${cAssets.map((s) => s.displaySymbol).join(" / ") || "—"} · 最多 ${cTask.steps} 笔 · ${cTask.days} 天 · 信任档位：${cTask.trustTier === "platform_only" ? "只信平台核验的事实" : cTask.trustTier === "agent_data" ? "接受 agent 带来源的数据" : "接受 agent 的研究结论"}${cTask.regularSessionOnly ? " · 硬约束：只在美股常规时段" : ""}` : `Allowed: ${cAssets.map((s) => s.displaySymbol).join(" / ") || "—"} · up to ${cTask.steps} tranches · ${cTask.days} days · trust: ${cTask.trustTier}${cTask.regularSessionOnly ? " · hard: US regular hours only" : ""}`}</p>
      <p className="start-muted">{zh ? "叫醒 agent 的事件：" : "Wakes the agent on: "}{cTask.watch.join(", ")}</p>
      <details className="start-conditions"><summary>{zh ? "查看完整策略（交给 Agent 理解与运用，可改）" : "See the full strategy (for the agent; editable)"}</summary><p className="start-muted" style={{ whiteSpace: "pre-wrap" }}>{cTask.strategy[locale]}</p></details>
      {stage === "setup" && <button type="submit" form="start-plan-form" className="start-primary" disabled={busy || loadingAssets || chosen.length === 0 || !stable || !amount}>{busy ? <LoaderCircle className="start-spin" size={17} aria-hidden /> : <FlaskConical size={17} aria-hidden />}{busy ? (zh ? "正在建模拟任务" : "Creating the simulation") : (zh ? "建模拟任务，我来扮演 Agent" : "Create a simulation and play the agent")}<ArrowRight size={16} aria-hidden /></button>}
    </div>
  </aside>;

  return <div className="start-page">
    {(current ? current.view.evidenceMode === "FIXTURE" : assets.evidenceMode === "FIXTURE") && <p className="start-registry-note" role="status">{zh ? "测试数据模式：当前服务返回的是预设数据，不代表实时市场。" : "Fixture data: the service is returning test data, not live market evidence."}</p>}
    <div className="start-topline"><Link href={stage === "setup" ? "/" : "/start"} onClick={stage !== "setup" ? (event) => { event.preventDefault(); setError(null); router.back(); } : undefined} className="start-back"><ArrowLeft size={14} aria-hidden />{stage === "setup" ? (zh ? "首页" : "Home") : (zh ? "换一个任务" : "Change task")}</Link><ol className="start-progress" aria-label={zh ? "步骤" : "Steps"}>{["setup", "result"].map((step, i) => <li key={step} aria-current={stage === step ? "step" : undefined}><span>0{i + 1}</span>{(zh ? ["选任务", "扮演 Agent"] : ["Choose", "Play the agent"])[i]}</li>)}</ol></div>
    {stage === "setup" && <>
      <header className="start-heading"><span className="start-overline">YOUR FIRST AGENT TASK</span><h1 ref={heading} tabIndex={-1}>{zh ? "把一个任务交给你的 Agent。" : "Hand a task to your agent."}</h1><p>{zh ? "任务 = 目标 + 策略 + 你签的范围，没有条件规则。Agent 用 Chaconne 的事件日历、上下文、报价与组合数据自己决定何时买、买哪只、买多少；每一笔经四道核验才签证书。建好后先由你扮演一轮 Agent，看核验怎么反应。" : "A task is an objective, a strategy and a scope you sign; there are no rules. The agent uses Chaconne's calendar, context, quotes and portfolio data to decide when, which name and how much; every tranche passes four checks before a certificate is signed. After creating one, play the agent for a round and watch the checks respond."}</p></header>
      <div className="start-grid">
        <form id="start-plan-form" onSubmit={(event) => { event.preventDefault(); void simulate(); }}>
          <fieldset disabled={busy} className="start-fields"><legend className="start-label">{zh ? "交给 Agent 什么任务？" : "Which task?"}</legend><div className="start-templates">{COMPLEX_TASKS.map((option, i) => { const Icon = ICONS[i] ?? Target; return <button key={option.id} type="button" className="start-template" aria-pressed={taskIndex === i} onClick={() => { setTaskIndex(i); setAssetKeys(null); setError(null); }}><Icon size={22} aria-hidden /><span><strong>{option.title[locale]}</strong><small>{option.space[locale]}</small></span><span className="start-radio" aria-hidden /></button>; })}</div>
            <div className="start-field"><span className="start-label">{zh ? `允许 Agent 买入的股票（建议 ${task.assets} 只）` : `Stocks the agent may buy (suggested: ${task.assets})`}</span>{loadingAssets && <p className="start-muted" role="status">{zh ? "正在读取支持的资产…" : "Loading supported assets…"}</p>}
              <div className="start-assets" role="group" aria-label={zh ? "允许买入的股票" : "Allowed stocks"}>{stocks.map((asset) => { const on = chosen.some((c) => c.assetKey === asset.assetKey); return <button type="button" key={asset.assetKey} aria-pressed={on} title={asset.underlyingId} onClick={() => { const cur = chosen.map((c) => c.assetKey); setAssetKeys(on ? cur.filter((k) => k !== asset.assetKey) : [...cur, asset.assetKey]); setError(null); }}>{asset.displaySymbol}</button>; })}</div>
              <p className="start-assets-count">{zh ? `已选 ${chosen.length} 只：${chosen.map((c) => c.displaySymbol).join("、") || "—"}` : `${chosen.length} selected: ${chosen.map((c) => c.displaySymbol).join(", ") || "—"}`}</p>
              {!loadingAssets && (assets.source !== "live" || stocks.length === 0 || stables.length === 0) && <div className="start-registry-note" role="status"><p>{assets.source === "cache" ? (zh ? "目前显示上次缓存的资产列表，建任务时仍由服务重新核对。" : "Showing the cached asset list; the service revalidates it.") : (zh ? "暂时无法取得可用资产。恢复后即可继续。" : "Supported assets are currently unavailable. Retry.")}</p><button type="button" className="start-link-button" onClick={() => void reloadAssets(true)}>{zh ? "重试资产列表" : "Retry assets"}</button></div>}
            </div>
            <div className="start-field"><label className="start-label" htmlFor="start-budget">{zh ? "模拟总预算（会分成每笔上限）" : "Total simulation budget (split into per-step caps)"}</label><div className="start-budget"><input id="start-budget" inputMode="decimal" autoComplete="off" maxLength={48} value={budget} onChange={(event) => { setBudget(event.target.value); setError(null); }} aria-invalid={!!amountError} aria-describedby={amountError ? "start-budget-error" : undefined} /><select aria-label={zh ? "资金币种" : "Funding token"} value={stable?.assetKey ?? ""} onChange={(event) => { setStableKey(event.target.value); setError(null); }} disabled={loadingAssets || stables.length === 0}>{stables.length === 0 && <option value="">—</option>}{stables.map((asset) => <option key={asset.assetKey} value={asset.assetKey}>{asset.displaySymbol}</option>)}</select></div><div className="start-presets">{PRESETS.map((value) => <button type="button" key={value} onClick={() => { setBudget(value); setError(null); }}>{value}</button>)}</div>{amountError && <p id="start-budget-error" className="start-error" role="alert">{amountError}</p>}</div>
          </fieldset>
          <p className="start-workspace-link"><CircleHelp size={14} aria-hidden />{zh ? "想自己写目标和策略？" : "Want to write your own objective and strategy?"} <Link href="/agent">{zh ? "打开完整工作区" : "Open the workspace"}</Link></p>
        </form>{summary}
      </div>
      {busy && <div className="start-loading" role="status" aria-live="polite"><Character busy /><div><h2>{zh ? "正在把任务交给 Agent。" : "Handing the task to the agent."}</h2><p>{slow ? (zh ? "服务仍在处理，请稍候。" : "The service is still processing.") : (zh ? "正在建立模拟任务、写入范围与策略。" : "Creating the simulation with its scope and strategy.")}</p></div></div>}
    </>}
    {current && stage === "result" && <>
      <div className="start-result-banner" data-decision={turn ? "ready" : "unknown"}>
        <div><h1 ref={heading} tabIndex={-1} className="start-result-title"><FlaskConical size={22} aria-hidden />{zh ? "模拟任务已建 · 现在你来当 Agent" : "Simulation created · now you play the agent"}</h1><p className="start-result-sub">{turn ? `${turnStateLabel(turn.state, locale)} · ${turnReasonLabel(turn.reason, locale)}` : (zh ? "等待第一轮…" : "Waiting for the first turn…")}</p></div><Character />
      </div>
      <div className="start-grid start-result-grid"><div>
        <h2 className="start-section-title">{zh ? "Agent 被叫醒时看到的" : "What the agent sees when woken"}</h2>
        <ul className="start-reasons">
          <li><Target size={18} aria-hidden /><div><strong>{zh ? "这一轮" : "This turn"}</strong><p>{turn?.summary ?? "—"}</p></div></li>
          <li><CalendarClock size={18} aria-hidden /><div><strong>{zh ? "未来 48 小时关注的事件" : "Watched events in the next 48 hours"}</strong><p>{watched.length ? watched.map(({ e, at }) => `${e.name} (${e.kind}) ${at <= nowMs ? (zh ? "预定时间已到，实际值要自己核实" : "scheduled time passed; verify the actual value yourself") : formatTime(new Date(at).toISOString(), locale)}`).join("；") : (zh ? "窗口内没有关注的事件；到点或改期时会再叫。" : "No watched event in the window; it will be woken when one arrives or is rescheduled.")}</p></div></li>
          <li><ShieldCheck size={18} aria-hidden /><div><strong>{zh ? "签过的范围" : "Signed scope"}</strong><p>{zh ? `允许 ${cAssets.map((s) => s.displaySymbol).join(" / ")}，总额 ${formatMoney(cTotal)}，每笔 ≤ ${formatMoney(cPer)}，最多 ${cTask.steps} 笔。超出这些的意图会被拒。` : `Allowed ${cAssets.map((s) => s.displaySymbol).join(" / ")}, total ${formatMoney(cTotal)}, ≤ ${formatMoney(cPer)} per tranche, up to ${cTask.steps} tranches. Intents outside this are rejected.`}</p></div></li>
        </ul>
        <h2 className="start-section-title">{zh ? "你的决定（三种都是正常结果，提交后看下方时间线）" : "Your decision (all three are normal outcomes; the timeline below records each one)"}</h2>
        <div className="start-play">
          <div className="start-play-card">
            <strong>{zh ? "提交一笔加仓意图" : "Submit an add intent"}</strong>
            <label>{zh ? "买哪只" : "Which name"}<select value={intentAsset} onChange={(e) => setIntentAsset(e.target.value)}>{cAssets.map((s) => <option key={s.assetKey} value={s.assetKey}>{s.displaySymbol}</option>)}</select></label>
            <label>{zh ? "为什么现在买（决策记录）" : "Why now (decision record)"}<textarea rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} /></label>
            <label>{zh ? "依据（按信任档位分拣）" : "Basis (triaged by trust tier)"}<input value={claim} onChange={(e) => setClaim(e.target.value)} /></label>
            <button type="button" className="start-play-submit" disabled={!!acting} onClick={() => void act("intent")}>{acting === "intent" ? (zh ? "核验中…" : "Verifying…") : (zh ? `提交 ${formatMoney(cPer)} 的意图` : `Submit a ${formatMoney(cPer)} intent`)}</button>
            {outcome?.kind === "intent" && <p className={`start-play-outcome${outcome.ok ? "" : " is-bad"}`} role="status">{outcome.text}</p>}
          </div>
          <div className="start-play-card">
            <strong>{zh ? "先持币，要更多证据" : "Keep cash, ask for evidence"}</strong>
            <label>{zh ? "为什么不买" : "Why not"}<textarea rows={2} value={holdNote} onChange={(e) => setHoldNote(e.target.value)} /></label>
            <button type="button" className="start-play-submit" disabled={!!acting} onClick={() => void act("hold")}>{acting === "hold" ? (zh ? "记录中…" : "Recording…") : (zh ? "记录这个决定" : "Record this decision")}</button>
            {outcome?.kind === "hold" && <p className={`start-play-outcome${outcome.ok ? "" : " is-bad"}`} role="status">{outcome.text}</p>}
          </div>
          <div className="start-play-card">
            <strong>{zh ? "修订计划" : "Revise the plan"}</strong>
            <label>{zh ? "新的计划（人话）" : "New plan (plain words)"}<textarea rows={2} value={planText} onChange={(e) => setPlanText(e.target.value)} /></label>
            <button type="button" className="start-play-submit" disabled={!!acting} onClick={() => void act("revise")}>{acting === "revise" ? (zh ? "提交中…" : "Submitting…") : (zh ? "提交修订" : "Submit the revision")}</button>
            {outcome?.kind === "revise" && <p className={`start-play-outcome${outcome.ok ? "" : " is-bad"}`} role="status">{outcome.text}</p>}
          </div>
        </div>
        <div className="start-timeline" ref={timelineRef}><DecisionTimeline turn={turn} intents={intents} timeline={current.view.timeline} assets={assets.assets} stable={cStable} trustTier={cTask.trustTier} issuance="agent" /></div>
        <p className="start-muted start-evaluated">{zh ? "模拟任务不签证书、不执行；真实任务里同样的意图会拿到步骤证书，由你的 Agent 或钱包发交易。" : "A simulation signs nothing and executes nothing; in a live task the same intent gets a step certificate that your agent or wallet executes."} · <button type="button" className="start-link-button" onClick={() => void refresh(current.view.task.id)}>{zh ? "刷新" : "Refresh"}</button></p>
      </div>{summary}</div>
      <div className="start-actions"><button className="start-primary" type="button" onClick={prepareLive}>{zh ? "准备真实运行（同一份目标）" : "Prepare to run for real (same goal)"}<ArrowRight size={16} aria-hidden /></button><Link className="start-link-button" href={`/agent/tasks/${current.view.task.id}`}>{zh ? "打开任务详情" : "Open the task"}</Link><button type="button" className="start-link-button" onClick={() => { setError(null); router.back(); }}>{zh ? "换一个任务" : "Change task"}</button></div>
    </>}
    {error && <div className="start-error-panel" role="alert"><p>{error}</p></div>}
  </div>;
}
