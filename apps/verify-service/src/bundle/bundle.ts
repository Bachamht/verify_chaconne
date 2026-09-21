/**
 * 证据包（W3，interfaces §10.3）：任务或授权计划的全部可复核材料 + bundleHash + 证明身份 EIP-191 签名。
 * 第三方用 core `verifyBundleOffline` 离线复核；联网复核用 executions[].txHash。
 */
import { bundleHash as computeBundleHash, EIP712_TYPES, EIP712_TYPES_V2, makeDomain, type EffectivePolicy, type EvidenceBundle, type EvidenceRecord, type MandateStepRecord, type NormalizedJob, type PlanGoal, type PlanReport, type VerifyReport } from "@chaconne/core/verify";
import type { AssetRegistry } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { AttestationSigner } from "../attestation/signer";
import { HttpError, type VerifyService } from "../jobs/service";
import type { MandatesService, MandateJson } from "../mandates/service";
import type { PlansService } from "../plans/service";
import type { Orders } from "../payments/orders";
import { buildBill } from "../products/bill";

export interface BundleDeps {
  cfg: VerifyConfig;
  registry: AssetRegistry;
  signer: AttestationSigner | null;
  jobs: VerifyService;
  mandates: MandatesService;
  plans: PlansService;
  orders: Orders;
}

export async function buildJobBundle(d: BundleDeps, callerId: string, jobId: string): Promise<EvidenceBundle> {
  if (!d.signer) throw new HttpError(503, "attestation_disabled");
  const job = await d.jobs.requireJob(callerId, jobId);
  const order = await d.jobs.requireOrder(jobId);
  const snap = job.policySnapshot as { definition: EffectivePolicy["definition"]; params: EffectivePolicy["params"] };
  const reports: VerifyReport[] = [];
  const evidence: EvidenceRecord[] = [];
  const latest = await d.jobs.latestReport(jobId);
  for (let v = 1; v <= (latest?.version ?? 0); v++) {
    const rep = await d.jobs.reportVersion(jobId, v);
    if (!rep) continue;
    reports.push(rep.reportJson as VerifyReport);
    for (const e of await d.jobs.evidenceFor(jobId, v)) evidence.push(e.record as EvidenceRecord);
  }
  const execs = await d.jobs.executions(jobId);
  const nj = job.jobJson as NormalizedJob;
  const certificates: EvidenceBundle["certificates"] = [];
  const intents: NonNullable<EvidenceBundle["intents"]> = [];
  for (const a of execs) {
    const cj = a.certificateJson as { certificate: Record<string, unknown>; signer: `0x${string}` } | null;
    const ij = a.intentJson as { intent?: Record<string, unknown>; domain?: ReturnType<typeof makeDomain>; intentSignature?: `0x${string}` };
    if (cj && a.certificateSignature && ij.domain) {
      certificates.push({ typedData: { domain: ij.domain, types: { VerificationCertificate: [...EIP712_TYPES.VerificationCertificate] }, primaryType: "VerificationCertificate", message: cj.certificate }, signature: a.certificateSignature as `0x${string}`, signer: cj.signer, epoch: Number(cj.certificate["signerEpoch"] ?? 0) });
      // 用户意图签名不经服务；执行者在 submissions 里回传时才进包（否则只在链上回执里可见）
      if (ij.intent && ij.intentSignature) intents.push({ typedData: { domain: ij.domain, types: { TradeIntent: [...EIP712_TYPES.TradeIntent] }, primaryType: "TradeIntent", message: ij.intent }, signature: ij.intentSignature });
    }
  }
  const attempts = await d.orders.settledAttempts(order.id);
  const inEntry = d.registry.entries.find((e) => e.assetKey === nj.inputAssetKey);
  const bill = buildBill(d.cfg, order, attempts, execs.map((a) => ({ attemptId: a.id, txHash: a.txHash, receipt: (a.receiptJson as Record<string, unknown> | null) ?? null, inputToken: inEntry?.tokenAddress ?? null, chainId: job.executionChainId })), job.ownerAddress);
  const base: Omit<EvidenceBundle, "bundleHash" | "bundleSignature"> = {
    schemaVersion: "1",
    kind: "job",
    id: jobId,
    exportedAt: new Date().toISOString(),
    attestationSigner: d.signer.address,
    attestationEpoch: d.signer.epoch,
    chainId: job.executionChainId,
    job: nj,
    goal: null,
    registryVersion: d.registry.version,
    registry: d.registry.entries,
    registryHash: job.registryHash as `0x${string}`,
    policy: snap.definition,
    effectivePolicy: { definition: snap.definition, params: snap.params, policyDefinitionHash: job.policyDefinitionHash as `0x${string}`, effectivePolicyHash: job.effectivePolicyHash as `0x${string}` },
    evidence,
    reports,
    certificates,
    intents,
    executions: execs.filter((a) => a.state !== "REJECTED").map((a) => ({ attemptId: a.id, ...(a.txHash ? { txHash: a.txHash as `0x${string}` } : {}), chainId: job.executionChainId, receiptSummary: a.receiptJson ?? null })),
    bill,
  };
  const h = computeBundleHash(base);
  return { ...base, bundleHash: h, bundleSignature: await d.signer.signBundleHash(h) };
}

