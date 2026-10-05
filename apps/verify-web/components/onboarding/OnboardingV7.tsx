"use client";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Eye, ShieldCheck, SlidersHorizontal, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { tv, type V7Key } from "@/lib/i18n.v7";
import { agentTasks, type TaskCreated } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { defaultStable, loadAssets, stocksOf, type AssetEntry, type AssetsLoad } from "@/lib/assets";
import { v7FixtureRequested } from "@/lib/v7";
import { FX_OWNER, FX_USDG, FX_AAPLX, FX_NVDAX } from "@/lib/v7fixtures";
import { Card } from "@/components/ui";
import { COMPLEX_TASKS } from "../agent/home/entries";
import { ModeTag } from "../agent/shared";
import { DelegationWizard } from "../agent/delegation/DelegationWizard";
import { signaturePreview } from "../agent/delegation/delegationModel";
import { ActivityFeed } from "../agent/tasks/v7/ActivityFeed";
import { RunList } from "../agent/tasks/v7/RunList";
import { useActivityFeed } from "../agent/tasks/v7/useActivityFeed";
import { presenceKey } from "../agent/tasks/v7/runtimeModel";
import { buildStartRequest, createFailureKind, validateStartDraft, type StartDraft } from "./modelV7";
import { editJourney, emptyJourney, journeyKey, liveFromObservation, parseJourney, type StartAttempt, type StartJourney } from "./journeyV7";
import "../agent/v7.css";
import "./onboardingV7.css";

