"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, AudioLines, CalendarClock, Check, CircleHelp, Clock3, ExternalLink, FlaskConical, LoaderCircle, ScanEye, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { assetByKey, defaultStable, loadAssets, stablesOf, stocksOf, type AssetsLoad } from "@/lib/assets";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import { conditionText } from "@/lib/conditions";
import { remember } from "@/lib/history";
import { useAccount } from "@/lib/useAccount";
import { Json } from "@/components/ui";
import { SAMPLES } from "../agent/home/entries";
import { DRAFT_KEY, stashDraft } from "../agent/tasks/taskDraft";
import { blockerSentence, statusLabel } from "../agent/tasks/taskTitle";
import { RecentAgentTasks } from "../agent/tasks/RecentAgentTasks";
import { buildSimulationRequest, isOnboardingSnapshot, isSimulationTask, liveDraftFromSimulation, simulationDecision, splitSimulationBudget, type OnboardingResult } from "./model";
import { createOnboardingSimulation, getOnboardingSimulation, readOnboardingSnapshot, saveOnboardingSnapshot } from "./session";
import "./onboarding.css";

type Stage = "setup" | "result" | "prepare";
const ICONS = [AudioLines, CalendarClock, ScanEye];

function Character({ busy = false }: { busy?: boolean }) {
  return <div className="start-character" data-busy={busy}><Image src="/brand/conductor-v1.jpg" alt="" width={768} height={768} sizes="180px" unoptimized draggable={false} /></div>;
}