export async function buildMandateBundle(d: BundleDeps, callerId: string, mandateId: string): Promise<EvidenceBundle> {
  if (!d.signer) throw new HttpError(503, "attestation_disabled");
  const row = await d.mandates.requireMandate(callerId, mandateId);
  const json = row.mandateJson as MandateJson;
  const snap = row.policySnapshot as { definition: EffectivePolicy["definition"]; params: EffectivePolicy["params"] };
  const evals = (await d.mandates.evaluations(mandateId, 500)).reverse();
  const steps = await d.mandates.steps(mandateId);
  const evidence: EvidenceRecord[] = [];
  const reports: VerifyReport[] = [];
  const seen = new Set<string>();
  // 规则重算需要 bundle.job：取最新一次带报告的评估的任务；只放同 requestHash 的报告（其余评估以 delta 时间线体现）
  let job: NormalizedJob | null = null;
  for (const e of [...evals].reverse()) {
    const r = e.reportJson as VerifyReport | null;
    if (r) {
      job = jobOfEvaluation(row, r, e.jobJson);
      break;
    }
  }
  for (const e of evals) {
    const r = e.reportJson as VerifyReport | null;
    if (!r || !job || r.requestHash !== requestHashOf(job)) continue;
    reports.push(r);
    for (const ev of e.evidenceJson as EvidenceRecord[]) if (!seen.has(ev.evidenceId)) {
      seen.add(ev.evidenceId);
      evidence.push(ev);
    }
  }
  const stepRecords: MandateStepRecord[] = steps.map((s) => {
    const sv = d.mandates.stepView(s);
    return { stepIndex: String(s.stepIndex), state: s.state as MandateStepRecord["state"], step: sv.step, stepDigest: s.stepDigest as `0x${string}`, certificate: sv.certificate, certificateSignature: sv.certificateSignature as `0x${string}`, txHash: (s.txHash as `0x${string}` | null) ?? null, receiptSummary: s.receiptJson ?? null };
  });
  const certificates: EvidenceBundle["certificates"] = steps.map((s) => {
    const sv = d.mandates.stepView(s);
    return { typedData: { domain: json.domain, types: { StepCertificate: [...EIP712_TYPES_V2.StepCertificate] }, primaryType: "StepCertificate", message: sv.certificate }, signature: sv.certificateSignature as `0x${string}`, signer: sv.attestationSigner as `0x${string}`, epoch: Number(sv.certificate.signerEpoch) };
  });
  const order = await d.orders.byRef(mandateId);
  const attempts = order ? await d.orders.settledAttempts(order.id) : [];
  const bill = buildBill(d.cfg, order, attempts, steps.map((s) => ({ attemptId: s.id, txHash: s.txHash, receipt: (s.receiptJson as Record<string, unknown> | null) ?? null, inputToken: json.mandate.inputToken, chainId: row.chainId })), row.ownerAddress);
  let goal: PlanGoal | null = null;
  const plans: PlanReport[] = [];
  if (row.planId) {
    const p = await d.plans.byId(row.planId);
    if (p && p.callerId === callerId) {
      goal = p.goalJson as PlanGoal;
      plans.push(p.planJson as PlanReport);
      for (const ev of p.evidenceJson as EvidenceRecord[]) if (!seen.has(ev.evidenceId)) {
        seen.add(ev.evidenceId);
        evidence.push(ev);
      }
    }
  }
  const base: Omit<EvidenceBundle, "bundleHash" | "bundleSignature"> = {
    schemaVersion: "1",
    kind: "mandate",
    id: mandateId,
    exportedAt: new Date().toISOString(),
    attestationSigner: d.signer.address,
    attestationEpoch: d.signer.epoch,
    chainId: row.chainId,
    job,
    goal,
    registryVersion: d.registry.version,
    registry: d.registry.entries,
    registryHash: row.registryHash as `0x${string}`,
    policy: snap.definition,
    effectivePolicy: { definition: snap.definition, params: snap.params, policyDefinitionHash: row.policyDefinitionHash as `0x${string}`, effectivePolicyHash: row.effectivePolicyHash as `0x${string}` },
    evidence,
    reports,
    ...(plans.length ? { plans } : {}),
    certificates,
    mandate: { typedData: { domain: json.domain, types: { TradeMandate: [...EIP712_TYPES_V2.TradeMandate] }, primaryType: "TradeMandate", message: json.mandate }, signature: row.signature as `0x${string}`, steps: stepRecords },
    executions: steps.filter((s) => s.txHash).map((s) => ({ attemptId: s.id, txHash: s.txHash as `0x${string}`, chainId: row.chainId, receiptSummary: s.receiptJson ?? null })),
    bill,
  };
  const h = computeBundleHash(base);
  return { ...base, bundleHash: h, bundleSignature: await d.signer.signBundleHash(h) };
}

import { requestHash as requestHashOf } from "@chaconne/core/verify";

/** 评估报告对应的任务原文：评估行自带 jobJson */
function jobOfEvaluation(_row: MandateRow, _r: VerifyReport, jobJson: unknown): NormalizedJob | null {
  return (jobJson as NormalizedJob | null) ?? null;
}
import type { MandateRow } from "../mandates/service";
