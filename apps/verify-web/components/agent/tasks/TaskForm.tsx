"use client";
/**
 * 建任务表单：首页「帮我安排买入」与「第一分钟」共用这一份。
 * 字段：资产 / 模板 / 次数 / 支付币种 / 每次金额 / 核验策略 / 最大价格冲击 / 只在常规时段（可选）/ 模式；
 * 折叠的「授权范围」（CV-D16）：目标描述 / 还允许买入 / 信任档位 / 签发方式 / 允许卖出——签名只覆盖范围，计划可改不重签。
 * 钱包账户化：owner 只来自已连接的钱包。提交前做与服务端同名的参数校验；400 invalid_playbook_params 映射成字段级提示。
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Condition } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { agentTasks, notReady, type TaskCreated } from "@/lib/api-v2";
import { apiError, fieldErrors, fieldErrorText } from "@/lib/errors";
import { formatAmount, humanToRaw } from "@/lib/format";
import { balanceOf } from "@/lib/wallet";
import { assetByKey, defaultStable, stablesOf, stocksOf, type AssetEntry } from "@/lib/assets";
import { conditionText } from "@/lib/conditions";
import { Pill } from "@/components/ui";
import { ModeTag, NotReady, OwnerField, useOwnerInput } from "../shared";
import { SAMPLES, needsReference, sampleById, sampleForPlaybook } from "../home/entries";
import { amountParamOf, buildTaskBody, defaultPerStep, validateDraft, type DraftField, type TaskDraft } from "./taskDraft";

const SESSION_RULE: Condition = { type: "session", allow: ["US_REGULAR"] };
const POLICIES = ["QUOTE_ONLY", "REFERENCE_CONTEXT", "STRICT_LIVE"] as const;

export function TaskForm({ assets, assetsSource, onRetryAssets, preset, modeLock, onCreated }: {
  assets: AssetEntry[];
  assetsSource?: "live" | "cache" | "none";
  onRetryAssets?: () => void;
  preset?: Partial<TaskDraft>;
  /** 无钱包体验入口固定模拟，预填草案不能覆盖；其它入口仍可选模式。 */
  modeLock?: "SIMULATION";
  /** 给了就不跳转（第一分钟在原地显示结果） */
  onCreated?: (v: TaskCreated) => void;
}) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const { owner, connected, valid } = useOwnerInput();
  const stocks = stocksOf(assets);
  const stables = stablesOf(assets);
  const [sampleId, setSampleId] = useState(() => (preset?.playbookId && sampleForPlaybook(preset.playbookId)?.id) ?? SAMPLES[0]!.id);
  const sample = sampleById(sampleId) ?? SAMPLES[0]!;
  const playbookId = sample.playbookId;
  const [outputKey, setOutputKey] = useState(preset?.outputAssetKey ?? "");
  const [inputKey, setInputKey] = useState(preset?.inputAssetKey ?? "");
  const [steps, setSteps] = useState(String(preset?.steps ?? sample.steps));
  const [amountState, setAmountState] = useState({ value: preset?.perStepHuman ?? "1", touched: !!preset?.perStepHuman });
  const { value: amount, touched: amountTouched } = amountState;
  const [selectedMode, setMode] = useState<"SIMULATION" | "LIVE">(preset?.mode ?? "SIMULATION");
  const mode = modeLock ?? selectedMode;
  const [policyId, setPolicyId] = useState<TaskDraft["policyId"]>(preset?.policyId ?? sample.policyId ?? "QUOTE_ONLY");
  const [impactPct, setImpactPct] = useState(preset?.maxPriceImpactBps !== undefined ? String(preset.maxPriceImpactBps / 100) : "1");
  const [regularOnly, setRegularOnly] = useState(!!preset?.regularSessionOnly);
  const [custom, setCustom] = useState(preset?.conditions ?? null);
  // 授权范围（CV-D16）：签名只覆盖这些；模板参数与计划条件在签名之外可改
  const [objective, setObjective] = useState(preset?.objective ?? "");
  const [extraKeys, setExtraKeys] = useState<string[]>(preset?.extraAssetKeys ?? []);
  const [trustTier, setTrustTier] = useState<NonNullable<TaskDraft["trustTier"]>>(preset?.trustTier ?? "platform_only");
  const [issuance, setIssuance] = useState<NonNullable<TaskDraft["issuance"]>>(preset?.issuance ?? "auto");
  const [allowSell, setAllowSell] = useState(!!preset?.allowSell);
  const [scopeOpen, setScopeOpen] = useState(!!(preset?.objective || preset?.trustTier || preset?.issuance || preset?.allowSell || preset?.extraAssetKeys?.length));
  const [balance, setBalance] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "ok"; raw: string } | { kind: "unknown" }>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [errs, setErrs] = useState<Partial<Record<string, string>>>({});
  const [nr, setNr] = useState<number | null>(null);

  // 预填变化（一句话编译 / 草案）→ 覆盖表单。按内容比较（不按对象身份）：父组件每次渲染新建 preset 对象时不能把用户已改的字段冲掉
  const presetKey = JSON.stringify(preset ?? null);
  useEffect(() => {
    if (!preset) return;
    if (preset.playbookId) { const s = sampleForPlaybook(preset.playbookId); if (s) setSampleId(s.id); }
    if (preset.outputAssetKey) setOutputKey(preset.outputAssetKey);
    if (preset.inputAssetKey) setInputKey(preset.inputAssetKey);
    if (preset.steps) setSteps(String(preset.steps));
    if (preset.perStepHuman) setAmountState({ value: preset.perStepHuman, touched: true });
    if (preset.mode) setMode(preset.mode);
    if (preset.policyId) setPolicyId(preset.policyId);
    if (preset.maxPriceImpactBps !== undefined) setImpactPct(String(preset.maxPriceImpactBps / 100));
    if (preset.regularSessionOnly !== undefined) setRegularOnly(preset.regularSessionOnly);
    if (preset.conditions) setCustom(preset.conditions.filter((c) => c.type !== "session"));
    if (preset.objective !== undefined) setObjective(preset.objective);
    if (preset.extraAssetKeys) setExtraKeys(preset.extraAssetKeys);
    if (preset.trustTier) setTrustTier(preset.trustTier);
    if (preset.issuance) setIssuance(preset.issuance);
    if (preset.allowSell !== undefined) setAllowSell(preset.allowSell);
  }, [presetKey]); // 依赖只有内容键：preset 对象本身每次渲染可能是新的

  const stock = assetByKey(stocks, outputKey) ?? stocks[0] ?? null;
  const stable = assetByKey(stables, inputKey) ?? defaultStable(assets);
  const baseConditions = custom ?? sample.conditions;
  const conditions = regularOnly ? [SESSION_RULE, ...baseConditions.filter((c) => c.type !== "session")] : baseConditions.filter((c) => c.type !== "session");
  const stepsN = Number(steps) || 0;
  const perStep = amountParamOf(playbookId) === "perStepAmountRaw";
  const multipleSteps = stepsN > 1;
  const effectiveOwner = valid ? owner : "";
  const decimals = stable?.tokenDecimals ?? null;
  // V-49：价格类条件的判断取每步核验报告里的参考价，QUOTE_ONLY 不产出参考价 → 永远等待；这类条件下不提供 QUOTE_ONLY
  const referenceNeeded = needsReference(conditions);
  const effectivePolicy: TaskDraft["policyId"] = referenceNeeded && policyId === "QUOTE_ONLY" ? "STRICT_LIVE" : policyId;
  const impactBps = /^\d+(\.\d+)?$/.test(impactPct.trim()) ? Math.round(Number(impactPct) * 100) : NaN;
  const impactError = !Number.isInteger(impactBps) || impactBps < 1 || impactBps > 1000 ? (zh ? "请填 0.01 到 10 之间的百分比。" : "Enter a percentage between 0.01 and 10.") : null;

  // 余额（只读 RPC，不弹窗）：用于默认金额与提示；读不到写「未知」，不当作 0
  useEffect(() => {
    if (!valid || !stable) { setBalance({ kind: "idle" }); return; }
    let alive = true;
    setBalance({ kind: "busy" });
    balanceOf(stable.tokenAddress as `0x${string}`, owner as `0x${string}`)
      .then((b) => alive && setBalance({ kind: "ok", raw: b.toString() }))
      .catch(() => alive && setBalance({ kind: "unknown" }));
    return () => { alive = false; };
  }, [valid, owner, stable]);
  useEffect(() => {
    if (!stable) return;
    const next = balance.kind === "ok" ? defaultPerStep(balance.raw, stable.tokenDecimals, perStep ? stepsN : 1)
      : balance.kind === "unknown" || balance.kind === "idle" ? "1" : null;
    // Preset and balance effects may share a render; read the latest combined state.
    if (next !== null) setAmountState((current) => current.touched || current.value === next ? current : { ...current, value: next });
  }, [balance, stable, stepsN, perStep, amountTouched]);

  const rawAmount = decimals !== null ? humanToRaw(amount, decimals) : null;
  // amountRaw 也是每次金额；累计预算按实际步数计算，不由请求字段名决定。
  const total = useMemo(() => (rawAmount && decimals !== null && Number.isInteger(stepsN) && stepsN > 0 ? formatAmount((BigInt(rawAmount) * BigInt(stepsN)).toString(), decimals, stable?.displaySymbol) : "—"), [rawAmount, decimals, stepsN, stable]);
  const draft: TaskDraft = { playbookId, outputAssetKey: stock?.assetKey ?? "", inputAssetKey: stable?.assetKey ?? "", steps: stepsN, perStepHuman: amount, mode, conditions, maxPremiumBps: 30, policyId: effectivePolicy, maxPriceImpactBps: Number.isInteger(impactBps) ? impactBps : undefined, regularSessionOnly: regularOnly, objective: objective.trim() || undefined, extraAssetKeys: extraKeys.filter((k) => k !== (stock?.assetKey ?? "")), trustTier, issuance, allowSell };
  const otherStocks = stocks.filter((a) => a.assetKey !== stock?.assetKey);
  const trustLabel: Record<NonNullable<TaskDraft["trustTier"]>, string> = zh
    ? { platform_only: "只信 Chaconne 核验过的事实（默认）", agent_data: "也接受 agent 带来源的数据声明（标「agent 提供、未核验」）", agent_research: "也接受 agent 的研究结论（同样标注）" }
    : { platform_only: "Only facts verified by Chaconne (default)", agent_data: "Also accept sourced data claims from the agent (marked as unverified)", agent_research: "Also accept the agent's research conclusions (marked likewise)" };

  async function submit() {
    setMsg(null);
    const pre = validateDraft(draft, effectiveOwner, decimals);
    if (impactError) pre.maxPriceImpactBps = "expected_integer_in_range";
    if (Object.keys(pre).length) return setErrs(Object.fromEntries(Object.entries(pre).map(([k, v]) => [k, fieldErrorText(v!, locale)])));
    setErrs({});
    setBusy(true);
    const r = await agentTasks.create(buildTaskBody(draft, effectiveOwner, decimals!, `web-${Date.now()}`)).catch(() => null);
    setBusy(false);
    if (!r) return setMsg(t("ag_service_unreachable"));
    if (r.status === 400) {
      const fe = fieldErrors(r.data.details, locale);
      if (Object.keys(fe).length) { setErrs(fe); return setMsg(t("ag_fix_fields")); }
      return setMsg(apiError(r, locale));
    }
    if (notReady(r)) return setNr(r.status);
    if (r.status !== 201 && r.status !== 200) return setMsg(apiError(r, locale));
    if (onCreated) onCreated(r.data);
    else router.push(`/agent/tasks/${r.data.task.id}`);
  }

  const err = (f: DraftField) => (errs[f] ? <span className="ag-field-err" role="alert">{errs[f]}</span> : null);
  if (nr !== null) return <NotReady what="POST /v1/tasks" status={nr} />;
  const registryNote = assetsSource === "cache" ? t("ag_registry_cached") : assetsSource === "none" ? t("ag_registry_none") : null;
  const policyLabel: Record<(typeof POLICIES)[number], string> = zh
    ? { QUOTE_ONLY: "只核对报价与冲击（24 小时可执行，默认）", REFERENCE_CONTEXT: "另比对最近收盘价（偏离过大则不买）", STRICT_LIVE: "要求实时参考价（只在美股常规时段）" }
    : { QUOTE_ONLY: "Quote and impact only (executes any hour, default)", REFERENCE_CONTEXT: "Also compare with the latest close (skip if it deviates too much)", STRICT_LIVE: "Require a live reference (US regular hours only)" };
  return (
    <div className="space-y-3">
      <p className="ag-note">{zh ? "这是固定自动化：平台按下面的规则自己签发每一步，agent 只负责执行。你的 agent 有自己的策略时，用「把目标交给 Agent」。" : "This is fixed automation: the platform issues each step by the rules below; the agent only executes. If your agent has its own strategy, use “Hand a goal to your agent”."}</p>
      {registryNote && <p className="ag-warn">{registryNote}{onRetryAssets && <> · <button type="button" className="underline" onClick={onRetryAssets}>{t("ag_retry")}</button></>}</p>}
      <div className="ag-form">
        <label>{t("ag_f_asset")}<select className="field" value={stock?.assetKey ?? ""} onChange={(e) => setOutputKey(e.target.value)} aria-invalid={!!errs["outputAssetKey"]}>{stocks.length === 0 && <option value="">—</option>}{stocks.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol} · {a.underlyingId.split(":")[1]}</option>)}</select>{err("outputAssetKey")}</label>
        <label>{t("ag_f_playbook")}<select className="field" value={sampleId} onChange={(e) => { const s = sampleById(e.target.value); if (!s) return; setSampleId(s.id); setCustom(null); setSteps(String(s.steps)); setPolicyId(s.policyId ?? "QUOTE_ONLY"); }}>{SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.title[locale]}</option>)}</select></label>
        <label>{zh ? "分几次买" : "Number of purchases"}<input className="field" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} aria-invalid={!!errs["steps"]} />{err("steps")}<span className="ag-note">{zh ? "总预算会分成这么多次，每次一笔链上买入；1 = 一次买完。" : "The budget is split into this many on-chain purchases; 1 = buy everything at once."}</span></label>
        <label>{t("ag_f_pay_with")}<select className="field" value={stable?.assetKey ?? ""} onChange={(e) => { setInputKey(e.target.value); setAmountState((current) => ({ ...current, touched: false })); }} aria-invalid={!!errs["inputAssetKey"]}>{stables.length === 0 && <option value="">—</option>}{stables.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol}</option>)}</select>{err("inputAssetKey")}</label>
        <label>{multipleSteps ? t("ag_f_per_step") : t("ag_f_amount_total")}{stable ? ` (${stable.displaySymbol})` : ""}<input className="field" inputMode="decimal" value={amount} onChange={(e) => { setAmountState({ value: e.target.value, touched: true }); }} aria-invalid={!!errs["perStepAmountRaw"]} />{err("perStepAmountRaw")}
          <span className="ag-note">{balance.kind === "busy" ? t("ag_balance_loading") : balance.kind === "ok" && stable ? `${t("ag_balance")} ${formatAmount(balance.raw, stable.tokenDecimals, stable.displaySymbol)}` : balance.kind === "unknown" ? t("ag_balance_unknown") : ""}{multipleSteps ? ` · ${zh ? `最多 ${stepsN} 次，累计上限 ${total}` : `Up to ${stepsN} steps, ${total} maximum in total`}` : ""}</span>
        </label>
        <label>{zh ? "每笔交易的核验策略" : "Verification policy per trade"}<select className="field" value={effectivePolicy} onChange={(e) => setPolicyId(e.target.value as TaskDraft["policyId"])}>{POLICIES.filter((p) => !(referenceNeeded && p === "QUOTE_ONLY")).map((p) => <option key={p} value={p}>{policyLabel[p]}</option>)}</select><span className="ag-note">{referenceNeeded ? (zh ? "这个模板的价格条件需要参考价来判断，所以每一步都要带参考价核验；只核对报价的策略在这里不可选。" : "This template's price condition needs a reference price, so every step verifies with one; the quote-only policy is not available here.") : (zh ? "每一步买入前都用工具箱里同一套核验引擎检查路由、报价与价格冲击；策略决定是否还要参考价。" : "Every step runs the same verification engine as the toolbox (route, quote, price impact); the policy decides whether a reference price is also required.")}</span></label>
        <label>{zh ? "最大价格冲击 (%)" : "Max price impact (%)"}<input className="field" inputMode="decimal" value={impactPct} onChange={(e) => setImpactPct(e.target.value)} aria-invalid={!!impactError} />{impactError ? <span className="ag-field-err" role="alert">{impactError}</span> : err("maxPriceImpactBps")}<span className="ag-note">{zh ? "流动性不足、这笔买入会把价格推高超过这个比例时，这一步不买。这是唯一的硬性拦截。" : "If liquidity is thin and this purchase would move the price more than this, the step is skipped. This is the only hard stop."}</span></label>
        {modeLock ? <div><p>{t("ag_f_mode")}</p><p className="ag-note mt-2">{t("ag_mode_sim_opt")}</p></div> : <label>{t("ag_f_mode")}<select className="field" value={mode} onChange={(e) => setMode(e.target.value as "SIMULATION" | "LIVE")}><option value="SIMULATION">{t("ag_mode_sim_opt")}</option><option value="LIVE">{t("ag_mode_live_opt")}</option></select></label>}
        <div className="ag-span"><label className="ag-check"><input type="checkbox" checked={regularOnly} onChange={(e) => setRegularOnly(e.target.checked)} /><span>{zh ? "只在美股常规时段（北京时间 23:30–06:00）执行" : "Only during US regular hours"}</span></label><span className="ag-note">{zh ? "链上股票 24 小时可交易，默认不限制。" : "On-chain stocks trade around the clock; off by default."}</span></div>
        <OwnerField owner={owner} connected={connected} />
        {err("ownerAddress")}
      </div>
      <details className="ag-scope" open={scopeOpen} onToggle={(e) => setScopeOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-sm font-semibold">{zh ? "授权范围（签名只覆盖这些）" : "Authorized scope (only this is signed)"}</summary>
        <p className="ag-note mt-1">{zh ? "你签的是一个范围：允许的资产、总额、每笔上限、次数、期限、硬约束。上面的分几次买、时段、间隔这些是计划，在范围内可以改、不用重签；范围本身不能改，要放宽就建新任务。" : "You sign a scope: allowed assets, total budget, per-step cap, steps, deadline and hard constraints. The plan above (purchases, hours, spacing) lives inside it and can change without re-signing; the scope itself cannot change — create a new task to widen it."}</p>
        <div className="ag-form mt-2">
          <label className="ag-span">{zh ? "目标描述（给 agent 看）" : "Objective (for the agent)"}<textarea className="field" rows={2} maxLength={500} value={objective} placeholder={sample.title[locale]} onChange={(e) => setObjective(e.target.value)} /></label>
          {otherStocks.length > 0 && <div className="ag-span"><p className="text-sm">{zh ? "还允许买入" : "Also allowed to buy"}</p><div className="flex flex-wrap gap-3 mt-1">{otherStocks.slice(0, 7).map((a) => <label key={a.assetKey} className="ag-check"><input type="checkbox" checked={extraKeys.includes(a.assetKey)} onChange={(e) => setExtraKeys((cur) => e.target.checked ? [...cur, a.assetKey] : cur.filter((k) => k !== a.assetKey))} /><span>{a.displaySymbol}</span></label>)}</div><span className="ag-note">{zh ? "计划里买的是上面选的资产；勾了的资产 agent 才能提出改买。" : "The plan buys the asset chosen above; the agent may propose the checked ones instead."}</span></div>}
          <label>{zh ? "信任档位" : "Trust tier"}<select className="field" value={trustTier} onChange={(e) => setTrustTier(e.target.value as NonNullable<TaskDraft["trustTier"]>)}>{(["platform_only", "agent_data", "agent_research"] as const).map((k) => <option key={k} value={k}>{trustLabel[k]}</option>)}</select><span className="ag-note">{zh ? "决定 agent 提交交易决策时能拿什么当依据；硬约束永远由平台核验。" : "What the agent may cite when it submits a decision; hard constraints are always verified by the platform."}</span></label>
          <label>{zh ? "谁来签发每一步" : "Who issues each step"}<select className="field" value={issuance} onChange={(e) => setIssuance(e.target.value as NonNullable<TaskDraft["issuance"]>)}><option value="auto">{zh ? "平台按计划条件签发（默认）" : "Platform, by the plan conditions (default)"}</option><option value="agent">{zh ? "只在 agent 提交交易意图后签发" : "Only after the agent submits a trade intent"}</option></select></label>
          {/* 卖出通路尚未闭环：入口先隐藏（allowSell 仍在草稿里，供 API 调用方使用） */}
          {allowSell && <div className="ag-span"><label className="ag-check"><input type="checkbox" checked={allowSell} onChange={(e) => setAllowSell(e.target.checked)} /><span>{zh ? "允许 agent 提出卖出" : "Allow the agent to propose selling"}</span></label></div>}
        </div>
      </details>
      <p className="ag-note">{sample.what[locale]}</p>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{t("ag_conditions")} · {conditions.length}</p>
        <ul className="ag-list text-xs">{conditions.map((c, i) => <li key={i}>{conditionText(c, locale)}</li>)}</ul>
      </div>
      <div className="ag-actions">
        <button className="btn" disabled={busy || !stock || !stable || !valid || !!impactError} onClick={submit}>{busy ? t("ag_creating") : mode === "SIMULATION" ? t("ag_create_sim") : t("ag_create_live")}</button>
        <ModeTag mode={mode} />
        {mode === "LIVE" && !connected && <Pill tone="warn">{zh ? "真实任务需要 owner 钱包签授权" : "A live task needs the owner wallet to sign"}</Pill>}
      </div>
      {msg && <p className="text-sm text-bad" role="alert">{msg}</p>}
      {stocks.length === 0 && assetsSource !== "none" && <p className="ag-note"><Link className="underline" href="/developers">{zh ? "登记表里没有可执行的股票资产" : "No executable stock asset in the registry"}</Link></p>}
    </div>
  );
}
