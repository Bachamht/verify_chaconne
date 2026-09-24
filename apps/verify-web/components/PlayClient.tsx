"use client";
/** /play：选角色 → 选一道现成题目 → POST /v1/simulations（LIVE 证据，不签证书不执行）→ 战报（SIMULATION）→ "改成我的预算" */
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { PersonaId, PlanGoal } from "@chaconne/core/verify";
import { api, type AssetsResponse } from "@/lib/api";
import { profiles, simulations, type PublicReport, type SimulationView } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { PersonaArt, PERSONAS } from "@/components/personas";
import { ReportCard } from "@/components/ReportCard";
import { Card, Pill } from "@/components/ui";
import { connect } from "@/lib/wallet";
import { headline } from "@/lib/report-copy";
import { apiError } from "@/lib/errors";
import { walletErrorText } from "@/lib/i18n.execute";
import { remember } from "@/lib/history";
import { addressProblem, nextStepText } from "@/lib/format";
import { tx } from "@/lib/i18n.execute";

const PRESETS: Array<{ id: string; title: { en: string; zh: string }; side: "buy" | "sell"; symbols: string[]; policy: PlanGoal["policyId"]; budget: string; impact: number }> = [
  { id: "aapl-strict", title: { en: "Buy $20 of AAPLx right now under STRICT_LIVE", zh: "现在用 STRICT_LIVE 买 20 美元 AAPLx" }, side: "buy", symbols: ["AAPLx"], policy: "STRICT_LIVE", budget: "20000000", impact: 100 },
  { id: "basket-ref", title: { en: "Basket: 50% AAPLx + 50% NVDAx with $50, official close as context", zh: "篮子：50 美元买一半 AAPLx 一半 NVDAx，以正式收盘为背景" }, side: "buy", symbols: ["AAPLx", "NVDAx"], policy: "REFERENCE_CONTEXT", budget: "50000000", impact: 100 },
  { id: "tight-impact", title: { en: "Buy $500 of NVDAx but refuse more than 10 bps impact", zh: "买 500 美元 NVDAx，但冲击超过 10 bps 就拒绝" }, side: "buy", symbols: ["NVDAx"], policy: "QUOTE_ONLY", budget: "500000000", impact: 10 },
];

