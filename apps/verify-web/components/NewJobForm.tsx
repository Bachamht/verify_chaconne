"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type AssetsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { Card, Row } from "@/components/ui";
import { useAccount } from "@/lib/useAccount";
import { connect } from "@/lib/wallet";
import { templates, type TemplateView } from "@/lib/api-v2";
import { addressProblem, isAddress } from "@/lib/format";
import { apiError } from "@/lib/errors";
import { remember } from "@/lib/history";

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

  useEffect(() => {
    api<AssetsResponse>("GET", "v1/assets").then((r) => {
      if (r.status === 200) {
        setAssets(r.data);
        const stable = r.data.assets.find((a) => a.role === "stable_input" && a.displaySymbol === "USDG") ?? r.data.assets.find((a) => a.role === "stable_input");
        const stock = r.data.assets.find((a) => a.role === "stock_output" && a.executionAllowed);
        // URL 预填（主站深链 /new?stock=AAPLx&amount=100&input=USDG&policy=…）：符号或 assetKey 都接受
        const findAsset = (v: string | null, role: "stable_input" | "stock_output") => {
          if (!v) return null;
          const q = v.trim().toLowerCase();
          return r.data.assets.find((a) => a.role === role && (a.assetKey.toLowerCase() === q || a.displaySymbol.toLowerCase() === q || a.displaySymbol.toLowerCase().replace(/x$/, "") === q.replace(/x$/, ""))) ?? null;
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
    });
    api<Policies>("GET", "v1/policies").then((r) => r.status === 200 && setPolicies(r.data));
    const tid = sp.get("template");
    if (tid) templates.get(tid).then((r) => r.status === 200 && setTpl(r.data));
  }, [sp]);
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
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-bold">{t("new_h")}</h1>
      {tpl && (
        <p className="text-sm text-fg-2">
          {t("remix_credit")} <span className="text-neutral-200">{tpl.authorName ?? tpl.templateId}</span> · {t("remix_note")}
        </p>
      )}
      {prefilled && !tpl && (
        <p className="rounded-md border border-line-brand bg-surface-brand px-3 py-2 text-xs text-fg-1">{t("prefilled_from")}</p>
      )}
      <Card>
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="text-fg-2">{t("f_owner")}</span>
            <div className="mt-1 flex gap-2">
              <input className={`field mono ${ownerProblem ? "border-bad" : ""}`} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="0x…" aria-invalid={!!ownerProblem} />
              {account && owner.trim().toLowerCase() === account.toLowerCase() ? (
                <span className="inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-md bg-ok/12 px-3 text-xs text-ok">{t("wallet_using")}</span>
              ) : (
                <button className="btn-ghost shrink-0" onClick={() => connect().then((a) => { setOwner(a); setConnected(a); }).catch(() => setErr(t("no_wallet")))} type="button">
                  {t("connect")}
                </button>
              )}
            </div>
            {ownerProblem && <span className="mt-1 block text-xs text-bad">{ownerProblem}</span>}
          </label>
          <label className="block text-sm">
            <span className="text-fg-2">{t("f_recipient")}</span>
            <input className={`field mono mt-1 ${recipientProblem ? "border-bad" : ""}`} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder={owner || "0x…"} aria-invalid={!!recipientProblem} />
            {recipientProblem && <span className="mt-1 block text-xs text-bad">{recipientProblem}</span>}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_input")}</span>
              <select className="field mt-1" value={input} onChange={(e) => setInput(e.target.value)}>
                {assets?.assets.filter((a) => a.role === "stable_input").map((a) => (
                  <option key={a.assetKey} value={a.assetKey}>
                    {a.displaySymbol} · {a.tokenAddress.slice(0, 8)}…
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-fg-2">{t("f_output")}</span>
              <select className="field mt-1" value={output} onChange={(e) => setOutput(e.target.value)}>
                {assets?.assets.filter((a) => a.role === "stock_output").map((a) => (
                  <option key={a.assetKey} value={a.assetKey} disabled={!a.executionAllowed}>
                    {a.displaySymbol} ({a.underlyingId.split(":")[1]}) · {a.tokenAddress.slice(0, 8)}…{a.executionAllowed ? "" : ` · ${t("not_enabled")}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-fg-2">
              {t("f_amount")} ({inAsset?.displaySymbol ?? "—"})
            </span>
            <input className="field mono mt-1" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            {amountRaw && (
              <details className="demo-hide mt-1">
                <summary className="cursor-pointer text-xs text-fg-3">{t("dev_details")}</summary>
                <span className="mono text-xs text-fg-3">amountInRaw = {amountRaw}</span>
                <p className="text-xs text-fg-3">{t("dev_raw_note")}</p>
              </details>
            )}
          </label>
          <label className="block text-sm">
            <span className="text-fg-2">{t("f_policy")}</span>
            <select className="field mt-1" value={policy} onChange={(e) => setPolicy(e.target.value)}>
              <option value="STRICT_LIVE">{t("policy_strict")}</option>
              <option value="REFERENCE_CONTEXT">{t("policy_ref")}</option>
              <option value="QUOTE_ONLY">{t("policy_quote")}</option>
            </select>
          </label>
          <div className="grid gap-4 sm:grid-cols-3 sm:items-end">
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
          <Row k={t("price_line")} v={price === "0" ? t("free") : `$${price} (${policies?.pricing.network})`} />
          {policies && <Row k={t("refreshes_left")} v={`${policies.entitlement.maxRefreshes} / ${policies.entitlement.windowSeconds}s`} />}
          {err && <p className="text-sm text-bad">{err}</p>}
          <button className="btn w-full" disabled={busy || !!disabledWhy} onClick={submit}>
            {busy ? t("running") : t("submit")}
          </button>
          {disabledWhy && !busy && <p className="text-center text-xs text-fg-2">{disabledWhy}</p>}
        </div>
      </Card>
    </div>
  );
}
