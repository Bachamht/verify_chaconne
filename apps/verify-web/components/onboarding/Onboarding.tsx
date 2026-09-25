"use client";
/**
 * /start 新手引导（钱包账户化版）：连接钱包 → 选模板 / 资产 / 模拟总预算 → 建一个 SIMULATION 任务 → 看判断与等待原因 → 准备真实运行（直接进原表单）。
 * 记录跟着钱包走（/agent/tasks）；没有本机快照。两步之间用 ?step=result 进历史记录，浏览器回退回到上一步。
 */
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, ArrowRight, AudioLines, CalendarClock, Check, CircleHelp, Clock3, FlaskConical, LoaderCircle, ScanEye, ShieldCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { assetByKey, defaultStable, loadAssets, stablesOf, stocksOf, type AssetsLoad } from "@/lib/assets";
import { agentTasks, type CreateTaskBody } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import { conditionText } from "@/lib/conditions";
import { WalletGate } from "@/components/WalletGate";
import { SAMPLES } from "../agent/home/entries";
import { DRAFT_KEY, stashDraft } from "../agent/tasks/taskDraft";
import { blockerSentence, statusLabel } from "../agent/tasks/taskTitle";
import { buildSimulationRequest, isSimulationTask, liveDraftFromSimulation, simulationDecision, splitSimulationBudget, type SimulationTask } from "./model";
import "./onboarding.css";

const ICONS = [AudioLines, CalendarClock, ShieldCheck, Activity, ScanEye];
const PRESETS = ["100", "500", "1000"];

function Character({ busy = false }: { busy?: boolean }) {
  return <div className="start-character" data-busy={busy}><Image src="/brand/conductor-v1.jpg" alt="" width={768} height={768} sizes="180px" unoptimized draggable={false} /></div>;
}

export function Onboarding() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return <WalletGate title={zh ? "连接钱包，免费模拟一个任务" : "Connect a wallet to simulate a task for free"} description={zh ? "钱包地址就是你的账户，模拟结果会记在它名下。连接不会签名、不会花钱。" : "Your wallet address is your account; the simulation is recorded under it. Connecting never signs or spends."}>{(account) => <OnboardingFlow account={account} />}</WalletGate>;
}

