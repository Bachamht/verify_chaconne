"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type AssetsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { Row } from "@/components/ui";
import { Conductor } from "@/components/Conductor";
import { useAccount } from "@/lib/useAccount";
import { connect } from "@/lib/wallet";
import { templates, type TemplateView } from "@/lib/api-v2";
import { addressProblem, isAddress } from "@/lib/format";
import { apiError } from "@/lib/errors";
import { remember } from "@/lib/history";
import "./verification-workspace.css";

interface Policies {
  policies: Array<{ policyId: string; version: string; policyDefinitionHash: string }>;
  pricing: { reportPriceUsd: string; network: string };
  entitlement: { maxRefreshes: number; windowSeconds: number };
}

export function NewJobForm() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const sp = useSearchParams();
  const [tpl, setTpl] = useState<TemplateView | null>(null);
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [owner, setOwner] = useState("");
  const account = useAccount();
  // UV-04：头部说已连接，表单就用同一个钱包（用户手改过则不覆盖）
  useEffect(() => {
    if (account && !owner) {
      setOwner(account);
      setConnected(account);
    }
  }, [account]);
  const [recipient, setRecipient] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [amount, setAmount] = useState("5");
  const [prefilled, setPrefilled] = useState(false);
  const [policy, setPolicy] = useState("STRICT_LIVE");
  const [slippage, setSlippage] = useState(50);
  const [impact, setImpact] = useState(100);
  const [deviation, setDeviation] = useState(300);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [resourcesFailed, setResourcesFailed] = useState(false);
  const [resourceRetry, setResourceRetry] = useState(0);
  const prefilledSearch = useRef<string | null>(null);
  const appliedTemplate = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tid = sp.get("template");
    setResourcesLoading(true);
    setResourcesFailed(false);
    void Promise.allSettled([
      api<AssetsResponse>("GET", "v1/assets"),
      api<Policies>("GET", "v1/policies"),
      tid ? templates.get(tid) : Promise.resolve(null),
    ]).then(([assetResult, policyResult, templateResult]) => {
      if (cancelled) return;
      let failed = false;
      if (assetResult.status === "fulfilled" && assetResult.value.status === 200 && Array.isArray(assetResult.value.data?.assets)) {
        const data = assetResult.value.data;
        setAssets(data);
        // Retrying a failed setup request must not overwrite edits already made in this form.
        if (prefilledSearch.current !== sp.toString()) {
          prefilledSearch.current = sp.toString();
          const stable = data.assets.find((a) => a.role === "stable_input" && a.displaySymbol === "USDG") ?? data.assets.find((a) => a.role === "stable_input");
          const stock = data.assets.find((a) => a.role === "stock_output" && a.executionAllowed);
          // URL 预填（主站深链 /new?stock=AAPLx&amount=100&input=USDG&policy=…）：符号或 assetKey 都接受
          const findAsset = (v: string | null, role: "stable_input" | "stock_output") => {
            if (!v) return null;
            const q = v.trim().toLowerCase();
            return data.assets.find((a) => a.role === role && (a.assetKey.toLowerCase() === q || a.displaySymbol.toLowerCase() === q || a.displaySymbol.toLowerCase().replace(/x$/, "") === q.replace(/x$/, ""))) ?? null;
          };
          const qStock = findAsset(sp.get("stock") ?? sp.get("output"), "stock_output");
          const qStable = findAsset(sp.get("input") ?? sp.get("stable"), "stable_input");
          if (qStable) setInput(qStable.assetKey);
          else if (stable) setInput(stable.assetKey);
          if (qStock) setOutput(qStock.assetKey);
          else if (stock) setOutput(stock.assetKey);
          const qAmount = sp.get("amount");
          if (qAmount && /^\d+(\.\d+)?$/.test(qAmount)) setAmount(qAmount);
          const qPolicy = (sp.get("policy") ?? "").toUpperCase();
          if (["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"].includes(qPolicy)) setPolicy(qPolicy);
          if (qStock || qAmount) setPrefilled(true);
        }
      } else failed = true;
      if (policyResult.status === "fulfilled" && policyResult.value.status === 200 && policyResult.value.data?.pricing && policyResult.value.data?.entitlement) setPolicies(policyResult.value.data);
      else failed = true;
      if (tid) {
        if (templateResult.status === "fulfilled" && templateResult.value?.status === 200 && templateResult.value.data?.structure) {
          if (appliedTemplate.current !== tid) {
            appliedTemplate.current = tid;
            setTpl(templateResult.value.data);
          }
        } else failed = true;
      }
      setResourcesFailed(failed);
      setResourcesLoading(false);
    });
    return () => { cancelled = true; };
  }, [sp, resourceRetry]);
  // 翻创：只预填资产/策略/限额（C-03：不带金额、钱包、旧报价、旧授权）
  useEffect(() => {
    if (!tpl) return;
    const st = tpl.structure;
    if (st.inputAssetKeys[0]) setInput(st.inputAssetKeys[0]);
    if (st.legs[0]) setOutput(st.legs[0].outputAssetKey);
    setPolicy(st.policyId);
    setSlippage(st.maxSlippageBps);
    setImpact(st.maxPriceImpactBps ?? 100);
    setDeviation(st.maxReferenceDeviationBps ?? 300);
  }, [tpl]);

  const inAsset = useMemo(() => assets?.assets.find((a) => a.assetKey === input), [assets, input]);
  const amountRaw = useMemo(() => {
    if (!inAsset || !/^\d+(\.\d+)?$/.test(amount)) return null;
    const [i, f = ""] = amount.split(".");
    return BigInt(i + (f + "0".repeat(inAsset.tokenDecimals)).slice(0, inAsset.tokenDecimals)).toString();
  }, [amount, inAsset]);

  const outAsset = useMemo(() => assets?.assets.find((a) => a.assetKey === output), [assets, output]);
  const ownerProblem = addressProblem(owner, connected, locale);
  const recipientProblem = recipient.trim() ? addressProblem(recipient, null, locale) : null;
  const disabledWhy = !owner.trim() ? t("why_owner") : ownerProblem || recipientProblem ? t("why_owner_invalid") : !input || !output ? t("why_assets") : !amountRaw ? t("why_budget") : null;

  async function submit() {
    setErr(null);
    if (!amountRaw || amountRaw === "0") return setErr(t("why_budget"));
    if (!isAddress(owner) || (recipient.trim() && !isAddress(recipient))) return setErr(t("why_owner_invalid"));
    setBusy(true);
    try {
      const body = {
        clientRequestId: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ownerAddress: owner.trim(),
        recipientAddress: (recipient.trim() || owner.trim()),
        executionChainId: assets?.chainId ?? 196,
        inputAssetKey: input,
        outputAssetKey: output,
        amountInRaw: amountRaw,
        mode: "exactIn",
        policyId: policy,
        policyVersion: "1.1.0",
        maxSlippageBps: slippage,
        maxPriceImpactBps: impact,
        maxReferenceDeviationBps: policy === "QUOTE_ONLY" ? null : deviation,
      };
      const r = await api<{ jobId?: string; error?: string; message?: string; details?: unknown }>("POST", "v1/jobs", body);
      if ((r.status === 200 || r.status === 201) && r.data.jobId) {
        remember({ kind: "job", id: r.data.jobId, title: `${outAsset?.displaySymbol ?? "?"} · ${amount} ${inAsset?.displaySymbol ?? ""} · ${policy}`, owner: owner.trim() });
        router.push(`/jobs/${r.data.jobId}`);
      } else setErr(apiError(r, locale));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const price = policies?.pricing.reportPriceUsd ?? "0";
  const zh = locale === "zh";
  const policyNote = policy === "STRICT_LIVE"
    ? zh ? "仅接受美股常规交易时段的实时参考价。休市或缺少实时参考时，本次核验会拒绝执行。" : "Uses live stock references during regular US market hours only. Closed markets or missing live references prevent execution."
    : policy === "REFERENCE_CONTEXT"
      ? zh ? "允许收盘参考作为背景，并核对其来源与时效。收盘参考不等于当前公允价格。" : "Allows a closing reference as context, with source and freshness checks. A closing reference is not a current fair price."
      : zh ? "核对资产与链上报价，不使用股票参考价作比较；仍受滑点和价格冲击上限约束。" : "Checks the asset and on-chain quote without a stock-reference comparison. Slippage and price-impact limits still apply.";
  return (
    <div className="cvf-workspace">
      <header className="cvf-page-heading">
        <p className="cvf-eyebrow">VERIFY / DEFINE THE TRADE</p>
        <h1>{zh ? <>先把这笔交易，<br /><em>说清楚。</em></> : <>Define the trade.<br /><em>Then ask for proof.</em></>}</h1>
        <p className="cvf-lead">{zh ? "选好资产、金额与边界。让核验结果回答，这笔交易是否符合你的条件。" : "Choose the assets, amount and limits. The report checks whether this trade meets your conditions."}</p>
      </header>
      {tpl && (
        <p className="cvf-context-note">
          {t("remix_credit")} <span className="text-neutral-200">{tpl.authorName ?? tpl.templateId}</span> · {t("remix_note")}
        </p>
      )}
      {prefilled && !tpl && (
        <p className="cvf-context-note">{t("prefilled_from")}</p>
      )}
      {resourcesFailed && <div className="cvf-inline-error cvf-setup-error" role="alert"><span>{zh ? "资产、策略或模板信息未能完整加载。请重试；已填写的内容会保留。" : "Some asset, policy or template details could not be loaded. Retry to complete setup; your edits are kept."}</span><button type="button" className="btn-ghost" disabled={resourcesLoading} onClick={() => setResourceRetry((n) => n + 1)}>{zh ? "重新加载" : "Retry setup"}</button></div>}
      <div className="cvf-workbench">
        <div className="cvf-form-column">
        <section className="cvf-panel" aria-labelledby="verify-assets-title">
          <div className="cvf-section-heading"><span className="cvf-section-number" aria-hidden>01</span><h2 id="verify-assets-title">{zh ? "资产与金额" : "Assets & amount"}</h2></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_input")}</span>
              <select className="field mt-2" value={input} onChange={(e) => setInput(e.target.value)}>
                {!assets && <option value="">{resourcesLoading ? t("loading") : zh ? "资产暂不可用" : "Assets unavailable"}</option>}
                {assets?.assets.filter((a) => a.role === "stable_input").map((a) => (
                  <option key={a.assetKey} value={a.assetKey}>
                    {a.displaySymbol} · {a.tokenAddress.slice(0, 8)}…
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_output")}</span>
              <select className="field mt-2" value={output} onChange={(e) => setOutput(e.target.value)}>
                {!assets && <option value="">{resourcesLoading ? t("loading") : zh ? "资产暂不可用" : "Assets unavailable"}</option>}
                {assets?.assets.filter((a) => a.role === "stock_output").map((a) => (
                  <option key={a.assetKey} value={a.assetKey} disabled={!a.executionAllowed}>
                    {a.displaySymbol} ({a.underlyingId.split(":")[1]}) · {a.tokenAddress.slice(0, 8)}…{a.executionAllowed ? "" : ` · ${t("not_enabled")}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-6 block text-sm">
            <span className="text-fg-2">
              {t("f_amount")} ({inAsset?.displaySymbol ?? "—"})
            </span>
            <span className="cvf-amount-field">
              <input className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              <span aria-hidden>{inAsset?.displaySymbol ?? "—"}</span>
            </span>
          </label>
          {amountRaw && (
              <details className="demo-hide mt-3">
                <summary className="cursor-pointer text-xs text-fg-3">{t("dev_details")}</summary>
                <span className="mono text-xs text-fg-3">amountInRaw = {amountRaw}</span>
                <p className="text-xs text-fg-3">{t("dev_raw_note")}</p>
              </details>
          )}
        </section>

        <section className="cvf-panel" aria-labelledby="verify-wallet-title">
          <div className="cvf-section-heading"><span className="cvf-section-number" aria-hidden>02</span><h2 id="verify-wallet-title">{zh ? "资金与接收钱包" : "Funding & recipient"}</h2></div>
          <div className="space-y-4">
            <div className="text-sm">
              <label className="text-fg-2" htmlFor="verify-owner">{t("f_owner")}</label>
              <div className="cvf-wallet-field mt-2">
                <input id="verify-owner" className={`field mono ${ownerProblem ? "border-bad" : ""}`} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="0x…" aria-invalid={!!ownerProblem} aria-describedby={ownerProblem ? "verify-owner-error" : undefined} />
                {account && owner.trim().toLowerCase() === account.toLowerCase() ? (
                  <span className="cvf-wallet-connected">{t("wallet_using")}</span>
                ) : (
                  <button className="btn-ghost shrink-0" onClick={() => connect().then((a) => { setOwner(a); setConnected(a); }).catch(() => setErr(t("no_wallet")))} type="button">{t("connect")}</button>
                )}
              </div>
              {ownerProblem && <span id="verify-owner-error" className="mt-2 block text-xs text-bad">{ownerProblem}</span>}
            </div>
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_recipient")}</span>
              <input className={`field mono mt-2 ${recipientProblem ? "border-bad" : ""}`} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder={owner || "0x…"} aria-invalid={!!recipientProblem} aria-describedby={recipientProblem ? "verify-recipient-error" : undefined} />
              {recipientProblem && <span id="verify-recipient-error" className="mt-2 block text-xs text-bad">{recipientProblem}</span>}
            </label>
          </div>
        </section>

        <section className="cvf-panel" aria-labelledby="verify-limits-title">
          <div className="cvf-section-heading"><span className="cvf-section-number" aria-hidden>03</span><h2 id="verify-limits-title">{zh ? "核验策略与边界" : "Policy & boundaries"}</h2></div>
          <label className="block text-sm">
            <span className="text-fg-2">{t("f_policy")}</span>
            <select className="field mt-2" value={policy} onChange={(e) => setPolicy(e.target.value)} aria-describedby="verify-policy-note">
              <option value="STRICT_LIVE">{t("policy_strict")}</option>
              <option value="REFERENCE_CONTEXT">{t("policy_ref")}</option>
              <option value="QUOTE_ONLY">{t("policy_quote")}</option>
            </select>
          </label>
          <p id="verify-policy-note" className="cvf-policy-note">{policyNote}</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-3 sm:items-end">
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_slippage_short")}</span>
              <input className="field mono mt-1" type="number" min={1} max={300} value={slippage} onChange={(e) => setSlippage(Number(e.target.value))} />
              <span className="mt-1 block text-xs text-fg-3">{t("f_slippage_hint")}</span>
            </label>
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_impact_short")}</span>
              <input className="field mono mt-1" type="number" min={1} max={1000} value={impact} onChange={(e) => setImpact(Number(e.target.value))} />
              <span className="mt-1 block text-xs text-fg-3">{t("f_impact_hint")}</span>
            </label>
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_dev_short")}</span>
              <input className="field mono mt-1" type="number" min={1} max={2000} value={deviation} disabled={policy === "QUOTE_ONLY"} onChange={(e) => setDeviation(Number(e.target.value))} />
              <span className="mt-1 block text-xs text-fg-3">{t("f_dev_hint")}</span>
            </label>
          </div>
        </section>

        <section className="cvf-submit-panel" aria-label={zh ? "费用与提交" : "Fee & submission"} aria-busy={busy}>
          <Row k={t("price_line")} v={!policies ? (zh ? "费用待确认" : "Fee awaiting confirmation") : price === "0" ? t("free") : `$${price} (${policies.pricing.network})`} />
          {policies && <Row k={t("refreshes_left")} v={`${policies.entitlement.maxRefreshes} / ${policies.entitlement.windowSeconds}s`} />}
          {err && <p className="cvf-inline-error" role="alert">{err}</p>}
          <button className="btn cvf-submit-button" disabled={busy || !!disabledWhy} onClick={submit} aria-describedby={disabledWhy ? "verify-submit-reason" : "verify-submit-note"}>
            <span>{busy ? t("running") : t("submit")}</span><span aria-hidden>{busy ? "…" : "↗"}</span>
          </button>
          {disabledWhy && !busy && <p id="verify-submit-reason" className="mt-3 text-center text-xs text-fg-2">{disabledWhy}</p>}
          <p id="verify-submit-note" className="cvf-submit-note">{zh ? "提交创建核验任务。报告交付依费用规则处理；实际交易仍需另外核验并由钱包签名。" : "Submitting creates a verification job. Report delivery follows the fee policy; a trade still needs execution checks and a wallet signature."}</p>
        </section>
        </div>

        <aside className="cvf-side-panel" aria-label={zh ? "核验说明" : "About this verification"}>
          <div className="cvf-side-art"><Conductor state={busy ? "checking" : "idle"} variant="compact" locale={locale} /></div>
          <div className="cvf-side-content">
            <p className="cvf-eyebrow">EVIDENCE / BEFORE EXECUTION</p>
            <h2>{zh ? "条件写清楚，\n证据来回答。" : "Set the limits.\nLet evidence answer."}</h2>
            <p className="cvf-side-intro">{zh ? "以下是核验范围，不代表已经通过检查。" : "This is the scope of the verification, not a list of passed checks."}</p>
            <ol className="cvf-scope-list">
              <li><span aria-hidden>01</span><div><h3>{zh ? "资产身份" : "Asset identity"}</h3><p>{zh ? "核对网络、合约和代币元数据。" : "Check the network, contract and token metadata."}</p></div></li>
              <li><span aria-hidden>02</span><div><h3>{zh ? "报价与依据" : "Quote & context"}</h3><p>{zh ? "按所选策略检查价格来源和时效。" : "Check price sources and freshness under your chosen policy."}</p></div></li>
              <li><span aria-hidden>03</span><div><h3>{zh ? "交易边界" : "Trade boundaries"}</h3><p>{zh ? "核对金额、滑点与价格冲击上限。" : "Check the amount, slippage and price-impact limits."}</p></div></li>
            </ol>
            <p className="cvf-boundary-note">{t("cert_ttl_line")}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