export function Onboarding() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const taskToRestore = useSearchParams().get("task");
  const account = useAccount();
  const [assets, setAssets] = useState<AssetsLoad>({ assets: [], source: "none", evidenceMode: null });
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [stockKey, setStockKey] = useState("");
  const [stableKey, setStableKey] = useState("");
  const [budget, setBudget] = useState("30");
  const [stage, setStage] = useState<Stage>("setup");
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestLock = useRef(false);
  const requestIdentity = useRef<{ fingerprint: string; id: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sample = SAMPLES[sampleIndex]!;
  const stocks = stocksOf(assets.assets);
  const stables = stablesOf(assets.assets);
  const stock = assetByKey(stocks, stockKey) ?? stocks.find((s) => s.displaySymbol === "AAPLx") ?? stocks[0] ?? null;
  const stable = assetByKey(stables, stableKey) ?? defaultStable(assets.assets);
  const amount = stable ? splitSimulationBudget(budget, stable.tokenDecimals, sample.steps) : null;
  const amountError = stable && !amount ? (zh ? "请输入有效的总预算，金额须足够分配到每次买入，且不超过资金币种的小数精度。" : "Enter a positive total budget large enough for each step, within the funding token's decimal precision.") : null;
  const templateNames = zh ? ["分三次买入", "避开重要事件", "观察价格条件"] : ["Buy in three steps", "Avoid major events", "Watch a price condition"];
  const templateDescriptions = zh
    ? ["每步至少隔一个交易日，错过就顺延。", "避开重要数据和财报窗口，再检查买入。", "链上价不高于实时参考价的 0.3% 溢价。"]
    : ["At least one trading day apart; missed windows are deferred.", "Wait around macro releases and earnings, then re-check.", "Wait for an on-chain premium of at most 0.3% vs. the live reference."];

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const reloadAssets = useCallback(async (force = false) => {
    setLoadingAssets(true);
    const value = await loadAssets({ force });
    if (mounted.current) { setAssets(value); setLoadingAssets(false); }
  }, []);
  useEffect(() => { void reloadAssets(); }, [reloadAssets]);
  useEffect(() => {
    if (!taskToRestore) return;
    const saved = readOnboardingSnapshot(taskToRestore);
    if (!isOnboardingSnapshot(saved) || saved.view.task.id !== taskToRestore || !SAMPLES.some((s) => s.playbookId === saved.sample.playbookId)) {
      setError(zh ? "这台设备上没有可恢复的模拟快照，可以重新运行计划。" : "No saved simulation is available on this device. Run a new plan.");
      return;
    }
    const restored = saved;
    setSampleIndex(SAMPLES.findIndex((s) => s.playbookId === restored.sample.playbookId));
    setStockKey(restored.stock.assetKey);
    setStableKey(restored.stable.assetKey);
    const restoredTotal = BigInt(String(restored.request.params["perStepAmountRaw"] ?? restored.request.params["amountRaw"])) * BigInt(restored.sample.steps);
    setBudget(formatAmount(restoredTotal, restored.stable.tokenDecimals, undefined, restored.stable.tokenDecimals));
    setResult(restored);
    setStage("result");
    setError(null);
    let active = true;
    void getOnboardingSimulation(restored.view.task.id, restored.request.ownerAddress).then((response) => {
      if (!active) return;
      if (response.status === 200 && isSimulationTask(response.data) && response.data.task.id === restored.view.task.id) {
        const updated = { ...restored, view: response.data };
        setResult(updated);
        saveOnboardingSnapshot(restored.view.task.id, updated);
      } else setError(zh ? "暂时无法更新，下面显示本机保存的结果，请留意状态更新时间。" : "Could not refresh. Showing the saved result; check its timestamp.");
    }).catch(() => { if (active) setError(zh ? "暂时无法更新，正在显示本机保存的结果。" : "Could not refresh; showing the saved result."); });
    return () => { active = false; };
  }, [taskToRestore, zh]);
  useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [busy]);
  useEffect(() => { if (stage !== "setup") heading.current?.focus({ preventScroll: false }); }, [stage]);

  function move(next: Stage) {
    setError(null); setStage(next);
    if (next === "setup" && taskToRestore) router.replace("/start", { scroll: false });
  }
  async function simulate() {
    if (requestLock.current || !stock || !stable || !amount) return;
    const draft = buildSimulationRequest(sample, stock, stable, budget, account, "");
    if (!draft) return;
    const fingerprint = JSON.stringify(draft);
    if (requestIdentity.current?.fingerprint !== fingerprint) requestIdentity.current = { fingerprint, id: "web-start-" + crypto.randomUUID() };
    const request = { ...draft, clientRequestId: requestIdentity.current.id };
    requestLock.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await createOnboardingSimulation(request);
      if (response.status !== 200 && response.status !== 201) {
        if (mounted.current) setError(apiError(response, locale));
        return;
      }
      if (!isSimulationTask(response.data)) {
        if (mounted.current) setError(zh ? "服务返回的任务没有标明是模拟，这里已停止后续操作，没有创建任何真实任务。可以重试，或打开完整工作区核对。" : "The service did not label the returned task as a simulation, so this page stopped here and no live task was created. Retry, or check in the full workspace.");
        return;
      }
      requestIdentity.current = null;
      const nextResult = { view: response.data, request, stock, stable, sample };
      const saved = saveOnboardingSnapshot(response.data.task.id, nextResult);
      if (saved) remember({ kind: "agent_task", id: response.data.task.id, title: sample.title[locale] + " · " + stock.displaySymbol + " · " + (zh ? "模拟" : "Simulation"), owner: request.ownerAddress, isolatedSimulation: true });
      if (mounted.current) {
        setResult(nextResult);
        setStage("result");
        if (!saved) setError(zh ? "模拟已完成，但浏览器无法保存本机记录。离开页面前请保留需要的结果。" : "Simulation complete, but local storage is unavailable. Keep any needed results before leaving.");
      }
    } catch {
      if (mounted.current) setError(zh ? "暂时无法取得模拟结果。可以重试，同一份计划会复用请求编号。" : "The simulation could not be loaded. Retry safely with the same request identifier.");
    } finally {
      requestLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function refreshResult() {
    if (!result || refreshing) return;
    setRefreshing(true); setError(null);
    try {
      const response = await getOnboardingSimulation(result.view.task.id, result.request.ownerAddress);
      if (!mounted.current) return;
      if (response.status !== 200) { setError(apiError(response, locale)); return; }
      if (!isSimulationTask(response.data)) { setError(zh ? "这次更新没有标明任务是模拟，为安全起见未覆盖页面上的结果；可以稍后再试。" : "This update did not label the task as a simulation, so the result on this page was left unchanged. Try again later."); return; }
      const updated = { ...result, view: response.data };
      saveOnboardingSnapshot(result.view.task.id, updated);
      setResult((current) => current && current.view.task.id === response.data.task.id ? updated : current);
    } catch {
      if (mounted.current) setError(zh ? "暂时无法更新任务状态，请稍后重试。" : "Task status could not be refreshed. Please retry.");
    } finally { if (mounted.current) setRefreshing(false); }
  }
  function continueToLive() {
    if (!result) return;
    const draft = liveDraftFromSimulation(result.request);
    stashDraft(draft);
    try {
      if (sessionStorage.getItem(DRAFT_KEY) !== JSON.stringify(draft)) throw new Error("draft not saved");
      router.push("/agent?entry=buy&draft=1");
    } catch {
      setError(zh ? "浏览器无法暂存这份草稿。可以打开完整工作区，按下方方案手动填写。" : "This browser could not retain the draft. Open the full workspace and enter the plan below.");
    }
  }

  const current = result && stage !== "setup" ? result : null;
  const currentSample = current?.sample ?? sample;
  const currentStock = current?.stock ?? stock;
  const currentStable = current?.stable ?? stable;
  const currentAmount = current
    ? String(current.request.params["perStepAmountRaw"] ?? current.request.params["amountRaw"])
    : amount?.perStepRaw ?? null;
  const currentTotal = currentAmount && currentStable ? (BigInt(currentAmount) * BigInt(currentSample.steps)).toString() : null;
  const formatMoney = (raw: string | null) => currentStable ? formatAmount(raw, currentStable.tokenDecimals, currentStable.displaySymbol) : "—";
  const summary = <aside className="start-summary">
    <div className="start-summary-head"><span className="start-overline">YOUR AGENT&apos;S PLAN</span><h2>{currentStock?.displaySymbol ?? (zh ? "等待资产列表" : "Loading assets")} · {currentSample.title[locale]}</h2></div>
    <div className="start-summary-body">
      <div className="start-values"><div><span>{zh ? "计划总上限" : "Total plan cap"}</span><strong>{formatMoney(currentTotal)}</strong></div><div><span>{zh ? "每次上限" : "Per-step cap"}</span><strong>{formatMoney(currentAmount)}</strong></div></div>
      <p>{zh ? "分 " + currentSample.steps + " 次买入；每次执行前都要满足计划条件。" : currentSample.steps + " planned steps; each step must meet the conditions before execution."}</p>
      {!current && amount?.remainderRaw !== "0" && amount && <p className="start-muted">{zh ? "分配按币种最小单位向下取整，合计不会超过你输入的总预算。" : "Allocation rounds down to token base units; the total never exceeds your input."}</p>}
      <details className="start-conditions"><summary>{zh ? "查看完整条件" : "See all conditions"}</summary><ul>{(current?.view.task.conditions.items ?? currentSample.conditions).map((condition, i) => <li key={i}>{condition.type === "premium_bps_lte" && condition.referenceKind === "live"
        ? (zh ? "链上价相对实时参考价的溢价不超过 " + condition.value / 100 + "%" : "On-chain premium vs. the live reference at most " + condition.value / 100 + "%")
        : conditionText(condition, locale)}</li>)}</ul></details>
      {stage === "setup" && <><button type="submit" form="start-plan-form" className="start-primary" disabled={busy || loadingAssets || !stock || !stable || !amount}>{busy ? <LoaderCircle className="start-spin" size={17} aria-hidden /> : <FlaskConical size={17} aria-hidden />}{busy ? (zh ? "正在模拟" : "Simulating") : (zh ? "运行一次免费模拟" : "Run a free simulation")}<ArrowRight size={16} aria-hidden /></button><p className="start-fine">{zh ? "使用现有任务服务和规则，不签名、不签发交易证书、不执行交易。" : "Uses the existing task service and rules. No signatures, transaction certificates or trades."}</p></>}
      {stage !== "setup" && <p className="start-quote">{zh ? "“休止符，也是计划的一部分。”" : "“A rest is part of the score.”"}</p>}
    </div>
  </aside>;

  return <div className="start-page">
    {(result && stage !== "setup" ? result.view.evidenceMode === "FIXTURE" : assets.evidenceMode === "FIXTURE") && <p className="start-registry-note" role="status">{zh ? "测试数据模式：当前服务返回的是预设数据，不代表实时市场。" : "Fixture data: the service is returning test data, not live market evidence."}</p>}
    <div className="start-topline"><Link href={stage === "setup" ? "/" : "/start"} onClick={stage !== "setup" ? (event) => { event.preventDefault(); move("setup"); } : undefined} className="start-back"><ArrowLeft size={14} aria-hidden />{stage === "setup" ? (zh ? "首页" : "Home") : (zh ? "调整计划" : "Edit plan")}</Link><ol className="start-progress" aria-label={zh ? "体验进度" : "Experience progress"}>{["setup", "result", "prepare"].map((step, i) => <li key={step} aria-current={stage === step ? "step" : undefined}><span>0{i + 1}</span>{(zh ? ["选计划", "看结果", "准备真实运行"] : ["Choose", "Review", "Prepare to run"])[i]}</li>)}</ol></div>
    {stage === "setup" && <>
      <header className="start-heading"><span className="start-overline">YOUR FIRST AGENT TASK</span><h1 ref={heading} tabIndex={-1}>{zh ? "先给 Agent，定个交易节奏。" : "Give your agent a trading plan."}</h1><p>{zh ? "不需要自备 Agent 或连接钱包。选资产、设预算，先看看计划现在会行动还是等待。" : "No agent setup or wallet connection needed. Choose an asset and budget, then see whether your plan would act or wait."}</p></header>
      <div className="start-grid">
        <form id="start-plan-form" onSubmit={(event) => { event.preventDefault(); void simulate(); }}>
          <fieldset disabled={busy} className="start-fields"><legend className="start-label">{zh ? "你想怎么安排？" : "How would you like to buy?"}</legend><div className="start-templates">{SAMPLES.map((option, i) => { const Icon = ICONS[i]!; return <button key={option.playbookId} type="button" className="start-template" aria-pressed={sampleIndex === i} onClick={() => { setSampleIndex(i); setError(null); }}><Icon size={22} aria-hidden /><span><strong>{templateNames[i]}</strong><small>{templateDescriptions[i]}</small></span><span className="start-radio" aria-hidden /></button>; })}</div>
            <div className="start-field"><label className="start-label" htmlFor="start-asset">{zh ? "选一只链上美股" : "Choose a tokenized US stock"}</label>{loadingAssets && <p className="start-muted" role="status">{zh ? "正在读取支持的资产…" : "Loading supported assets…"}</p>}
              <select id="start-asset" value={stock?.assetKey ?? ""} onChange={(event) => { setStockKey(event.target.value); setError(null); }} disabled={loadingAssets || stocks.length === 0}>{stocks.length === 0 && <option value="">{zh ? "暂无可用资产" : "No assets available"}</option>}{stocks.map((asset) => <option key={asset.assetKey} value={asset.assetKey}>{asset.displaySymbol} · {asset.underlyingId.split(":").slice(1).join(":")}</option>)}</select>
              {!loadingAssets && (assets.source !== "live" || stocks.length === 0 || stables.length === 0) && <div className="start-registry-note" role="status"><p>{assets.source === "cache" ? (zh ? "目前显示上次缓存的资产列表，模拟时仍由服务重新核对。" : "Showing the cached asset list; the service revalidates it during simulation.") : (zh ? "暂时无法取得可用资产。恢复后即可模拟，原有工具仍可访问。" : "Supported assets are currently unavailable. Retry to simulate; existing tools remain accessible.")}</p><button type="button" className="start-link-button" onClick={() => void reloadAssets(true)}>{zh ? "重试资产列表" : "Retry assets"}</button></div>}
            </div>
            <div className="start-field"><div className="start-label"><label htmlFor="start-budget">{zh ? "模拟总预算" : "Total simulation budget"}</label><span>{zh ? "不是入金" : "No deposit"}</span></div><div className="start-budget"><input id="start-budget" inputMode="decimal" autoComplete="off" maxLength={48} value={budget} onChange={(event) => { setBudget(event.target.value); setError(null); }} aria-invalid={!!amountError} aria-describedby={amountError ? "start-budget-error" : undefined} /><select aria-label={zh ? "资金币种" : "Funding token"} value={stable?.assetKey ?? ""} onChange={(event) => { setStableKey(event.target.value); setError(null); }} disabled={loadingAssets || stables.length === 0}>{stables.length === 0 && <option value="">—</option>}{stables.map((asset) => <option key={asset.assetKey} value={asset.assetKey}>{asset.displaySymbol}</option>)}</select></div><div className="start-presets">{["30", "90", "150"].map((value) => <button type="button" key={value} onClick={() => { setBudget(value); setError(null); }}>{value}</button>)}</div>{amountError && <p id="start-budget-error" className="start-error" role="alert">{amountError}</p>}</div>
          </fieldset>
          <p className="start-workspace-link"><CircleHelp size={14} aria-hidden />{zh ? "需要更多设置？" : "Need more control?"} <Link href="/agent?entry=buy">{zh ? "打开完整创建表单" : "Open the full task form"}<ExternalLink size={12} aria-hidden /></Link></p>
        </form>{summary}
      </div>
      {busy && <div className="start-loading" role="status" aria-live="polite"><Character busy /><div><h2>{zh ? "让计划，走一遍。" : "Let the plan play out."}</h2><p>{slow ? (zh ? "服务仍在处理这份计划，请稍候；当前操作不会签名或交易。" : "The service is still processing your plan. This action cannot sign or trade.") : (zh ? "正在提交模拟计划，等待服务返回条件判断。" : "Submitting your simulation and waiting for the condition evaluation.")}</p></div></div>}
      <div className="start-note-row"><ShieldCheck size={15} aria-hidden /><p>{zh ? "你可以直接用网页模板体验；自然语言指令和外部 Agent 接入保留在完整工作区。" : "Start with web templates. Natural-language instructions and external agent integration remain in the full workspace."}</p></div>
    </>}
    {result && stage === "result" && <>
      <div className="start-result-banner" data-decision={simulationDecision(result.view)}>
        <div><span className="start-result-label"><FlaskConical size={14} aria-hidden />{zh ? "模拟结果 · 未执行交易" : "Simulation · no trade executed"}</span><h1 ref={heading} tabIndex={-1}>{simulationDecision(result.view) === "ready" ? (zh ? "条件齐了，可以准备下一拍。" : "The conditions are met for the next step.") : simulationDecision(result.view) === "waiting" ? (zh ? "这一拍，先等一等。" : "This beat calls for a pause.") : simulationDecision(result.view) === "stopped" ? statusLabel(result.view.task.status, locale) : (zh ? "计划已创建，继续核对状态。" : "Plan created. Review its current state.")}</h1><p>{simulationDecision(result.view) === "ready" ? (zh ? "服务返回的本轮模拟条件通过。真实运行仍需单独创建任务、确认授权与执行方式。" : "The service reports that this simulation passed. A live task still needs separate creation, authorization and an execution method.") : simulationDecision(result.view) === "waiting" ? (zh ? "计划保留预算，以下是服务返回的等待原因。" : "The plan keeps its budget. These are the waiting reasons returned by the service.") : (zh ? "创建成功不等于条件通过。可以先点「更新任务状态」，或展开下方的完整返回数据查看服务的原始判断。" : "Creation does not prove the conditions passed. Refresh the status first, or expand the full response below to see the service's raw evaluation.")}</p></div><Character />
      </div>
      <div className="start-grid start-result-grid"><div><h2 className="start-section-title">{zh ? "为什么这样决定？" : "Why this decision?"}</h2>
        {result.view.task.blockers.length > 0 ? <ul className="start-reasons">{result.view.task.blockers.map((blocker, i) => <li key={blocker.code + "-" + i}><Clock3 size={18} aria-hidden /><div><strong>{blockerSentence(blocker, locale)}</strong>{(blocker.userActionRequired || blocker.evidenceAt) && <p>{blocker.userActionRequired && <span>{zh ? "需要你处理" : "Needs your attention"}{blocker.evidenceAt ? " · " : ""}</span>}{blocker.evidenceAt && <>{zh ? "依据时间：" : "Evidence time: "}{formatTime(blocker.evidenceAt, locale)}</>}</p>}</div></li>)}</ul> : <div className="start-reason-empty">{simulationDecision(result.view) === "ready" ? <Check size={19} aria-hidden /> : <CircleHelp size={19} aria-hidden />}<p>{simulationDecision(result.view) === "ready" ? (zh ? "本轮评估确认条件满足，未返回阻塞项。" : "This evaluation confirms the conditions are met with no reported blockers.") : (zh ? "服务这一轮没有列出等待原因，但这不等于可以买入；稍后更新状态再看。" : "The service listed no waiting reasons this round. That alone does not mean it would buy; refresh the status later.")}</p></div>}
        <div className="start-next"><ArrowRight size={18} aria-hidden /><div><strong>{zh ? "下一次检查" : "Next check"}</strong><p>{result.view.task.nextCheckAt ? formatTime(result.view.task.nextCheckAt, locale) : (zh ? "服务暂未给出明确时间；稍后点「更新任务状态」再看。" : "The service has not given a time yet; refresh the status later.")}</p></div></div>
        <p className="start-muted start-evaluated">{zh ? "状态更新时间：" : "Status updated: "}{formatTime(result.view.lastEvaluation?.evaluatedAt ?? result.view.task.updatedAt, locale)}</p>
        <button type="button" className="start-link-button" onClick={() => void refreshResult()} disabled={refreshing}>{refreshing ? (zh ? "更新中…" : "Updating…") : (zh ? "更新任务状态" : "Refresh task status")}</button>
        <details className="start-conditions"><summary>{zh ? "查看完整返回数据" : "Inspect the full response"}</summary><Json value={result.view} /></details>
      </div>{summary}</div>
      <div className="start-actions"><button className="start-primary" type="button" onClick={() => move("prepare")}>{zh ? "准备一份真实计划" : "Prepare a live plan"}<ArrowRight size={16} aria-hidden /></button><Link className="start-secondary" href="/agent">{zh ? "打开完整工作区与工具" : "Open the full workspace and tools"}<ExternalLink size={14} aria-hidden /></Link><button type="button" className="start-link-button" onClick={() => move("setup")}>{zh ? "调整计划" : "Edit plan"}</button></div>
      <p className="start-fine">{zh ? "模拟不会花费资金、签发交易证书或提交链上交易；它不等于真实成交，也不保证收益。" : "Simulation does not spend funds, issue transaction certificates or submit on-chain trades. It is not a fill or a promise of returns."}</p>
    </>}
    {result && stage === "prepare" && <>
      <header className="start-heading"><span className="start-overline">BEFORE THE FIRST REAL TRADE</span><h1 ref={heading} tabIndex={-1}>{zh ? "真的运行之前，边界由你定。" : "Set the boundaries before a real trade."}</h1><p>{zh ? "模拟任务保持原样。下一步会把这份方案带入原有的真实任务创建表单，由你再次确认。" : "Your simulation stays unchanged. Continue with this plan in the existing live-task form and review it again."}</p></header>
      <div className="start-grid"><div><dl className="start-review"><div><dt>{zh ? "资产与方式" : "Asset and plan"}</dt><dd>{result.stock.displaySymbol} · {result.sample.title[locale]}</dd></div><div><dt>{zh ? "总额度上限" : "Total cap"}</dt><dd>{formatMoney(currentTotal)}</dd></div><div><dt>{zh ? "每次上限 / 次数" : "Per step / steps"}</dt><dd>{formatMoney(currentAmount)} × {result.sample.steps}</dd></div><div><dt>{zh ? "钱包" : "Wallet"}</dt><dd>{account ? account.slice(0, 6) + "…" + account.slice(-4) : (zh ? "下一步确认" : "Confirm next")}</dd></div><div><dt>{zh ? "授权额度与有效期" : "Authorization and expiry"}</dt><dd>{zh ? "创建真实任务后，签名前确认" : "Review before signing the live task"}</dd></div><div><dt>{zh ? "执行方式" : "Execution method"}</dt><dd>{zh ? "浏览器钱包或你的执行 Agent" : "Browser wallet or your execution agent"}<small>{zh ? "未确认执行者就绪前，不视为已开始自动交易。" : "Automatic trading is not ready until the executor is confirmed."}</small></dd></div></dl>
        <div className="start-note-row"><ShieldCheck size={19} aria-hidden /><p>{zh ? "暂停只停止后续证书签发，已取走的未过期证书仍可能执行；彻底撤销以链上确认为准。" : "Pausing stops future certificate issuance. Previously retrieved, unexpired certificates may still execute; revocation is final only after on-chain confirmation."}</p></div>
      </div>{summary}</div>
      <div className="start-actions"><button className="start-primary" type="button" onClick={continueToLive}>{zh ? "带着这份计划继续" : "Continue with this plan"}<ArrowRight size={16} aria-hidden /></button><button className="start-link-button" type="button" onClick={() => move("result")}>{zh ? "返回模拟结果" : "Back to simulation"}</button><Link href="/agent?entry=buy" className="start-link-button">{zh ? "完整创建表单" : "Full task form"}</Link></div>
    </>}
    {error && <div className="start-error-panel" role="alert"><p>{error}</p><Link href="/agent">{zh ? "打开完整工作区" : "Open the full workspace"}<ArrowRight size={14} aria-hidden /></Link></div>}
    {!busy && <div className="start-recent"><RecentAgentTasks /></div>}
  </div>;
}
