"use client";
/**
 * 「把目标交给 Agent」（CV-D16 批次 6）：主入口。三块分开——目标（要完成什么、多久）、策略（agent 理解与运用，签名之外可改、留版本）、
 * 授权范围（每次执行都必须满足：资产集合、总额、每笔上限、次数、期限、硬约束）。示例策略只是填一段文字，不绑定任何执行程序。
 * 不传 playbookId：服务端按范围合成参数（agent_goal），没有计划条件；何时买、买哪个、买多少由 agent 决定。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { agentTasks, notReady, type CreateTaskBody } from "@/lib/api-v2";
import { apiError, fieldErrors } from "@/lib/errors";
import { formatAmount, humanToRaw } from "@/lib/format";
import { balanceOf } from "@/lib/wallet";
import { assetByKey, defaultStable, stablesOf, stocksOf, type AssetEntry } from "@/lib/assets";
import { Pill } from "@/components/ui";
import { ModeTag, NotReady, OwnerField, useOwnerInput } from "../shared";
import { EXAMPLE_STRATEGIES } from "../home/entries";
import { takeGoalDraft } from "./taskDraft";

const WATCH_KINDS = [
  { id: "MACRO_TIER1", zh: "一级宏观数据（CPI、非农、FOMC）", en: "Tier-1 macro (CPI, jobs, FOMC)" },
  { id: "EARNINGS", zh: "所选股票的财报", en: "Earnings of the chosen stocks" },
  { id: "FED_SPEECH", zh: "联储讲话", en: "Fed speeches" },
  { id: "MACRO_TIER2", zh: "二级宏观数据", en: "Tier-2 macro" },
] as const;

export function GoalTaskForm({ assets, assetsSource, onRetryAssets }: { assets: AssetEntry[]; assetsSource?: "live" | "cache" | "none"; onRetryAssets?: () => void }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const { owner, connected, valid } = useOwnerInput();
  const stocks = stocksOf(assets);
  const stables = stablesOf(assets);
  const [objective, setObjective] = useState("");
  const [strategy, setStrategy] = useState("");
  const [exampleId, setExampleId] = useState<string | null>(null);
  const [assetKeys, setAssetKeys] = useState<string[]>([]);
  const [inputKey, setInputKey] = useState("");
  const [total, setTotal] = useState("10");
  const [perStep, setPerStep] = useState("2");
  const [maxSteps, setMaxSteps] = useState("5");
  const [days, setDays] = useState("30");
  const [trustTier, setTrustTier] = useState<"platform_only" | "agent_data" | "agent_research">("agent_data");
  const [watch, setWatch] = useState<string[]>(["MACRO_TIER1", "EARNINGS", "FED_SPEECH"]);
  const [regularOnly, setRegularOnly] = useState(false);
  const [impactPct, setImpactPct] = useState("1");
  const [mode, setMode] = useState<"SIMULATION" | "LIVE">("SIMULATION");
  const [balance, setBalance] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [nr, setNr] = useState<number | null>(null);
  const stable = assetByKey(stables, inputKey) ?? defaultStable(assets);
  const decimals = stable?.tokenDecimals ?? null;
  useEffect(() => { if (stocks.length && assetKeys.length === 0) setAssetKeys([stocks[0]!.assetKey]); }, [stocks, assetKeys.length]);
  // /start 「准备真实运行」交接过来的目标草稿：预填并切到真实模式
  useEffect(() => {
    const d = takeGoalDraft();
    if (!d) return;
    setObjective(d.objective); setStrategy(d.strategy); setExampleId(d.exampleId ?? null); setAssetKeys(d.assetKeys); setInputKey(d.inputAssetKey); setTotal(d.totalHuman); setPerStep(d.perStepHuman); setMaxSteps(String(d.maxSteps)); setDays(String(d.days)); setTrustTier(d.trustTier); setWatch(d.watch); setRegularOnly(d.regularOnly); setMode("LIVE");
  }, []);
  useEffect(() => {
    if (!valid || !stable) { setBalance(null); return; }
    let alive = true;
    balanceOf(stable.tokenAddress as `0x${string}`, owner as `0x${string}`).then((b) => alive && setBalance(b.toString())).catch(() => alive && setBalance(null));
    return () => { alive = false; };
  }, [valid, owner, stable]);
  const totalRaw = decimals !== null ? humanToRaw(total, decimals) : null;
  const perRaw = decimals !== null ? humanToRaw(perStep, decimals) : null;
  const stepsN = Number(maxSteps);
  const impactBps = /^\d+(\.\d+)?$/.test(impactPct.trim()) ? Math.round(Number(impactPct) * 100) : NaN;
  const daysN = Number(days);
  const local: Record<string, string> = {};
  if (!objective.trim()) local["objective"] = zh ? "写一句你要 agent 完成什么。" : "Say what the agent should accomplish.";
  if (assetKeys.length === 0) local["assets"] = zh ? "至少允许一只资产。" : "Allow at least one asset.";
  if (!totalRaw || BigInt(totalRaw) <= 0n) local["total"] = zh ? "总额要是正数。" : "Total must be positive.";
  if (!perRaw || BigInt(perRaw) <= 0n) local["perStep"] = zh ? "每笔上限要是正数。" : "Per-step cap must be positive.";
  else if (totalRaw && BigInt(perRaw) > BigInt(totalRaw)) local["perStep"] = zh ? "每笔上限不能超过总额。" : "Per-step cap cannot exceed the total.";
  if (!Number.isInteger(stepsN) || stepsN < 1 || stepsN > 1000) local["maxSteps"] = zh ? "1 到 1000 之间的整数。" : "An integer from 1 to 1000.";
  if (!Number.isInteger(daysN) || daysN < 1 || daysN > 365) local["days"] = zh ? "1 到 365 天。" : "1 to 365 days.";
  if (!Number.isInteger(impactBps) || impactBps < 1 || impactBps > 1000) local["impact"] = zh ? "请填 0.01 到 10 之间的百分比。" : "Enter a percentage between 0.01 and 10.";
  const err = (k: string) => (errs[k] ?? local[k]) ? <span className="ag-field-err" role="alert">{errs[k] ?? local[k]}</span> : null;

  async function submit() {
    setMsg(null);
    setErrs({});
    if (Object.keys(local).length || !valid || !stable) return setMsg(t("ag_fix_fields"));
    setBusy(true);
    const deadline = new Date(Date.now() + daysN * 86_400_000).toISOString();
    const body: CreateTaskBody = {
      clientRequestId: `web-goal-${Date.now()}`,
      ownerAddress: owner.toLowerCase(),
      mode,
      strategy: strategy.trim() || undefined,
      exampleId: exampleId ?? undefined,
      watchEvents: { kinds: watch },
      params: { policyId: "QUOTE_ONLY", maxPriceImpactBps: impactBps },
      scope: { objective: objective.trim().slice(0, 500), inputAssetKey: stable.assetKey, outputAssetKeys: assetKeys, budgetCapRaw: totalRaw!, perStepCapRaw: perRaw!, maxSteps: stepsN, deadline, trustTier, issuance: "agent", ...(regularOnly ? { hardConditions: [{ type: "session", allow: ["US_REGULAR"] }] } : {}) },
    };
    const r = await agentTasks.create(body).catch(() => null);
    setBusy(false);
    if (!r) return setMsg(t("ag_service_unreachable"));
    if (r.status === 400) {
      const fe = fieldErrors(r.data.details, locale);
      if (Object.keys(fe).length) { setErrs(fe); return setMsg(t("ag_fix_fields")); }
      return setMsg(apiError(r, locale));
    }
    if (notReady(r)) return setNr(r.status);
    if (r.status !== 201 && r.status !== 200) return setMsg(apiError(r, locale));
    router.push(`/agent/tasks/${r.data.task.id}`);
  }

  if (nr !== null) return <NotReady what="POST /v1/tasks" status={nr} />;
  const registryNote = assetsSource === "cache" ? t("ag_registry_cached") : assetsSource === "none" ? t("ag_registry_none") : null;
  const trustLabel = zh
    ? { platform_only: "只信 Chaconne 核验过的事实", agent_data: "也接受 agent 带来源的数据声明（标「agent 提供、未核验」，默认）", agent_research: "也接受 agent 的研究结论（同样标注）" }
    : { platform_only: "Only facts verified by Chaconne", agent_data: "Also sourced data claims from the agent (marked unverified; default)", agent_research: "Also the agent's research conclusions (marked likewise)" };
  return (
    <div className="space-y-4 ag-goal">
      {registryNote && <p className="ag-warn">{registryNote}{onRetryAssets && <> · <button type="button" className="underline" onClick={onRetryAssets}>{t("ag_retry")}</button></>}</p>}
      <section>
        <h3 className="text-base font-semibold">{zh ? "1 · 目标" : "1 · Objective"}</h3>
        <p className="ag-note">{zh ? "你希望 Agent 在接下来一段时间里，替你完成什么？" : "What should the agent accomplish for you over the coming period?"}</p>
        <textarea className="field mt-2 w-full" rows={2} maxLength={500} value={objective} placeholder={zh ? "例：未来五个交易日，寻找适合加仓 FAKEx 的机会" : "e.g. Over the next five trading days, look for chances to add to FAKEx"} onChange={(e) => setObjective(e.target.value)} aria-invalid={!!(errs["objective"] ?? local["objective"])} />
        {err("objective")}
      </section>
      <section>
        <h3 className="text-base font-semibold">{zh ? "2 · 策略（交给 Agent 理解与运用）" : "2 · Strategy (for the agent to understand and apply)"}</h3>
        <p className="ag-note">{zh ? "写你自己的研究方法、偏好、关注因素；也可以留空交给 Agent 制定。这段文字在签名之外，随时可改，改动留版本。下面的示例只是把一段话填进来，随便改。" : "Your own research method, preferences and factors; leave it empty to let the agent set it. This text is outside the signature, editable any time, versioned. The examples below only fill in a paragraph you can edit freely."}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {EXAMPLE_STRATEGIES.map((ex) => (
            <button key={ex.id} type="button" className={`ag-entry text-left ${exampleId === ex.id ? "ag-entry-on" : ""}`} aria-pressed={exampleId === ex.id} onClick={() => { setExampleId(ex.id); setStrategy(ex.text[locale]); setWatch(ex.watch); setTrustTier(ex.trustTier); setObjective((cur) => (cur.trim() ? cur : ex.objective[locale])); }}>
              <strong>{ex.title[locale]}</strong><span>{ex.space[locale]}</span>
            </button>
          ))}
        </div>
        <textarea className="field mt-2 w-full" rows={5} maxLength={4000} value={strategy} onChange={(e) => { setStrategy(e.target.value); if (exampleId && EXAMPLE_STRATEGIES.find((x) => x.id === exampleId)?.text[locale] !== e.target.value) setExampleId(null); }} placeholder={zh ? "留空 = 由 Agent 自己制定策略" : "Empty = the agent sets its own strategy"} />
        <div className="mt-2">
          <p className="text-sm">{zh ? "这些事件临近、到点或改期时叫醒 Agent（到点只是提醒它去核实实际值）" : "Wake the agent when these events approach, arrive or get rescheduled (arrival only tells it to verify the actual value)"}</p>
          <div className="mt-1 flex flex-wrap gap-3">{WATCH_KINDS.map((k) => <label key={k.id} className="ag-check"><input type="checkbox" checked={watch.includes(k.id)} onChange={(e) => setWatch((cur) => e.target.checked ? [...cur, k.id] : cur.filter((x) => x !== k.id))} /><span>{zh ? k.zh : k.en}</span></label>)}</div>
        </div>
      </section>
      <section>
        <h3 className="text-base font-semibold">{zh ? "3 · 授权范围（每次执行都必须满足；这是你签名的内容）" : "3 · Authorized scope (every execution must satisfy it; this is what you sign)"}</h3>
        <div className="ag-form mt-2">
          <div className="ag-span"><p className="text-sm">{zh ? "允许买入的资产" : "Assets the agent may buy"}</p><div className="mt-1 flex flex-wrap gap-3">{stocks.map((a) => <label key={a.assetKey} className="ag-check"><input type="checkbox" checked={assetKeys.includes(a.assetKey)} onChange={(e) => setAssetKeys((cur) => e.target.checked ? [...cur, a.assetKey] : cur.filter((k) => k !== a.assetKey))} /><span>{a.displaySymbol} · {a.underlyingId.split(":")[1]}</span></label>)}</div>{err("assets")}</div>
          <label>{t("ag_f_pay_with")}<select className="field" value={stable?.assetKey ?? ""} onChange={(e) => setInputKey(e.target.value)}>{stables.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol}</option>)}</select></label>
          <label>{zh ? "总额" : "Total budget"}{stable ? ` (${stable.displaySymbol})` : ""}<input className="field" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} aria-invalid={!!(errs["total"] ?? local["total"])} />{err("total")}<span className="ag-note">{balance && stable ? `${t("ag_balance")} ${formatAmount(balance, stable.tokenDecimals, stable.displaySymbol)}` : ""}</span></label>
          <label>{zh ? "每笔上限" : "Per-step cap"}{stable ? ` (${stable.displaySymbol})` : ""}<input className="field" inputMode="decimal" value={perStep} onChange={(e) => setPerStep(e.target.value)} aria-invalid={!!(errs["perStep"] ?? local["perStep"])} />{err("perStep")}</label>
          <label>{zh ? "最多几笔" : "Max steps"}<input className="field" inputMode="numeric" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} aria-invalid={!!local["maxSteps"]} />{err("maxSteps")}</label>
          <label>{zh ? "期限（天）" : "Deadline (days)"}<input className="field" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} aria-invalid={!!local["days"]} />{err("days")}</label>
          <label>{zh ? "最大价格冲击 (%)" : "Max price impact (%)"}<input className="field" inputMode="decimal" value={impactPct} onChange={(e) => setImpactPct(e.target.value)} aria-invalid={!!local["impact"]} />{err("impact")}</label>
          <label>{zh ? "信任档位" : "Trust tier"}<select className="field" value={trustTier} onChange={(e) => setTrustTier(e.target.value as typeof trustTier)}>{(["platform_only", "agent_data", "agent_research"] as const).map((k) => <option key={k} value={k}>{trustLabel[k]}</option>)}</select><span className="ag-note">{zh ? "决定 agent 提交决策时能拿什么当依据；硬约束与每笔核验永远由平台做。" : "What the agent may cite in a decision; hard constraints and per-trade checks are always done by the platform."}</span></label>
          <label>{t("ag_f_mode")}<select className="field" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="SIMULATION">{t("ag_mode_sim_opt")}</option><option value="LIVE">{t("ag_mode_live_opt")}</option></select></label>
          <div className="ag-span"><label className="ag-check"><input type="checkbox" checked={regularOnly} onChange={(e) => setRegularOnly(e.target.checked)} /><span>{zh ? "硬约束：只在美股常规时段执行（写进签名）" : "Hard constraint: only during US regular hours (signed)"}</span></label></div>
          <OwnerField owner={owner} connected={connected} />
        </div>
      </section>
      <div className="ag-actions">
        <button className="btn" disabled={busy || !valid || !stable || Object.keys(local).length > 0} onClick={submit}>{busy ? t("ag_creating") : mode === "SIMULATION" ? (zh ? "创建 Agent 任务（模拟）" : "Create agent task (simulation)") : (zh ? "创建 Agent 任务（真实）" : "Create agent task (live)")}</button>
        <ModeTag mode={mode} />
        {mode === "LIVE" && !connected && <Pill tone="warn">{zh ? "真实任务需要 owner 钱包签授权" : "A live task needs the owner wallet to sign"}</Pill>}
      </div>
      <p className="ag-note">{zh ? "建好后：真实任务先签一次授权（范围）；然后你的 Agent 用 MCP 工具接管（report_agent_status accepted）、被唤醒、研究、提交交易意图。没有交易也是一轮完整决策。" : "After creation: a live task needs one signature (the scope); then your agent takes over via MCP (report_agent_status accepted), gets woken, researches and submits trade intents. A round with no trade is still a complete decision."}</p>
      {msg && <p className="text-sm text-bad" role="alert">{msg}</p>}
    </div>
  );
}
