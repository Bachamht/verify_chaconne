"use client";
/** /plan：三问式规划表单 → 候选表 → 接受部分完成 / 保留目标等待 / 创建任务（授权）。 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { PlanCandidate, PlanGoal, PlanNextStep, PolicyId } from "@chaconne/core/verify";
import { api, type AssetsResponse } from "@/lib/api";
import { plans, templates, type PlanView, type TemplateView } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { reasonText } from "@/lib/reasons";
import { Card, Pill, Row } from "@/components/ui";
import { balanceOf, connect } from "@/lib/wallet";
import { fmtAmount } from "@/lib/format.execute";
import { tx } from "@/lib/i18n.execute";
import { MandateBuilder } from "@/components/MandateBuilder";
import { addressProblem, blockingSummary, fmtLocal, isAddress, nextStepText, tzLabel } from "@/lib/format";
import { useMounted } from "@/lib/useMounted";
import { apiError } from "@/lib/errors";
import { walletErrorText } from "@/lib/i18n.execute";
import { remember } from "@/lib/history";

const POLICIES: PolicyId[] = ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"];
const NEXT_TONE: Record<PlanNextStep, "ok" | "warn" | "bad" | "neutral"> = { READY: "ok", ACCEPT_PARTIAL: "warn", SWITCH_INPUT: "warn", WAIT_CONDITION: "neutral", PROVIDE_DATA: "neutral", USER_MUST_RELAX_LIMIT: "bad" };

export function PlanClient() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const sp = useSearchParams();
  const zh = locale === "zh";
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [owner, setOwner] = useState("");
  const account = useAccount();
  useEffect(() => {
    if (account && !owner) {
      setOwner(account);
      setConnected(account);
    }
  }, [account]);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [legs, setLegs] = useState<Array<{ outputAssetKey: string; weightBps: number }>>([{ outputAssetKey: "", weightBps: 10000 }]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [budget, setBudget] = useState("10");
  const [policy, setPolicy] = useState("STRICT_LIVE");
  const [slippage, setSlippage] = useState(50);
  const [impact, setImpact] = useState(100);
  const [deviation, setDeviation] = useState(300);
  // 水合安全：服务端不渲染任何依赖当前时刻/时区的值，挂载后再填
  const mounted = useMounted();
  const [deadline, setDeadline] = useState("");
  useEffect(() => {
    if (!deadline) setDeadline(new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 16));
  }, [deadline]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [tpl, setTpl] = useState<TemplateView | null>(null);
  const [mandateFor, setMandateFor] = useState<PlanCandidate[] | null>(null);
  /** 三策略对照：选中的策略驱动候选表的结论与阻断列（null = 规划时所选策略） */
  const [viewPolicy, setViewPolicy] = useState<PolicyId | null>(null);
  /** 提交前查余额（V-44）：不足时给出「钱包里只有 X，预算 Y」并可一键改按余额规划 */
  const [shortfall, setShortfall] = useState<{ balanceHuman: string; balanceRaw: string } | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);

  const [connected, setConnected] = useState<string | null>(null);
  // 资产只加载一次；默认值只在表单尚未填写时设置（V-08：规划后不再把篮子重置回默认）
  useEffect(() => {
    api<AssetsResponse>("GET", "v1/assets").then((r) => {
      if (r.status !== 200) return;
      setAssets(r.data);
      const stables = r.data.assets.filter((a) => a.role === "stable_input").map((a) => a.assetKey);
      const stock = r.data.assets.find((a) => a.role === "stock_output" && a.executionAllowed);
      setInputs((cur) => (cur.length === 0 ? stables.slice(0, 1) : cur));
      setLegs((cur) => (cur.length === 1 && !cur[0]?.outputAssetKey && stock ? [{ outputAssetKey: stock.assetKey, weightBps: 10000 }] : cur));
    });
  }, []);
  useEffect(() => {
    const tid = sp.get("template");
    if (tid) templates.get(tid).then((r) => r.status === 200 && setTpl(r.data));
    const pid = sp.get("plan");
    if (pid) setPlan((cur) => (cur?.planId === pid ? cur : cur)); // 不清空
    if (pid) plans.get(pid).then((r) => r.status === 200 && setPlan((cur) => (cur?.planId === r.data.planId ? cur : r.data)));
  }, [sp]);
  // 翻创：只预填结构（资产/策略/限额），不带金额、钱包（C-03）
  useEffect(() => {
    if (!tpl) return;
    const s = tpl.structure;
    setSide(s.side);
    setLegs(s.legs);
    setInputs(s.inputAssetKeys);
    setPolicy(s.policyId);
    setSlippage(s.maxSlippageBps);
    setImpact(s.maxPriceImpactBps ?? 100);
    setDeviation(s.maxReferenceDeviationBps ?? 300);
  }, [tpl]);

  const stableAssets = useMemo(() => assets?.assets.filter((a) => a.role === "stable_input") ?? [], [assets]);
  const stockAssets = useMemo(() => assets?.assets.filter((a) => a.role === "stock_output") ?? [], [assets]);
  const payAssets = side === "buy" ? stableAssets : stockAssets;
  const legAssets = side === "buy" ? stockAssets : stableAssets;
  const primary = useMemo(() => assets?.assets.find((a) => a.assetKey === inputs[0]), [assets, inputs]);
  const budgetRaw = useMemo(() => {
    if (!primary || !/^\d+(\.\d+)?$/.test(budget)) return null;
    const [i, f = ""] = budget.split(".");
    return BigInt(i + (f + "0".repeat(primary.tokenDecimals)).slice(0, primary.tokenDecimals)).toString();
  }, [budget, primary]);
  const weightSum = legs.reduce((n, l) => n + l.weightBps, 0);
  const emptyRow = legs.findIndex((l) => !l.outputAssetKey);
  const ownerProblem = addressProblem(owner, connected, locale);
  const disabledWhy = !owner.trim() ? t("why_owner") : ownerProblem ? t("why_owner_invalid") : emptyRow !== -1 ? t("plan_row_no_asset", { n: emptyRow + 1 }) : weightSum !== 10000 ? t("plan_weights_sum", { x: (weightSum / 100).toFixed(1) }) : inputs.length === 0 ? t("why_inputs") : !budgetRaw ? t("why_budget") : null;

  async function run(opts: { budgetRaw?: string } = {}) {
    setErr(null);
    setShortfall(null);
    const useBudgetRaw = opts.budgetRaw ?? budgetRaw;
    if (!useBudgetRaw || useBudgetRaw === "0") return setErr(t("why_budget"));
    if (!isAddress(owner)) return setErr(t("why_owner_invalid"));
    if (emptyRow !== -1) return setErr(t("plan_row_no_asset", { n: emptyRow + 1 }));
    if (weightSum !== 10000) return setErr(t("plan_weights_sum", { x: (weightSum / 100).toFixed(1) }));
    // 余额检查：读不到（RPC 故障等）不拦，链上读到确实不够才拦
    if (primary && /^0x[0-9a-fA-F]{40}$/.test(primary.tokenAddress)) {
      setCheckingBalance(true);
      try {
        const balRaw = await balanceOf(primary.tokenAddress as `0x${string}`, owner.trim() as `0x${string}`);
        if (balRaw < BigInt(useBudgetRaw)) {
          const balanceHuman = fmtAmount(balRaw, primary.tokenDecimals, primary.displaySymbol);
          setShortfall({ balanceHuman, balanceRaw: balRaw.toString() });
          setErr(tx(locale, "plan_balance_short", { balance: balanceHuman, budget: fmtAmount(useBudgetRaw, primary.tokenDecimals, primary.displaySymbol) }));
          return;
        }
      } catch {
        /* 读不到余额：不当成 0，也不拦 */
      } finally {
        setCheckingBalance(false);
      }
    }
    setBusy(true);
    try {
      const goal: PlanGoal & { clientRequestId: string } = {
        clientRequestId: `web-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ownerAddress: owner.trim() as `0x${string}`,
        recipientAddress: owner.trim() as `0x${string}`,
        executionChainId: assets?.chainId ?? 196,
        legs,
        budget: { inputAssetKeys: inputs, amountInRaw: useBudgetRaw },
        side,
        policyId: policy as PlanGoal["policyId"],
        policyVersion: "1.1.0",
        maxSlippageBps: slippage,
        maxPriceImpactBps: impact,
        maxReferenceDeviationBps: policy === "QUOTE_ONLY" ? null : deviation,
        deadline: new Date(deadline).toISOString(),
      };
      const r = await plans.create(goal);
      if (r.status === 200 || r.status === 201) {
        setPlan(r.data);
        remember({ kind: "plan", id: r.data.planId, title: `${side === "buy" ? (zh ? "买" : "Buy") : zh ? "卖" : "Sell"} ${legs.map((l) => sym(l.outputAssetKey)).join("+")} · ${budget} ${primary?.displaySymbol ?? ""} · ${policy}`, owner: owner.trim() });
        router.replace(`/plan?plan=${r.data.planId}`);
      } else setErr(apiError(r, locale));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function acceptPartial(c: PlanCandidate) {
    if (!plan) return;
    setBusy(true);
    const r = await plans.toJob(plan.planId, c.candidateId);
    setBusy(false);
    if (r.status === 200 || r.status === 201) {
      remember({ kind: "job", id: r.data.jobId, title: `${zh ? "部分完成" : "Partial"} ${sym(plan.goal.legs[c.legIndex]?.outputAssetKey ?? "")} · ${fmtAmount(c.amountInRaw, dec(c.inputAssetKey), sym(c.inputAssetKey))}`, owner: owner.trim() });
      router.push(`/jobs/${r.data.jobId}`);
    } else setErr(apiError(r, locale));
  }

  const report = plan?.report ?? null;
  const sym = (key: string) => assets?.assets.find((a) => a.assetKey === key)?.displaySymbol ?? key.slice(-6);
  const dec = (key: string) => assets?.assets.find((a) => a.assetKey === key)?.tokenDecimals ?? 6;

  if (mandateFor && plan) return <MandateBuilder plan={plan} candidates={mandateFor} assets={assets} onBack={() => setMandateFor(null)} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("plan_h")}</h1>
        {plan && <Pill tone={plan.evidenceMode === "LIVE" ? "ok" : "warn"}>{plan.evidenceMode}</Pill>}
        {plan && <span className="mono ml-auto text-xs text-fg-3">{plan.planId}</span>}
      </div>
      {tpl && (
        <p className="text-sm text-fg-2">
          {t("remix_credit")} <span className="text-neutral-200">{tpl.authorName ?? tpl.templateId}</span> · {t("remix_note")}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t("plan_q1")}>
          <div className="space-y-3 text-sm">
            <div className="flex gap-2">
              {(["buy", "sell"] as const).map((s) => (
                <button key={s} className={`px-3 py-1 ${side === s ? "btn" : "btn-ghost"}`} onClick={() => { setSide(s); setInputs([]); setLegs([{ outputAssetKey: "", weightBps: 10000 }]); }}>{t(s === "buy" ? "plan_side_buy" : "plan_side_sell")}</button>
              ))}
            </div>
            <span className="text-fg-2">{t("plan_legs")}</span>
            {legs.map((l, i) => (
              <div key={i} className="flex gap-2">
                <select className="field" value={l.outputAssetKey} onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, outputAssetKey: e.target.value } : x)))}>
                  <option value="">—</option>
                  {legAssets.map((a) => {
                    const off = a.role === "stock_output" && !a.executionAllowed;
                    return (
                      <option key={a.assetKey} value={a.assetKey} disabled={off}>{a.displaySymbol}{a.role === "stock_output" ? ` (${a.underlyingId.split(":")[1]})` : ""} · {a.tokenAddress.slice(0, 8)}…{off ? ` · ${t("not_enabled")}` : ""}</option>
                    );
                  })}
                </select>
                <label className="flex items-center gap-1 text-xs text-fg-2">
                  <input className="field mono w-24 shrink-0" type="number" min={0.1} max={100} step={0.1} value={(l.weightBps / 100).toFixed(1).replace(/\.0$/, "")} onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, weightBps: Math.max(0, Math.min(10000, Math.round(Number(e.target.value) * 100))) } : x)))} />
                  %
                </label>
                {legs.length > 1 && <button className="btn-ghost px-2" onClick={() => setLegs(legs.filter((_, j) => j !== i))}>×</button>}
              </div>
            ))}
            {legs.length < 4 && <button className="btn-ghost px-3 py-1 text-xs" onClick={() => setLegs([...legs, { outputAssetKey: "", weightBps: 0 }])}>{t("plan_add_leg")}</button>}
            {emptyRow !== -1 && <p className="text-xs text-warn">{t("plan_row_no_asset", { n: emptyRow + 1 })}</p>}
            {emptyRow === -1 && weightSum !== 10000 && <p className="text-xs text-warn">{t("plan_weights_sum", { x: (weightSum / 100).toFixed(1) })}</p>}
          </div>
        </Card>
        <Card title={t("plan_q2")}>
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="text-fg-2">{t("f_owner")}</span>
              <div className="mt-1 flex gap-2">
                <input className={`field mono ${ownerProblem ? "border-bad" : ""}`} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="0x…" aria-invalid={!!ownerProblem} />
                {account && owner.trim().toLowerCase() === account.toLowerCase() ? (
                  <span className="inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-md bg-ok/12 px-3 text-xs text-ok">{t("wallet_using")}</span>
                ) : (
                  <button className="btn-ghost shrink-0" type="button" onClick={() => connect().then((a) => { setOwner(a); setConnected(a); }).catch((e: unknown) => setErr(walletErrorText(e, locale)))}>{t("connect")}</button>
                )}
              </div>
              {ownerProblem && <span className="mt-1 block text-xs text-bad">{ownerProblem}</span>}
            </label>
            <span className="text-fg-2">{t("plan_inputs")}</span>
            <div className="flex flex-wrap gap-2">
              {payAssets.map((a) => {
                const on = inputs.includes(a.assetKey);
                return (
                  <button key={a.assetKey} className={`px-3 py-1 text-xs ${on ? "btn" : "btn-ghost"}`} onClick={() => setInputs(on ? inputs.filter((k) => k !== a.assetKey) : [...inputs, a.assetKey])}>{a.displaySymbol}</button>
                );
              })}
            </div>
            <label className="block">
              <span className="text-fg-2">{t("plan_budget")} ({primary?.displaySymbol ?? "—"})</span>
              <input className="field mono mt-1" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
              {budgetRaw && (
                <details className="demo-hide mt-1">
                  <summary className="cursor-pointer text-xs text-fg-3">{t("dev_details")}</summary>
                  <span className="mono text-xs text-fg-3">amountInRaw = {budgetRaw}</span>
                  <p className="text-xs text-fg-3">{t("dev_raw_note")}</p>
                </details>
              )}
            </label>
          </div>
        </Card>
        <Card title={t("plan_q3")}>
          <div className="space-y-3 text-sm">
            <select className="field" value={policy} onChange={(e) => setPolicy(e.target.value)}>
              <option value="STRICT_LIVE">{t("policy_strict")}</option>
              <option value="REFERENCE_CONTEXT">{t("policy_ref")}</option>
              <option value="QUOTE_ONLY">{t("policy_quote")}</option>
            </select>
            <div className="grid grid-cols-3 gap-2">
              <label><span className="text-xs text-fg-2">{t("f_slippage")}</span><input className="field mono mt-1" type="number" value={slippage} onChange={(e) => setSlippage(Number(e.target.value))} /></label>
              <label><span className="text-xs text-fg-2">{t("f_impact")}</span><input className="field mono mt-1" type="number" value={impact} onChange={(e) => setImpact(Number(e.target.value))} /></label>
              <label><span className="text-xs text-fg-2">{t("f_dev")}</span><input className="field mono mt-1" type="number" value={deviation} disabled={policy === "QUOTE_ONLY"} onChange={(e) => setDeviation(Number(e.target.value))} /></label>
            </div>
            <label className="block"><span className="text-fg-2">{t("plan_deadline")}{mounted ? ` · ${t("tz_note")} ${tzLabel()}` : ""}</span><input className="field mono mt-1" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /><span className="mono text-xs text-fg-3">{mounted && deadline ? fmtLocal(new Date(deadline), locale) : ""}</span></label>
          </div>
        </Card>
      </div>
      {err && <p className="text-sm text-bad" role="alert">{err}</p>}
      {shortfall && primary && (
        <div className="flex flex-wrap justify-center gap-2">
          <button className="btn-ghost px-3 py-1 text-xs" disabled={busy || checkingBalance || shortfall.balanceRaw === "0"} onClick={() => { const h = fmtAmount(shortfall.balanceRaw, primary.tokenDecimals, "").trim(); setBudget(h); void run({ budgetRaw: shortfall.balanceRaw }); }}>{tx(locale, "plan_use_balance", { balance: shortfall.balanceHuman })}</button>
        </div>
      )}
      <button className="btn w-full" disabled={busy || checkingBalance || !!disabledWhy} onClick={() => void run()} aria-busy={busy || checkingBalance}>{checkingBalance ? tx(locale, "plan_balance_checking") : busy ? t("plan_running") : t("plan_run")}</button>
      {disabledWhy && !busy && <p className="text-center text-xs text-fg-2">{disabledWhy}</p>}
      {plan && <p className="text-center text-xs text-fg-3">{t("plan_form_kept")}</p>}

      {plan && (
        <Card title={t("plan_candidates")} right={report?.recommended ? <Pill tone="ok">{t("plan_recommended")}: {report.recommended}</Pill> : <Pill tone="warn">{zh ? "无推荐" : "no recommendation"}</Pill>}>
          <p className="mb-3 text-xs text-fg-3">{t("plan_no_market_optimum")}</p>
          {report?.candidates.some((c) => c.reasons.some((r) => r.code === "CLOSE_UNCONFIRMED")) && (
            <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
              <span className="mono mr-2 text-xs">CLOSE_UNCONFIRMED</span>
              {t("close_unconfirmed_note")}
            </div>
          )}
          {report && !report.recommended && report.candidates.length > 0 && (
            <div className="mb-3 rounded-lg border border-line-strong bg-surface-1 px-3 py-2 text-sm text-neutral-200">
              <p className="font-semibold">{t("plan_no_reco_why")}</p>
              <p className="mt-1 text-neutral-300">{blockingSummary(report.candidates, locale)}</p>
            </div>
          )}
          {!report || report.candidates.length === 0 ? (
            <p className="text-sm text-neutral-300">{t("plan_none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" role="group" aria-label={tx(locale, "plan_view_policy")}>
                <span className="text-fg-2">{tx(locale, "plan_view_policy")}</span>
                <button type="button" className={`px-2 py-0.5 ${viewPolicy === null ? "btn" : "btn-ghost"}`} aria-pressed={viewPolicy === null} onClick={() => setViewPolicy(null)}>{tx(locale, "plan_view_chosen")} · {plan.goal.policyId}</button>
                {POLICIES.map((pid) => (
                  <button key={pid} type="button" className={`mono px-2 py-0.5 ${viewPolicy === pid ? "btn" : "btn-ghost"}`} aria-pressed={viewPolicy === pid} onClick={() => setViewPolicy(viewPolicy === pid ? null : pid)}>{pid}</button>
                ))}
                {viewPolicy && <span className="w-full text-fg-3">{tx(locale, "plan_view_note", { policy: plan.goal.policyId })}</span>}
              </div>
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-fg-2"><tr><th className="py-2 pr-3">{tx(locale, "col_leg")}</th><th className="pr-3">{t("f_input")}</th><th className="pr-3">{t("f_amount")}</th><th className="pr-3">{t("plan_completion")}</th><th className="pr-3">{tx(locale, "col_expected_out")}</th><th className="pr-3">{tx(locale, "col_impact")}</th><th className="pr-3">{t("verdict")}</th><th className="pr-3">{t("policy_matrix")}</th><th className="pr-3">{t("plan_next")}</th><th className="pr-3">{t("reasons")}</th><th className="pr-3">{tx(locale, "col_actions")}</th></tr></thead>
                <tbody>
                  {report.candidates.map((c) => {
                    const rec = report.recommended === c.candidateId;
                    const viewed = viewPolicy ? c.verdictByPolicy[viewPolicy] : null;
                    const verdict = viewed?.verdict ?? c.chosenPolicyVerdict;
                    const tone = verdict === "eligible" ? "ok" : verdict === "limited" ? "warn" : "bad";
                    const outKey = plan.goal.legs[c.legIndex]?.outputAssetKey ?? "";
                    return (
                      <tr key={c.candidateId} className={`border-t border-line ${rec ? "bg-ok/5" : ""}`}>
                        <td className="mono py-2 pr-3">{c.legIndex + 1} · {sym(outKey)}</td>
                        <td className="pr-3">{sym(c.inputAssetKey)}</td>
                        <td className="mono pr-3">{fmtAmount(c.amountInRaw, dec(c.inputAssetKey), sym(c.inputAssetKey))}</td>
                        <td className="mono pr-3">{(c.completionBps / 100).toFixed(0)}%</td>
                        <td className="mono pr-3">{c.expectedOutRaw ? fmtAmount(c.expectedOutRaw, dec(outKey), sym(outKey), { approx: true }) : "—"}</td>
                        <td className="mono pr-3">{c.adverseImpactBps === null ? (zh ? "未知" : "unknown") : `${c.adverseImpactBps} bps`}</td>
                        <td className="pr-3"><Pill tone={tone}>{verdict}</Pill></td>
                        <td className="pr-3">
                          <span className="flex flex-col gap-0.5">
                            {(Object.keys(c.verdictByPolicy) as Array<keyof typeof c.verdictByPolicy>).map((pid) => {
                              const v = c.verdictByPolicy[pid];
                              const on = viewPolicy === pid;
                              return (
                                <button key={pid} type="button" className={`mono rounded-full text-left text-xs ${on ? "ring-2 ring-line-strong" : ""}`} title={v.blocking.map((code) => reasonText(code, locale)).join("; ") || pid} aria-pressed={on} onClick={() => setViewPolicy(on ? null : (pid as PolicyId))}>
                                  <Pill tone={v.verdict === "eligible" ? "ok" : v.verdict === "limited" ? "warn" : "bad"}>{pid.replace("REFERENCE_CONTEXT", "REF_CTX").replace("STRICT_LIVE", "STRICT")}</Pill>
                                </button>
                              );
                            })}
                          </span>
                        </td>
                        <td className="pr-3">
                          <Pill tone={NEXT_TONE[c.nextStep]}>{t(`next_${c.nextStep}` as "next_READY")}</Pill>
                          <p className="mt-1 max-w-[16rem] text-xs text-fg-2">{nextStepText(c.nextStep, locale)}</p>
                        </td>
                        <td className="pr-3 text-xs text-fg-2">
                          {viewed ? (
                            viewed.blocking.length === 0 ? "—" : (
                              <ul className="max-w-[18rem] space-y-0.5">
                                {viewed.blocking.map((code) => (
                                  <li key={code}><span className="text-bad">{reasonText(code, locale)}</span> <span className="mono text-[11px] text-fg-3">{code}</span></li>
                                ))}
                              </ul>
                            )
                          ) : c.reasons.filter((r) => r.severity !== "info").length === 0 ? "—" : (
                            <ul className="max-w-[18rem] space-y-0.5">
                              {c.reasons.filter((r) => r.severity !== "info").map((r) => (
                                <li key={r.code}><span className={r.severity === "block" ? "text-bad" : "text-warn"}>{reasonText(r.code, locale)}</span> <span className="mono text-[11px] text-fg-3">{r.code}</span></li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="whitespace-nowrap">
                          {c.nextStep === "READY" && <button className="btn px-3 py-1 text-xs" onClick={() => setMandateFor([c])}>{t("plan_create_task")}</button>}
                          {c.nextStep === "ACCEPT_PARTIAL" && <button className="btn-ghost px-3 py-1 text-xs" disabled={busy} onClick={() => acceptPartial(c)}>{t("plan_accept_partial")}</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn-ghost" title={tx(locale, "plan_sign_wait_hint")} onClick={() => setMandateFor(report?.candidates.filter((c) => c.completionBps === 10000) ?? [])}>{tx(locale, "plan_sign_wait")}</button>
            <span className="self-center text-xs text-fg-3">{tx(locale, "plan_sign_wait_hint")}</span>
            <Link href="/verify-bundle" className="btn-ghost">{t("nav_verify_bundle")}</Link>
          </div>
          {report && (
            <details className="demo-hide mt-3">
              <summary className="cursor-pointer text-xs text-fg-2">{t("dev_details")}</summary>
              <Row k="goalHash" v={report.goalHash} mono />
              <Row k="planHash" v={report.planHash} mono />
              <Row k="evidenceHash" v={report.evidenceHash} mono />
              <Row k="registryHash" v={report.registryHash} mono />
            </details>
          )}
        </Card>
      )}
    </div>
  );
}