export function PlayClient() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const sp = useSearchParams();
  const zh = locale === "zh";
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [persona, setPersona] = useState<PersonaId>("turtle_drummer");
  const [name, setName] = useState("");
  const [preset, setPreset] = useState(PRESETS[0]!.id);
  const [busy, setBusy] = useState(false);
  const [sim, setSim] = useState<SimulationView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const account = useAccount();
  useEffect(() => {
    if (account && !owner) setOwner(account);
  }, [account]);

  useEffect(() => {
    api<AssetsResponse>("GET", "v1/assets").then((r) => r.status === 200 && setAssets(r.data));
  }, []);
  // 「我的任务」回访：/play?simulation=<id>
  useEffect(() => {
    const id = sp.get("simulation");
    if (!id) return;
    simulations.get(id).then((r) => {
      if (r.status === 200) {
        setSim(r.data);
        if (r.data.personaId) setPersona(r.data.personaId);
      } else setErr(apiError(r, locale));
    });
  }, [sp, locale]);
  const goal = useMemo<PlanGoal | null>(() => {
    const p = PRESETS.find((x) => x.id === preset);
    if (!p || !assets) return null;
    const stable = assets.assets.find((a) => a.role === "stable_input" && a.displaySymbol === "USDG") ?? assets.assets.find((a) => a.role === "stable_input");
    const legs = p.symbols.map((s) => assets.assets.find((a) => a.displaySymbol === s)).filter((a): a is NonNullable<typeof a> => !!a);
    if (!stable || legs.length !== p.symbols.length) return null;
    const w = Math.floor(10000 / legs.length);
    const o = (owner || "0x0000000000000000000000000000000000000001") as `0x${string}`;
    return { ownerAddress: o, recipientAddress: o, executionChainId: assets.chainId, legs: legs.map((a, i) => ({ outputAssetKey: a.assetKey, weightBps: i === legs.length - 1 ? 10000 - w * (legs.length - 1) : w })), budget: { inputAssetKeys: [stable.assetKey], amountInRaw: p.budget }, side: p.side, policyId: p.policy, policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: p.impact, maxReferenceDeviationBps: p.policy === "QUOTE_ONLY" ? null : 300, deadline: new Date(Date.now() + 3600_000).toISOString() };
  }, [preset, assets, owner]);

  async function run() {
    if (!goal) return;
    setErr(null);
    setBusy(true);
    try {
      if (owner && !addressProblem(owner, null, locale)) await profiles.save({ ownerAddress: owner, personaId: persona, name: name || (zh ? PERSONAS[persona].name.zh : PERSONAS[persona].name.en), tone: PERSONAS[persona].tone });
      const r = await simulations.create({ goal, personaId: persona, presetId: preset, clientRequestId: `web-sim-${Date.now()}` });
      if (r.status === 200 || r.status === 201) {
        setSim(r.data);
        const p = PRESETS.find((x) => x.id === preset);
        remember({ kind: "simulation", id: r.data.simulationId, title: `${zh ? PERSONAS[persona].name.zh : PERSONAS[persona].name.en} · ${p ? (zh ? p.title.zh : p.title.en) : preset}`, owner: owner || null });
      } else setErr(apiError(r, locale));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const asReport: PublicReport | null = useMemo(() => {
    if (!sim) return null;
    const rep = sim.report;
    const rec = rep?.candidates.find((c) => c.candidateId === rep.recommended) ?? null;
    const status = rec ? (rec.completionBps === 10000 ? "simulation" : "simulation") : "simulation";
    const sym = (k: string) => assets?.assets.find((a) => a.assetKey === k)?.displaySymbol ?? k.slice(-6);
    return {
      shareId: sim.shareId ?? sim.simulationId,
      kind: "simulation",
      status,
      persona: { personaId: persona, name: name || (zh ? PERSONAS[persona].name.zh : PERSONAS[persona].name.en), tone: PERSONAS[persona].tone },
      headline: { en: headline("simulation", persona, "en"), zh: headline("simulation", persona, "zh") },
      goal: { side: sim.goal.side, outputSymbols: sim.goal.legs.map((l) => sym(l.outputAssetKey)), inputSymbol: sym(sim.goal.budget.inputAssetKeys[0]!), policyId: sim.goal.policyId, amountDisplay: null },
      result: { verdict: rec?.chosenPolicyVerdict ?? sim.verdict, completionBps: rec?.completionBps ?? null, spentDisplay: null, receivedDisplay: null, feesDisplay: null, reasons: (rec?.reasons ?? rep?.candidates[0]?.reasons ?? []).filter((r) => r.severity !== "info").map((r) => ({ code: r.code, severity: r.severity })), waitingOn: rec ? null : rep ? [...new Set(rep.candidates.map((c) => c.nextStep))].map((s) => nextStepText(s, locale)).join(" ") || null : null },
      evidence: { evidenceHash: rep?.evidenceHash ?? null, reportHash: rep?.planHash ?? null, bundleUrl: null, txHashes: [] },
      templateId: null,
      evidenceMode: "SIMULATION",
      createdAt: sim.createdAt,
    };
  }, [sim, persona, name, zh, locale, assets]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">{t("play_h")}</h1>
      <p className="text-sm text-neutral-300">{t("play_p")}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t("play_pick")}>
          <div className="grid grid-cols-3 gap-3">
            {(Object.keys(PERSONAS) as PersonaId[]).map((id) => (
              <button key={id} className={`flex flex-col items-center gap-2 rounded-xl border p-3 text-sm ${persona === id ? "border-brand bg-brand/10" : "border-line"}`} onClick={() => setPersona(id)}>
                <PersonaArt id={id} size={72} />
                <span className="font-semibold">{zh ? PERSONAS[id].name.zh : PERSONAS[id].name.en}</span>
                <span className="text-xs text-fg-2">{zh ? PERSONAS[id].blurb.zh : PERSONAS[id].blurb.en}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm text-fg-2" aria-live="polite">{tx(locale, "play_persona_chosen", { persona: name.trim() ? `${name.trim()}（${zh ? PERSONAS[persona].name.zh : PERSONAS[persona].name.en}）` : zh ? PERSONAS[persona].name.zh : PERSONAS[persona].name.en })}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <input className="field max-w-xs" placeholder={zh ? "给它起个名（可选）" : "Name it (optional)"} value={name} onChange={(e) => setName(e.target.value)} />
            <input className={`field mono max-w-xs ${addressProblem(owner, null, locale) ? "border-bad" : ""}`} placeholder={zh ? "钱包（可选，只用于保存角色）" : "Wallet (optional, only to save persona)"} value={owner} onChange={(e) => setOwner(e.target.value)} />
            {account && owner.trim().toLowerCase() === account.toLowerCase() ? (
              <span className="inline-flex h-10 items-center whitespace-nowrap rounded-md bg-ok/12 px-3 text-xs text-ok">{t("wallet_using")}</span>
            ) : (
              <button className="btn-ghost" type="button" onClick={() => connect().then(setOwner).catch((e: unknown) => setErr(walletErrorText(e, locale)))}>{t("connect")}</button>
            )}
          </div>
          {addressProblem(owner, null, locale) && <p className="mt-1 text-xs text-bad">{addressProblem(owner, null, locale)}</p>}
        </Card>
        <Card title={t("play_question")}>
          <div className="space-y-2">
            {PRESETS.map((p) => (
              <button key={p.id} className={`block w-full rounded-lg border p-3 text-left text-sm ${preset === p.id ? "border-brand bg-brand/10" : "border-line"}`} onClick={() => setPreset(p.id)}>
                {zh ? p.title.zh : p.title.en} <Pill>{p.policy}</Pill>
              </button>
            ))}
          </div>
          <button className="btn mt-4 w-full" disabled={!goal || busy} onClick={run} aria-busy={busy}>{busy ? t("running") : t("play_run")}</button>
          {err && <p className="mt-2 text-sm text-bad">{err}</p>}
        </Card>
      </div>
      {asReport && (
        <Card>
          <ReportCard r={asReport} />
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn" onClick={() => router.push(`/plan${sim?.simulationId ? `?from_simulation=${sim.simulationId}` : ""}`)}>{t("play_use_budget")}</button>
          </div>
        </Card>
      )}
    </div>
  );
}