function OnboardingFlow({ account }: { account: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const sp = useSearchParams();
  const stage: "setup" | "result" = sp.get("step") === "result" ? "result" : "setup";
  const [assets, setAssets] = useState<AssetsLoad>({ assets: [], source: "none", evidenceMode: null });
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [stockKey, setStockKey] = useState("");
  const [stableKey, setStableKey] = useState("");
  const [budget, setBudget] = useState(PRESETS[0]!);
  const [result, setResult] = useState<{ view: SimulationTask; request: CreateTaskBody } | null>(null);
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
  const amountError = stable && !amount ? (zh ? "请输入有效的总预算：金额须足够分配到每次买入，且不超过资金币种的小数精度。" : "Enter a positive total budget large enough for each step, within the funding token's decimal precision.") : null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reloadAssets = useCallback(async (force = false) => {
    setLoadingAssets(true);
    const value = await loadAssets({ force });
    if (mounted.current) { setAssets(value); setLoadingAssets(false); }
  }, []);
  useEffect(() => { void reloadAssets(); }, [reloadAssets]);
  // 刷新页面或直接打开 ?step=result 时没有结果：回到第一步（用 replace，不制造多余的历史记录）
  useEffect(() => { if (stage === "result" && !result) router.replace("/start"); }, [stage, result, router]);
  useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [busy]);
  useEffect(() => { if (stage === "result") heading.current?.focus({ preventScroll: false }); }, [stage]);

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
      const response = await agentTasks.create(request);
      if (response.status !== 200 && response.status !== 201) {
        if (mounted.current) setError(apiError(response, locale));
        return;
      }
      if (!isSimulationTask(response.data)) {
        if (mounted.current) setError(zh ? "服务返回的任务没有标明是模拟，这里已停止，没有创建任何真实任务。可以重试。" : "The service did not label the returned task as a simulation, so this page stopped here and no live task was created. Retry.");
        return;
      }
      requestIdentity.current = null;
      if (mounted.current) {
        setResult({ view: response.data, request });
        router.push("/start?step=result");
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
      const response = await agentTasks.get(result.view.task.id, account);
      if (!mounted.current) return;
      if (response.status !== 200) { setError(apiError(response, locale)); return; }
      if (!isSimulationTask(response.data)) { setError(zh ? "这次更新没有标明任务是模拟，未覆盖页面上的结果；可以稍后再试。" : "This update did not label the task as a simulation, so the result was left unchanged. Try again later."); return; }
      setResult((current) => current && current.view.task.id === response.data.task.id ? { ...current, view: response.data } : current);
    } catch {
      if (mounted.current) setError(zh ? "暂时无法更新任务状态，请稍后重试。" : "Task status could not be refreshed. Please retry.");
    } finally { if (mounted.current) setRefreshing(false); }
  }
  function prepareLive() {
    if (!result) return;
    const draft = liveDraftFromSimulation(result.request);
    stashDraft(draft);
    try {
      if (sessionStorage.getItem(DRAFT_KEY) !== JSON.stringify(draft)) throw new Error("draft not saved");
      router.push("/agent?entry=buy&draft=1");
    } catch {
      setError(zh ? "浏览器无法暂存这份草稿。可以打开完整创建表单，按下方方案手动填写。" : "This browser could not retain the draft. Open the full form and enter the plan below.");
    }
  }

  const current = stage === "result" ? result : null;
  const currentStock = current ? assetByKey(stocks, String(current.request.params["outputAssetKey"])) ?? stock : stock;
  const currentStable = current ? assetByKey(stables, String(current.request.params["inputAssetKey"])) ?? stable : stable;
  const currentSample = current ? SAMPLES.find((s) => s.playbookId === current.request.playbookId && JSON.stringify(s.conditions) === JSON.stringify(current.request.conditions.items)) ?? SAMPLES.find((s) => s.playbookId === current.request.playbookId) ?? sample : sample;
  const currentAmount = current ? String(current.request.params["perStepAmountRaw"] ?? current.request.params["amountRaw"]) : amount?.perStepRaw ?? null;
  const currentTotal = currentAmount && currentStable ? (BigInt(currentAmount) * BigInt(currentSample.steps)).toString() : null;
  // 展示按 2 位小数四舍五入（100 ÷ 3 显示 33.33 而不是 33.333333）；请求里的 raw 金额保持精确
  const formatMoney = (raw: string | null) => {
    if (!currentStable || raw === null) return "—";
    const n = Number(raw) / 10 ** currentStable.tokenDecimals;
    if (!Number.isFinite(n)) return formatAmount(raw, currentStable.tokenDecimals, currentStable.displaySymbol);
    return `${(Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currentStable.displaySymbol}`;
  };
  const decision = current ? simulationDecision(current.view) : "unknown";
  const summary = <aside className="start-summary">
    <div className="start-summary-head"><span className="start-overline">YOUR AGENT&apos;S PLAN</span><h2>{currentStock?.displaySymbol ?? (zh ? "等待资产列表" : "Loading assets")} · {currentSample.title[locale]}</h2></div>
    <div className="start-summary-body">
      <div className="start-values"><div><span>{zh ? "计划总上限" : "Total plan cap"}</span><strong>{formatMoney(currentTotal)}</strong></div><div><span>{zh ? "每次上限" : "Per-step cap"}</span><strong>{formatMoney(currentAmount)}</strong></div></div>
      <p>{zh ? "分 " + currentSample.steps + " 次买入；每次执行前都要满足计划条件。" : currentSample.steps + " planned steps; each step must meet the conditions before execution."}</p>
      <details className="start-conditions"><summary>{zh ? "查看完整条件" : "See all conditions"}</summary><ul>{(current?.view.task.conditions.items ?? currentSample.conditions).map((condition, i) => <li key={i}>{condition.type === "premium_bps_lte" && condition.referenceKind === "live"
        ? (zh ? "链上价相对实时参考价的溢价不超过 " + condition.value / 100 + "%" : "On-chain premium vs. the live reference at most " + condition.value / 100 + "%")
        : conditionText(condition, locale)}</li>)}</ul></details>
      {stage === "setup" && <button type="submit" form="start-plan-form" className="start-primary" disabled={busy || loadingAssets || !stock || !stable || !amount}>{busy ? <LoaderCircle className="start-spin" size={17} aria-hidden /> : <FlaskConical size={17} aria-hidden />}{busy ? (zh ? "正在模拟" : "Simulating") : (zh ? "运行一次免费模拟" : "Run a free simulation")}<ArrowRight size={16} aria-hidden /></button>}
    </div>
  </aside>;

  return <div className="start-page">
    {(current ? current.view.evidenceMode === "FIXTURE" : assets.evidenceMode === "FIXTURE") && <p className="start-registry-note" role="status">{zh ? "测试数据模式：当前服务返回的是预设数据，不代表实时市场。" : "Fixture data: the service is returning test data, not live market evidence."}</p>}
    <div className="start-topline"><Link href={stage === "setup" ? "/" : "/start"} onClick={stage !== "setup" ? (event) => { event.preventDefault(); setError(null); router.back(); } : undefined} className="start-back"><ArrowLeft size={14} aria-hidden />{stage === "setup" ? (zh ? "首页" : "Home") : (zh ? "调整计划" : "Edit plan")}</Link><ol className="start-progress" aria-label={zh ? "体验进度" : "Experience progress"}>{["setup", "result"].map((step, i) => <li key={step} aria-current={stage === step ? "step" : undefined}><span>0{i + 1}</span>{(zh ? ["选计划", "看结果"] : ["Choose", "Review"])[i]}</li>)}</ol></div>
    {stage === "setup" && <>
      <header className="start-heading"><span className="start-overline">YOUR FIRST AGENT TASK</span><h1 ref={heading} tabIndex={-1}>{zh ? "先给 Agent，定个交易节奏。" : "Give your agent a trading plan."}</h1><p>{zh ? "选资产、设预算，先看看计划现在会行动还是等待。" : "Choose an asset and a budget, then see whether the plan would act or wait right now."}</p></header>
      <div className="start-grid">
        <form id="start-plan-form" onSubmit={(event) => { event.preventDefault(); void simulate(); }}>
          <fieldset disabled={busy} className="start-fields"><legend className="start-label">{zh ? "你想怎么安排？" : "How would you like to buy?"}</legend><div className="start-templates">{SAMPLES.map((option, i) => { const Icon = ICONS[i] ?? AudioLines; return <button key={option.id} type="button" className="start-template" aria-pressed={sampleIndex === i} onClick={() => { setSampleIndex(i); setError(null); }}><Icon size={22} aria-hidden /><span><strong>{option.title[locale]}</strong><small>{option.what[locale]}</small></span><span className="start-radio" aria-hidden /></button>; })}</div>
            <div className="start-field"><label className="start-label" htmlFor="start-asset">{zh ? "选一只链上美股" : "Choose a tokenized US stock"}</label>{loadingAssets && <p className="start-muted" role="status">{zh ? "正在读取支持的资产…" : "Loading supported assets…"}</p>}
              <select id="start-asset" value={stock?.assetKey ?? ""} onChange={(event) => { setStockKey(event.target.value); setError(null); }} disabled={loadingAssets || stocks.length === 0}>{stocks.length === 0 && <option value="">{zh ? "暂无可用资产" : "No assets available"}</option>}{stocks.map((asset) => <option key={asset.assetKey} value={asset.assetKey}>{asset.displaySymbol} · {asset.underlyingId.split(":").slice(1).join(":")}</option>)}</select>
              {!loadingAssets && (assets.source !== "live" || stocks.length === 0 || stables.length === 0) && <div className="start-registry-note" role="status"><p>{assets.source === "cache" ? (zh ? "目前显示上次缓存的资产列表，模拟时仍由服务重新核对。" : "Showing the cached asset list; the service revalidates it during simulation.") : (zh ? "暂时无法取得可用资产。恢复后即可模拟。" : "Supported assets are currently unavailable. Retry to simulate.")}</p><button type="button" className="start-link-button" onClick={() => void reloadAssets(true)}>{zh ? "重试资产列表" : "Retry assets"}</button></div>}
            </div>
            <div className="start-field"><label className="start-label" htmlFor="start-budget">{zh ? "模拟总预算" : "Total simulation budget"}</label><div className="start-budget"><input id="start-budget" inputMode="decimal" autoComplete="off" maxLength={48} value={budget} onChange={(event) => { setBudget(event.target.value); setError(null); }} aria-invalid={!!amountError} aria-describedby={amountError ? "start-budget-error" : undefined} /><select aria-label={zh ? "资金币种" : "Funding token"} value={stable?.assetKey ?? ""} onChange={(event) => { setStableKey(event.target.value); setError(null); }} disabled={loadingAssets || stables.length === 0}>{stables.length === 0 && <option value="">—</option>}{stables.map((asset) => <option key={asset.assetKey} value={asset.assetKey}>{asset.displaySymbol}</option>)}</select></div><div className="start-presets">{PRESETS.map((value) => <button type="button" key={value} onClick={() => { setBudget(value); setError(null); }}>{value}</button>)}</div>{amountError && <p id="start-budget-error" className="start-error" role="alert">{amountError}</p>}</div>
          </fieldset>
          <p className="start-workspace-link"><CircleHelp size={14} aria-hidden />{zh ? "需要更多设置？" : "Need more control?"} <Link href="/agent?entry=buy">{zh ? "打开完整创建表单" : "Open the full task form"}</Link></p>
        </form>{summary}
      </div>
      {busy && <div className="start-loading" role="status" aria-live="polite"><Character busy /><div><h2>{zh ? "让计划，走一遍。" : "Let the plan play out."}</h2><p>{slow ? (zh ? "服务仍在处理这份计划，请稍候。" : "The service is still processing your plan.") : (zh ? "正在提交模拟计划，等待服务返回条件判断。" : "Submitting your simulation and waiting for the condition evaluation.")}</p></div></div>}
    </>}
    {current && stage === "result" && <>
      <div className="start-result-banner" data-decision={decision}>
        <div><h1 ref={heading} tabIndex={-1} className="start-result-title"><FlaskConical size={22} aria-hidden />{zh ? "模拟结果 · 未执行交易" : "Simulation result · no trade executed"}</h1><p className="start-result-sub">{decision === "ready" ? (zh ? "条件已满足：真实运行时会在这一刻买入。" : "Conditions are met: a live task would buy at this moment.") : decision === "waiting" ? (zh ? "现在在等待，原因如下。" : "Waiting right now, for the reasons below.") : decision === "stopped" ? statusLabel(current.view.task.status, locale) : (zh ? "计划已创建，等待第一次判断。" : "Plan created; waiting for its first evaluation.")}</p></div><Character />
      </div>
      <div className="start-grid start-result-grid"><div><h2 className="start-section-title">{zh ? "为什么这样决定？" : "Why this decision?"}</h2>
        {current.view.task.blockers.length > 0 ? <ul className="start-reasons">{current.view.task.blockers.map((blocker, i) => <li key={blocker.code + "-" + i}><Clock3 size={18} aria-hidden /><div><strong>{blockerSentence(blocker, locale)}</strong>{(blocker.userActionRequired || blocker.evidenceAt) && <p>{blocker.userActionRequired && <span>{zh ? "需要你处理" : "Needs your attention"}{blocker.evidenceAt ? " · " : ""}</span>}{blocker.evidenceAt && <>{zh ? "依据时间：" : "Evidence time: "}{formatTime(blocker.evidenceAt, locale)}</>}</p>}</div></li>)}</ul> : <div className="start-reason-empty">{decision === "ready" ? <Check size={19} aria-hidden /> : <CircleHelp size={19} aria-hidden />}<p>{decision === "ready" ? (zh ? "本轮评估确认条件满足，没有等待原因。" : "This evaluation confirms the conditions are met with nothing to wait for.") : (zh ? "服务这一轮没有列出等待原因；稍后更新状态再看。" : "The service listed no waiting reasons this round; refresh the status later.")}</p></div>}
        <div className="start-next"><ArrowRight size={18} aria-hidden /><div><strong>{zh ? "下一次检查" : "Next check"}</strong><p>{current.view.task.nextCheckAt
          ? (zh ? `下一次会在 ${formatTime(current.view.task.nextCheckAt, locale)} 重新检查；条件成立则执行买入（模拟任务只记录判断，不真的买）。` : `The next check is at ${formatTime(current.view.task.nextCheckAt, locale)}; if the conditions hold, the step executes (a simulation only records the decision).`)
          : (zh ? "服务暂未给出明确时间；稍后点「更新任务状态」再看。" : "The service has not given a time yet; refresh the status later.")}</p></div></div>
        <p className="start-muted start-evaluated">{zh ? "最近判断时间：" : "Last evaluated: "}{formatTime(current.view.lastEvaluation?.evaluatedAt ?? current.view.task.updatedAt, locale)} · <button type="button" className="start-link-button" onClick={() => void refreshResult()} disabled={refreshing}>{refreshing ? (zh ? "更新中…" : "Updating…") : (zh ? "更新任务状态" : "Refresh task status")}</button></p>
      </div>{summary}</div>
      <div className="start-actions"><button className="start-primary" type="button" onClick={prepareLive}>{zh ? "准备真实运行" : "Prepare to run for real"}<ArrowRight size={16} aria-hidden /></button><button type="button" className="start-link-button" onClick={() => { setError(null); router.back(); }}>{zh ? "调整计划" : "Edit plan"}</button><Link className="start-link-button" href="/agent/tasks">{zh ? "查看我的任务" : "View my tasks"}</Link></div>
    </>}
    {error && <div className="start-error-panel" role="alert"><p>{error}</p></div>}
  </div>;
}
