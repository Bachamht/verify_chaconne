"use client";
/** 授权计划创建：从规划（或任务）构造 TradeMandate → 钱包 signTypedData（PlanGuard domain）→ POST /v1/mandates → /tasks/[id] */
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { PlanCandidate } from "@chaconne/core/verify";
import type { AssetsResponse } from "@/lib/api";
import { mandates, type PlanView } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { buildMandate, mandateTypedData, signMandate } from "@/lib/mandate";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { Card, Pill, Row } from "@/components/ui";
import { CHAIN_ID, connect, currentChainId, ensureChain, short } from "@/lib/wallet";
import { fmtLocal, humanToRaw, rawToHuman } from "@/lib/format";
import { apiError } from "@/lib/errors";
import { walletErrorText } from "@/lib/i18n.execute";
import { remember } from "@/lib/history";

export function MandateBuilder({ plan, candidates, assets, onBack }: { plan: PlanView; candidates: PlanCandidate[]; assets: AssetsResponse | null; onBack: () => void }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const zh = locale === "zh";
  const goal = plan.goal;
  const report = plan.report;
  const tokenOf = useCallback((key: string) => assets?.assets.find((a) => a.assetKey === key)?.tokenAddress as `0x${string}` | undefined, [assets]);
  const inputKey = candidates[0]?.inputAssetKey ?? goal.budget.inputAssetKeys[0]!;
  const inDec = assets?.assets.find((a) => a.assetKey === inputKey)?.tokenDecimals ?? 6;
  const inSym = assets?.assets.find((a) => a.assetKey === inputKey)?.displaySymbol ?? "";
  // 面向人的输入用十进制（USDG），raw 由精度换算（V-09）
  const [budgetHuman, setBudgetHuman] = useState(() => rawToHuman(goal.budget.amountInRaw, inDec));
  const [perStepHuman, setPerStepHuman] = useState(() => rawToHuman(candidates[0]?.amountInRaw ?? goal.budget.amountInRaw, inDec));
  const budgetCap = humanToRaw(budgetHuman, inDec) ?? "0";
  const perStep = humanToRaw(perStepHuman, inDec) ?? "0";
  const amountProblem = budgetCap === "0" || perStep === "0" ? t("mandate_amount_invalid") : BigInt(perStep) > BigInt(budgetCap) ? t("mandate_step_gt_budget") : null;
  const [maxSteps, setMaxSteps] = useState(Math.max(1, goal.legs.length));
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [step, setStep] = useState<"idle" | "signing" | "registering" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  const draft = useMemo(() => {
    const inputToken = tokenOf(inputKey);
    const outputs = goal.legs.map((l) => tokenOf(l.outputAssetKey)).filter((x): x is `0x${string}` => !!x);
    if (!inputToken || outputs.length === 0 || !report || budgetCap === "0" || perStep === "0" || BigInt(perStep) > BigInt(budgetCap)) return null;
    return buildMandate({ owner: goal.ownerAddress, recipient: goal.recipientAddress, inputToken, outputTokens: outputs, budgetCap, perStepCap: perStep, maxSteps, policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, registryHash: report.registryHash, deadlineIso: goal.deadline });
  }, [tokenOf, inputKey, goal, budgetCap, perStep, maxSteps, report]);

  async function doSign() {
    if (!draft) return;
    setMsg(null);
    try {
      const a = account ?? (await connect());
      setAccount(a);
      if ((await currentChainId()) !== CHAIN_ID) await ensureChain();
      if (a.toLowerCase() !== goal.ownerAddress.toLowerCase()) return setMsg(t("owner_mismatch"));
      setStep("signing");
      const td = mandateTypedData(draft.mandate);
      const sig = await signMandate(a, draft.mandate);
      setStep("registering");
      const r = await mandates.create({
        typedData: { domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message },
        signature: sig,
        outputSet: draft.outputSet,
        planId: plan.planId,
        inputAssetKey: inputKey,
        outputAssetKeys: goal.legs.map((l) => l.outputAssetKey),
        policyId: goal.policyId,
        policyVersion: goal.policyVersion,
        clientRequestId: `web-mandate-${Date.now()}`,
      });
      if (r.status === 200 || r.status === 201) {
        remember({ kind: "mandate", id: r.data.mandateId, title: `${goal.legs.map((l) => assets?.assets.find((x) => x.assetKey === l.outputAssetKey)?.displaySymbol ?? "?").join("+")} · ${budgetHuman} ${inSym} · ${maxSteps} ${zh ? "步" : "steps"}`, owner: goal.ownerAddress });
        router.push(`/tasks/${r.data.mandateId}`);
      } else {
        setStep("error");
        setMsg(apiError(r, locale));
      }
    } catch (e) {
      setStep("error");
      setMsg(e instanceof Error && e.message === "planguard_not_deployed" ? t("mandate_not_deployed") : walletErrorText(e, locale));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("mandate_h")}</h1>
        <button className="btn-ghost ml-auto px-3 py-1 text-sm" onClick={onBack}>← {zh ? "候选" : "candidates"}</button>
      </div>
      <p className="text-sm text-neutral-300">{t("mandate_p")}</p>
      {!PLANGUARD_ADDRESS && <p className="text-sm text-warn">{t("mandate_not_deployed")}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={zh ? "授权边界" : "Authorization bounds"}>
          <div className="space-y-3 text-sm">
            <label className="block"><span className="text-fg-2">{t("mandate_budget_human")} ({inSym})</span><input className={`field mono mt-1 ${amountProblem ? "border-bad" : ""}`} value={budgetHuman} inputMode="decimal" onChange={(e) => setBudgetHuman(e.target.value)} /></label>
            <label className="block"><span className="text-fg-2">{t("mandate_per_step_human")} ({inSym})</span><input className={`field mono mt-1 ${amountProblem ? "border-bad" : ""}`} value={perStepHuman} inputMode="decimal" onChange={(e) => setPerStepHuman(e.target.value)} /></label>
            {amountProblem && <p className="text-xs text-bad">{amountProblem}</p>}
            <label className="block"><span className="text-fg-2">{t("mandate_max_steps")}</span><input className="field mono mt-1" type="number" min={1} max={50} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} /></label>
            <Row k={t("plan_deadline")} v={fmtLocal(goal.deadline, locale)} mono />
            <Row k={t("f_policy")} v={`${goal.policyId} v${goal.policyVersion}`} mono />
            <details className="demo-hide">
              <summary className="cursor-pointer text-xs text-fg-3">{t("dev_details")}</summary>
              <Row k="budgetCap (raw)" v={budgetCap} mono />
              <Row k="perStepCap (raw)" v={perStep} mono />
              <Row k="deadline (ISO)" v={goal.deadline} mono />
              <p className="text-xs text-fg-3">{t("dev_raw_note")}</p>
            </details>
          </div>
        </Card>
        <Card title={zh ? "将要签署的内容" : "What you will sign"}>
          {draft ? (
            <div className="text-sm">
              <Row k="owner" v={short(draft.mandate.owner)} mono />
              <Row k="recipient" v={short(draft.mandate.recipient)} mono />
              <Row k="inputToken" v={short(draft.mandate.inputToken)} mono />
              <Row k="outputSet" v={draft.outputSet.map(short).join(", ")} mono />
              <Row k="outputSetHash" v={draft.mandate.outputSetHash} mono />
              <Row k="policyDefinitionHash" v={draft.mandate.policyDefinitionHash} mono />
              <Row k="registryHash" v={draft.mandate.registryHash} mono />
              <Row k="validFrom → deadline" v={`${fmtLocal(Number(draft.mandate.validFrom), locale)} → ${fmtLocal(Number(draft.mandate.deadline), locale)}`} mono />
              <Row k="verifyingContract" v={PLANGUARD_ADDRESS || "—"} mono />
            </div>
          ) : (
            <p className="text-sm text-fg-2">{amountProblem ?? (zh ? "填好授权边界后，这里会显示将要签署的内容。" : "Fill in the bounds and the exact message to sign appears here.")}</p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="btn" disabled={!draft || !PLANGUARD_ADDRESS || step === "signing" || step === "registering"} onClick={doSign}>{step === "signing" ? "…" : step === "registering" ? t("mandate_signed") : t("mandate_sign")}</button>
            {account ? <Pill tone="ok">{short(account)}</Pill> : <span className="text-xs text-fg-2">{!PLANGUARD_ADDRESS ? t("why_not_deployed") : !draft ? amountProblem ?? "" : t("why_wallet")}</span>}
          </div>
          {msg && <p className="mt-3 text-sm text-bad">{msg}</p>}
        </Card>
      </div>
    </div>
  );
}