type Stage = "describe" | "watch" | "live";
const STAGES: Stage[] = ["describe", "watch", "live"];
const FIXTURE_ASSETS: AssetEntry[] = [
  { assetKey: FX_USDG, tokenAddress: FX_USDG.split(":")[2]!, tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", underlyingId: "fiat:USD", executionAllowed: true },
  { assetKey: FX_AAPLX, tokenAddress: FX_AAPLX.split(":")[2]!, tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output", underlyingId: "NASDAQ:AAPL", executionAllowed: true },
  { assetKey: FX_NVDAX, tokenAddress: FX_NVDAX.split(":")[2]!, tokenDecimals: 18, displaySymbol: "NVDAx", role: "stock_output", underlyingId: "NASDAQ:NVDA", executionAllowed: true },
];
function fromTemplate(i: number, stocks: string[], locale: "zh" | "en"): StartDraft {
  const t = COMPLEX_TASKS[i] ?? COMPLEX_TASKS[0]!;
  return { objective: t.objective[locale], strategy: t.strategy[locale], assetKeys: stocks.slice(0, t.assets), totalHuman: "10", perStepHuman: "2", maxSteps: Math.min(t.steps, 5), days: t.days, allowSell: false, regularOnly: !!t.regularSessionOnly, trustTier: t.trustTier, watch: [...t.watch], exampleId: t.id };
}

export function OnboardingV7({ account }: { account: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const s = (k: V7Key) => tv(locale, k);
  const router = useRouter();
  const sp = useSearchParams();
  const stage: Stage = sp.get("step") === "watch" ? "watch" : sp.get("step") === "live" ? "live" : "describe";
  const fixture = v7FixtureRequested(sp.toString());
  const owner = (fixture ? FX_OWNER : account).toLowerCase();
  const [journey, setJourney] = useState<StartJourney>(() => emptyJourney(owner));
  const current = useRef(journey);
  const [restored, setRestored] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [assets, setAssets] = useState<AssetsLoad>({ assets: [], source: "none", evidenceMode: null });
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [assetRetry, setAssetRetry] = useState(0);
  const [busy, setBusy] = useState<"sim" | "live" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const draft = journey.draft;
  const stocks = useMemo(() => stocksOf(assets.assets), [assets.assets]);
  const stable = journey.observation?.stable ?? journey.attempt?.stable ?? defaultStable(assets.assets);
  const errors = draft ? validateStartDraft(draft, stable) : [];
  const unavailable = draft?.assetKeys.some((k) => !stocks.some((a) => a.assetKey === k)) ?? false;
  const observed = journey.observation;
  const taskHref = (id: string) => "/agent/tasks/" + encodeURIComponent(id) + (fixture ? "?v7fixture=1" : "");
  const startHref = (step: Stage) => "/start?step=" + step + (fixture ? "&v7fixture=1" : "");
  const storageKey = journeyKey(owner) + (fixture ? ":fixture" : "");

  function save(next: StartJourney) {
    current.current = next;
    setJourney(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let j = emptyJourney(owner);
    try { j = parseJourney(sessionStorage.getItem(storageKey), owner) ?? j; } catch { setSaveFailed(true); }
    current.current = j;
    setJourney(j);
    setRestored(true);
  }, [owner, storageKey]);
  useEffect(() => {
    let active = true;
    setLoadingAssets(true);
    if (fixture) { setAssets({ assets: FIXTURE_ASSETS, source: "live", evidenceMode: null }); setLoadingAssets(false); return; }
    void loadAssets({ force: assetRetry > 0 }).then((a) => { if (active) { setAssets(a); setLoadingAssets(false); } });
    return () => { active = false; };
  }, [fixture, assetRetry]);
  useEffect(() => {
    if (restored && !journey.draft && stocks.length) {
      const next = { ...current.current, draft: fromTemplate(0, stocks.map((x) => x.assetKey), locale) };
      current.current = next;
      setJourney(next);
    }
  }, [restored, journey.draft, stocks, locale]);

  function edit(next: StartDraft, template = journey.template) {
    save(editJourney(current.current, next, template));
    setErr(null);
    setReviewed(false);
  }
  const set = (patch: Partial<StartDraft>) => { if (draft) edit({ ...draft, ...patch }); };

  async function create(mode: "SIMULATION" | "LIVE") {
    if (locked.current || !restored) return;
    setErr(null);
    let j = current.current;
    let attempt: StartAttempt;
    if (mode === "SIMULATION") {
      if (!draft || !stable || errors.length || unavailable) return;
      if (j.observation) { router.push(startHref("watch")); return; }
      const body = j.attempt?.body ?? buildStartRequest(draft, stable, owner, "SIMULATION", "web-start7-sim-" + crypto.randomUUID(), new Date(Date.now() + draft.days * 86_400_000).toISOString());
      if (!body) return;
      if (Date.parse(body.scope!.deadline!) <= Date.now()) { save({ ...j, attempt: null }); setErr(zh ? "上次请求已过期，请再次开始观察。" : "The previous request expired. Start observation again."); return; }
      attempt = j.attempt ?? { draft, stable, body };
      j = { ...j, attempt };
    } else {
      if (j.liveId) { router.push(startHref("live")); return; }
      if (!j.observation || !reviewed) return;
      attempt = j.observation;
      j = { ...j, liveRequestId: j.liveRequestId ?? "web-start7-live-" + crypto.randomUUID() };
    }
    const body = mode === "SIMULATION" ? attempt.body : liveFromObservation(attempt.body, j.liveRequestId!);
    if (!body) { setErr(zh ? "观察任务的有效期已结束，请返回修改目标并重新观察。" : "This observation's scope has expired. Edit the goal and observe again."); return; }
    save(j); // Persist before the request, so refresh/retry uses the same idempotency key.
    locked.current = true;
    setBusy(mode === "SIMULATION" ? "sim" : "live");
    const r = fixture ? null : await agentTasks.create(body).catch(() => null);
    if (!mounted.current) return;
    locked.current = false;
    setBusy(null);
    if (!fixture) {
      if (!r || r.status === 0) { setErr(s("unreachable")); return; }
      if (r.status !== 200 && r.status !== 201) {
        const kind = createFailureKind(r);
        setErr(kind === "hosted_closed" ? (zh ? "这个钱包暂未开放托管服务。你可以到任务中心连接自己的 Agent，或体验页底的手动教学。" : "Hosted service is not enabled for this wallet. Use your own agent in the workspace, or try the manual walkthrough below.") : kind === "sim_limit" ? s("st_sim_limit") : apiError(r, locale));
        return;
      }
      const created = r.data as TaskCreated;
      if (created.mode !== mode || !created.task?.id || created.task.owner?.toLowerCase() !== owner) {
        setErr(zh ? "返回的任务与请求不一致，已停止后续操作。请到任务中心检查记录。" : "The returned task does not match this request. Check the workspace before continuing."); return;
      }
    }
    const id = fixture ? "tsk_fixture" : (r!.data as TaskCreated).task.id;
    if (mode === "SIMULATION") save({ ...j, observation: { ...attempt, id }, attempt: null });
    else save({ ...j, liveId: id });
    router.push(startHref(mode === "SIMULATION" ? "watch" : "live"));
  }

  const missing = restored && ((stage === "watch" && !observed) || (stage === "live" && !journey.liveId));
  const summary = stage === "describe" ? draft : observed?.draft ?? null;
  const summaryStable = stage === "describe" ? stable : observed?.stable ?? null;
  const errorText: Record<string, string> = zh ? { objective: "写下你希望 Agent 完成的目标。", assets: "选择 1–8 个可交易标的。", total: "总预算需大于 0，且不超过币种的小数精度。", perStep: "单笔上限需大于 0，且不能超过总预算。", maxSteps: "成交次数需为 1–60 的整数。", days: "有效期需为 1–365 天。" } : { objective: "Describe what the agent should do.", assets: "Select 1–8 tradable assets.", total: "Enter a positive budget within the token's precision.", perStep: "Each trade must be positive and no larger than the total budget.", maxSteps: "Use 1–60 successful trades.", days: "Use a duration of 1–365 days." };

  return <div className="ag-page start7" data-testid="start-v7" data-stage={stage}>
    {fixture && <p className="ag-warn"><ModeTag mode="FIXTURE" /> {s("fixture_note")}</p>}
    <header className="start7-heading"><div><p className="start7-eyebrow">{zh ? "Chaconne Agent · 第一个任务" : "CHACONNE AGENT / FIRST MISSION"}</p><h1>{zh ? "你的目标，它的下一拍。" : "Your goal. Its next move."}</h1><p>{zh ? "让内置的 Chaconne Agent 看事件、做判断。先观察它如何工作，再决定是否授权真实交易。" : "Let the built-in AI agent follow events and make decisions. Watch it work before authorizing real trades."}</p></div><Image className="start7-mascot" src="/brand/conductor-v1.jpg" alt={zh ? "Chaconne 小指挥家" : "Chaconne conductor"} width={112} height={112} unoptimized /></header>
    <ol className="v7-steps-bar start7-steps" aria-label={zh ? "步骤" : "Steps"}>{(["st_step1", "st_step2", "st_step3", "st_step4"] as const).map((k, i) => <li key={k} aria-current={i === STAGES.indexOf(stage) ? "step" : undefined} data-done={i < STAGES.indexOf(stage) ? "1" : "0"}><span>0{i + 1}</span>{s(k)}</li>)}</ol>
    {saveFailed && <p className="ag-warn" role="status">{zh ? "浏览器暂不能保存本页进度。已创建的任务仍可在任务中心找到。" : "This browser cannot save progress. Created tasks remain in the workspace."}</p>}
    {!restored ? <Card><p role="status">{s("loading")}</p></Card> : missing ? <Card title={zh ? "从任务中心接着走" : "Continue from your workspace"}><p>{zh ? "这个标签页没有对应的流程记录。已创建的任务不会丢失，可从任务中心继续授权或查看活动。" : "This tab has no matching journey. Created tasks remain in the workspace for authorization and activity."}</p><div className="ag-actions mt-4"><Link className="btn" href="/agent/tasks">{zh ? "打开任务中心" : "Open tasks"}</Link><Link className="btn-ghost" href={startHref("describe")}>{zh ? "交代一个新目标" : "Start a new goal"}</Link></div></Card> : <div className="start7-layout">
      <div className="start7-main">
      {stage === "describe" && <Card>
        <div className="start7-section-title"><Sparkles size={19} /><h2>{zh ? "从一个想法开始" : "Start with an idea"}</h2></div>
        <p className="ag-note">{zh ? "选择一个起点，再改成你的目标。模板只提供思路，不代表收益承诺。" : "Choose a starting point and make it yours. These ideas are not promises of returns."}</p>
        {loadingAssets ? <p className="start7-empty" role="status">{zh ? "正在获取可交易资产…" : "Loading tradable assets…"}</p> : (!stable || !stocks.length) ? <div className="start7-empty"><p>{zh ? "暂时无法获取可交易资产，请重试。" : "Tradable assets are unavailable. Please retry."}</p><button className="btn-ghost" onClick={() => setAssetRetry((n) => n + 1)}>{zh ? "重新加载" : "Reload"}</button></div> : draft && <form onSubmit={(e) => { e.preventDefault(); void create("SIMULATION"); }}>
          <fieldset disabled={!!busy} className="start7-fields">
            {assets.source === "cache" && <p className="ag-warn">{zh ? "当前显示上次缓存的资产列表。" : "Showing the last cached asset list."} <button type="button" className="underline" onClick={() => setAssetRetry((n) => n + 1)}>{zh ? "重试" : "Retry"}</button></p>}
            <div className="start7-presets" role="group" aria-label={zh ? "示例任务" : "Example tasks"}>{COMPLEX_TASKS.map((t, i) => <button key={t.id} type="button" aria-pressed={journey.template === i} onClick={() => edit(fromTemplate(i, stocks.map((a) => a.assetKey), locale), i)}><span>0{i + 1}</span><strong>{t.title[locale]}</strong></button>)}</div>
            <label className="start7-label">{s("st_goal")}<textarea className="field" rows={3} maxLength={500} value={draft.objective} onChange={(e) => set({ objective: e.target.value })} aria-invalid={errors.includes("objective")} /></label>
            <fieldset className="start7-asset-picker"><legend>{zh ? "它可以交易哪些标的？" : "What can it trade?"}</legend><div>{stocks.map((a) => <label key={a.assetKey} data-selected={draft.assetKeys.includes(a.assetKey)}><input type="checkbox" checked={draft.assetKeys.includes(a.assetKey)} onChange={(e) => set({ assetKeys: e.target.checked ? [...draft.assetKeys, a.assetKey] : draft.assetKeys.filter((k) => k !== a.assetKey) })} /><span>{a.displaySymbol}</span></label>)}</div></fieldset>
            <div className="start7-section-title"><ShieldCheck size={19} /><h2>{zh ? "边界，由你来定" : "You set the boundaries"}</h2></div>
            <div className="start7-numbers">
              <label>{s("st_total")} · {stable.displaySymbol}<input className="field" inputMode="decimal" maxLength={30} value={draft.totalHuman} onChange={(e) => set({ totalHuman: e.target.value })} aria-invalid={errors.includes("total")} /></label>
              <label>{s("st_per")} · {stable.displaySymbol}<input className="field" inputMode="decimal" maxLength={30} value={draft.perStepHuman} onChange={(e) => set({ perStepHuman: e.target.value })} aria-invalid={errors.includes("perStep")} /></label>
              <label>{zh ? "最多成功成交" : "Successful trade limit"}<input className="field" type="number" min={1} max={60} value={draft.maxSteps || ""} onChange={(e) => set({ maxSteps: Number(e.target.value) })} aria-invalid={errors.includes("maxSteps")} /></label>
              <label>{s("st_days")}<input className="field" type="number" min={1} max={365} value={draft.days || ""} onChange={(e) => set({ days: Number(e.target.value) })} aria-invalid={errors.includes("days")} /></label>
            </div>
            <label className="start7-permission"><input type="checkbox" checked={draft.allowSell} onChange={(e) => set({ allowSell: e.target.checked })} /><span><strong>{zh ? "同时允许 Agent 卖出" : "Also allow the agent to sell"}</strong><small>{zh ? "包含钱包中这些标的的已有持仓，并不限于本任务买入的部分。授权时会列出每个标的的卖出上限。" : "Includes existing wallet holdings of these assets, not just purchases by this task. Each asset's sell limit is shown during authorization."}</small></span></label>
            <details className="start7-advanced"><summary><SlidersHorizontal size={16} />{zh ? "策略细节与交易时段" : "Strategy details and trading hours"}</summary><label className="start7-label">{s("st_strategy")}<textarea className="field" rows={6} maxLength={4000} value={draft.strategy} onChange={(e) => set({ strategy: e.target.value })} /></label><label className="ag-check"><input type="checkbox" checked={draft.regularOnly} onChange={(e) => set({ regularOnly: e.target.checked })} /><span>{s("st_regular")}</span></label><p className="ag-note">{zh ? "策略告诉 Agent 怎么思考；交易仍须符合你确认的预算、标的和授权范围。" : "The strategy guides reasoning. Trades must fit your confirmed budget, assets and authorization scope."}</p></details>
            {(errors.length > 0 || unavailable) && <div className="ag-warn" aria-live="polite">{errors.map((e) => <p key={e}>{errorText[e]}</p>)}{unavailable && <p>{zh ? "草稿中有当前不可交易的资产，请重新选择一个示例。" : "Some saved assets are no longer tradable. Choose a template again."}</p>}</div>}
            <button type="submit" className="btn start7-submit" disabled={!!busy || errors.length > 0 || unavailable}>{busy === "sim" ? s("st_watch_creating") : observed ? (zh ? "继续查看这次观察" : "Continue this observation") : s("st_watch_cta")}<ArrowRight size={17} /></button>
            <p className="ag-note">{zh ? "这是观察模式，不执行链上交易。首次访问记录可能需要签一条登录消息，不产生交易费用。" : "Observation mode does not execute on-chain trades. First access to records may require a sign-in message, with no transaction fee."}</p>
          </fieldset>
        </form>}
      </Card>}
      {stage === "watch" && observed && <>
        <WatchStage taskId={observed.id} fixture={fixture} />
        <Card title={zh ? "看过它的判断，再决定真实运行" : "Review its decisions before going live"}>
          <p className="text-sm">{zh ? "下一步会创建一份相同目标、标的、预算与截止时间的真实任务。你还需要完成逐项授权，平台才可以执行。" : "Next, create a live task with the same goal, assets, budget and deadline. Itemized authorization is still required before the platform can execute."}</p>
          <p className="ag-note mt-3">{zh ? "预计最多 " : "Expect up to "}{signaturePreview(observed.draft.allowSell ? observed.draft.assetKeys.length : 0, observed.draft.allowSell)}{zh ? " 次授权签名；已有额度可减少签名。不支持 Permit 的币种可能需要一笔链上授权交易。" : " authorization signatures; existing allowances may reduce this. Tokens without Permit support may require an on-chain approval transaction."}</p>
          {journey.liveId ? <Link className="btn start7-submit" href={startHref("live")}>{zh ? "继续已创建任务的授权" : "Continue this task's authorization"}<ArrowRight size={17} /></Link> : <><label className="start7-permission"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /><span>{zh ? "我已核对委托范围，理解真实运行会使用钱包资金。" : "I reviewed the scope and understand live execution uses wallet funds."}</span></label><button type="button" className="btn start7-submit" disabled={!!busy || !reviewed} onClick={() => void create("LIVE")}>{busy === "live" ? s("st_live_creating") : (zh ? "创建真实任务，核对授权" : "Create live task & review authorization")}<ArrowRight size={17} /></button></>}
          <div className="start7-secondary"><Link href={taskHref(observed.id)}>{zh ? "在任务中心查看观察记录" : "Open observation in workspace"}</Link><button disabled={!!busy} onClick={() => { edit(observed.draft); router.push(startHref("describe")); }}>{zh ? "修改目标，重新观察" : "Edit goal & observe again"}</button></div>
        </Card>
      </>}
      {stage === "live" && journey.liveId && <Card title={s("d_title")}><p className="ag-note mb-3">{zh ? "逐项核对预算、卖出范围和代币额度。以清单状态为准；收到请求不等于交易成交。" : "Check each budget, sell scope and token allowance. Follow the checklist; an accepted request is not a confirmed trade."}</p>{fixture && <p className="ag-note mb-3">{zh ? "以下授权清单为固定示例，不随本页预算变化。真实任务的清单由服务端按实际范围生成。" : "The checklist below is a fixed example and does not follow this preview budget. Real task checklists are generated from the actual scope."}</p>}<DelegationWizard taskId={journey.liveId} owner={owner} fixture={fixture} onComplete={() => router.push(taskHref(journey.liveId!))} /><Link className="start7-task-link" href={taskHref(journey.liveId)}>{s("d_open_task")}<ArrowRight size={16} /></Link></Card>}
      {err && <div className="ag-warn" role="alert"><p>{err}</p><Link className="underline" href="/agent/tasks">{zh ? "查看任务中心" : "Open workspace"}</Link></div>}
      </div>
      {summary && <ScopeSummary draft={summary} stable={summaryStable} assets={assets.assets} deadline={stage === "describe" ? null : observed?.body.scope?.deadline ?? null} zh={zh} />}
    </div>}
    <aside className="v7-teach"><p><strong>{s("st_teach_h")}</strong> {s("st_teach_p")}</p><Link className="btn-ghost inline-flex items-center" href="/start?mode=play">{s("st_teach_cta")}</Link></aside>
  </div>;
}
function ScopeSummary({ draft, stable, assets, deadline, zh }: { draft: StartDraft; stable: AssetEntry | null; assets: AssetEntry[]; deadline: string | null; zh: boolean }) {
  return <aside className="start7-scope"><p className="start7-eyebrow">{zh ? "授权范围" : "YOUR MANDATE"}</p><h2>{zh ? "你交给它的范围" : "What you are delegating"}</h2><p className="start7-objective">{draft.objective}</p><div className="start7-scope-assets">{draft.assetKeys.map((key) => <span key={key}>{assets.find((a) => a.assetKey === key)?.displaySymbol ?? key.slice(-8)}</span>)}</div><dl><div><dt>{zh ? "总预算" : "Total budget"}</dt><dd>{draft.totalHuman} <small>{stable?.displaySymbol}</small></dd></div><div><dt>{zh ? "单笔上限" : "Per trade"}</dt><dd>{draft.perStepHuman} <small>{stable?.displaySymbol}</small></dd></div><div><dt>{zh ? "成功成交上限" : "Successful trades"}</dt><dd>{draft.maxSteps}</dd></div><div><dt>{zh ? "有效期" : "Duration"}</dt><dd>{draft.days} {zh ? "天" : "days"}</dd></div><div><dt>{zh ? "方向" : "Direction"}</dt><dd>{draft.allowSell ? (zh ? "买入 + 卖出" : "Buy + sell") : (zh ? "仅买入" : "Buy only")}</dd></div></dl>{deadline && <p className="ag-note">{zh ? "截止于 " : "Expires "}{new Date(deadline).toLocaleString(zh ? "zh-CN" : "en-US")}</p>}{draft.allowSell && <p className="start7-scope-warning">{zh ? "卖出范围包含这些标的的已有钱包持仓。" : "Sell permission includes existing wallet holdings of these assets."}</p>}<div className="start7-scope-foot"><Eye size={18} /><p>{zh ? "观察 ≠ 成交。Agent 会判断，也可以选择等待。任务结束不会自动撤销链上代币额度。" : "Observation is not execution. The agent may decide to wait. Ending a task does not automatically revoke on-chain allowances."}</p></div></aside>;
}
function WatchStage({ taskId, fixture }: { taskId: string; fixture: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const feed = useActivityFeed(taskId, { fixture, mode: "SIMULATION" });
  const key = presenceKey(feed.runtime?.presence ?? null);
  return <><Card right={<ModeTag mode="SIMULATION" />} title={zh ? "观察 Agent 的下一步" : "Watch the agent's next move"}><p>{zh ? "它会检查事件和证据，决定行动或等待。这里展示判断过程，不会执行链上交易；观察轮次和每日任务数有限额。" : "It checks events and evidence, then decides whether to act or wait. No on-chain execution takes place. Observation rounds and daily tasks are limited."}</p><p className="start7-presence" aria-live="polite"><span />{feed.runtime && key ? tv(locale, key as V7Key) : (zh ? "正在获取 Agent 状态…" : "Fetching agent status…")}</p></Card><ActivityFeed feed={feed} sim /><RunList taskId={taskId} fixture={fixture} mode="SIMULATION" refreshKey={feed.items.length} /></>;
}
