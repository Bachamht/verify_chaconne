/**
 * 证据包（v5 W3）：组装规范化哈希 + 离线验证清单。
 * core 不依赖 viem：签名恢复由调用方注入（浏览器/CLI 传 viem 的 verifyTypedData / verifyMessage）。
 */
import type { MarketCalendar } from "../calendar";
import { hashCanonical } from "./canonical";
import type { Bytes32, EvidenceBundle, EvidenceRecord, Hex, MandateStep, PlanReport, StepCertificate, TradeIntent, TradeMandate, VerificationCertificate, VerifyReport } from "./contracts";
import { certificateDigest, EIP712_TYPES_V2, intentDigest, makeDomain, makePlanGuardDomain, mandateDigest, stepCertificateDigest, stepDigest } from "./eip712";
import { evaluateVerification } from "./evaluate";
import { buildEffectivePolicy, policyDefinitionHash } from "./policy";
import { registryHash as computeRegistryHash } from "./registry";
import { planHash } from "./plan/report";
import { evidenceHash, reportHash, requestHash } from "./report";

export interface BundleCheck {
  id: string;
  ok: boolean;
  detail: string;
  /** 未校验（缺少签名者/验证器）：ok 为 true 但不代表通过；UI 应显示"未校验"而非 ✅/❌ */
  skipped?: boolean;
}

export interface TypedDataLike {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface VerifyBundleOptions {
  /** 注入：EIP-712 签名验证（如 viem.verifyTypedData）。缺省则签名检查记为 skipped(ok=true, detail="skipped") */
  verifyTypedData?: (args: { address: `0x${string}`; typedData: TypedDataLike; signature: Hex }) => Promise<boolean> | boolean;
  /** 注入：EIP-191 raw bytes 消息验证（如 viem.verifyMessage({ message: { raw } })） */
  verifyMessage?: (args: { address: `0x${string}`; raw: Bytes32; signature: Hex }) => Promise<boolean> | boolean;
  /** 期望的证明签名地址（缺省取 certificates[0].signer） */
  expectedSigner?: `0x${string}`;
  calendar?: MarketCalendar;
}

export function bundleHash(bundle: Omit<EvidenceBundle, "bundleHash" | "bundleSignature"> & Partial<Pick<EvidenceBundle, "bundleHash" | "bundleSignature">>): Bytes32 {
  const { bundleHash: _h, bundleSignature: _s, ...rest } = bundle;
  void _h;
  void _s;
  return hashCanonical(rest);
}

function isTyped(x: unknown): x is TypedDataLike {
  return typeof x === "object" && x !== null && "domain" in x && "primaryType" in x && "message" in x;
}

function subset(all: EvidenceRecord[], ids: string[]): EvidenceRecord[] {
  const want = new Set(ids);
  return all.filter((e) => want.has(e.evidenceId));
}

export async function verifyBundleOffline(bundle: EvidenceBundle, opts: VerifyBundleOptions = {}): Promise<BundleCheck[]> {
  const checks: BundleCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, skipped = false) => checks.push(skipped ? { id, ok, detail, skipped } : { id, ok, detail });
  // 签名者来源优先级：调用方指定 → 包内 attestationSigner（v2.1）→ 第一张证书的 signer
  const signer = opts.expectedSigner ?? bundle.attestationSigner ?? bundle.certificates[0]?.signer ?? null;

  /* 1. bundleHash */
  const h = bundleHash(bundle);
  add("bundle_hash", h === bundle.bundleHash, h === bundle.bundleHash ? h : `recomputed ${h} != ${bundle.bundleHash}`);

  /* 2. bundleSignature（EIP-191 over bundleHash）：不知道 signer 时记"未校验"，不是失败（V-07） */
  if (!signer) add("bundle_signature", true, "not verified: no signer known (bundle has no attestationSigner/certificates; pass expectedSigner)", true);
  else if (!opts.verifyMessage) add("bundle_signature", true, "not verified: no verifier injected", true);
  else {
    let ok = false;
    try {
      ok = await opts.verifyMessage({ address: signer, raw: bundle.bundleHash, signature: bundle.bundleSignature });
    } catch (e) {
      ok = false;
      add("bundle_signature", false, `verifier threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (checks.at(-1)?.id !== "bundle_signature") add("bundle_signature", ok, ok ? `signed by ${signer}` : `not signed by ${signer}`);
  }

  /* 3. 证据原文哈希齐全 */
  const badRaw = bundle.evidence.filter((e) => !/^0x[0-9a-f]{64}$/.test(e.rawHash));
  add("evidence_raw_hash", badRaw.length === 0, badRaw.length === 0 ? `${bundle.evidence.length} records` : `missing rawHash: ${badRaw.map((e) => e.evidenceId).join(",")}`);

  /* 4. registry hash */
  const regHash = computeRegistryHash({ version: bundle.registryVersion, chainId: bundle.chainId, entries: bundle.registry });
  add("registry_hash", regHash === bundle.registryHash, regHash === bundle.registryHash ? regHash : `recomputed ${regHash}`);

  /* 5. policy hashes */
  const defHash = policyDefinitionHash(bundle.policy);
  add("policy_definition_hash", defHash === bundle.effectivePolicy.policyDefinitionHash, defHash);
  const eff = buildEffectivePolicy(bundle.policy, bundle.effectivePolicy.params);
  add("effective_policy_hash", eff.effectivePolicyHash === bundle.effectivePolicy.effectivePolicyHash, eff.effectivePolicyHash);

  /* 6. 每份报告：evidenceHash 重算、reportHash、规则重算 */
  for (const r of bundle.reports) {
    const ev = subset(bundle.evidence, r.evidenceIds);
    const eh = evidenceHash(ev);
    add(`report_v${r.reportVersion}_evidence_hash`, eh === r.evidenceHash && ev.length === r.evidenceIds.length, eh === r.evidenceHash ? eh : `recomputed ${eh} (have ${ev.length}/${r.evidenceIds.length} records)`);
    add(`report_v${r.reportVersion}_hash`, true, reportHash(r));
    add(`report_v${r.reportVersion}_policy`, r.policyDefinitionHash === defHash && r.effectivePolicyHash === eff.effectivePolicyHash, "policy hashes match bundle policy");
    const res = rerun(r, ev, bundle, opts);
    add(`report_v${r.reportVersion}_rules`, res.ok, res.detail);
  }

  /* 7. 规划报告 */
  for (const p of bundle.plans ?? []) {
    const ph = planHash(p);
    add(`plan_${p.planId}_hash`, ph === p.planHash, ph === p.planHash ? ph : `recomputed ${ph}`);
    const ids = new Set<string>();
    for (const c of p.candidates) for (const id of c.evidenceIds) ids.add(id);
    add(`plan_${p.planId}_evidence_present`, [...ids].every((id) => bundle.evidence.some((e) => e.evidenceId === id)), `${ids.size} evidence ids referenced`);
  }

  /* 8. 证书 / 意图 / 授权 摘要与签名 */
  const chainId = bundle.chainId;
  for (const [i, c] of bundle.certificates.entries()) {
    if (!isTyped(c.typedData)) {
      add(`cert_${i}_shape`, false, "typedData not EIP-712 shaped");
      continue;
    }
    const td = c.typedData;
    const vc = td.domain.verifyingContract;
    if (td.primaryType === "VerificationCertificate") {
      const cert = td.message as unknown as VerificationCertificate;
      const domain = makeDomain(chainId, vc);
      const intent = (bundle.intents ?? []).map((x) => x.typedData).find((x): x is TypedDataLike => isTyped(x) && x.primaryType === "TradeIntent" && intentDigest(domain, x.message as unknown as TradeIntent) === cert.intentDigest);
      add(`cert_${i}_intent_digest`, !!intent, intent ? "intentDigest matches a bundled TradeIntent" : "no bundled intent hashes to certificate.intentDigest");
      add(`cert_${i}_evidence_hash`, bundle.reports.some((r) => r.evidenceHash === cert.evidenceHash), "certificate.evidenceHash matches a bundled report");
      add(`cert_${i}_digest`, true, certificateDigest(domain, cert));
    } else if (td.primaryType === "StepCertificate") {
      const cert = td.message as unknown as StepCertificate;
      const domain = makePlanGuardDomain(chainId, vc);
      const step = bundle.mandate?.steps.find((s) => s.stepDigest === cert.stepDigest);
      add(`cert_${i}_step_digest`, !!step && stepDigest(domain, step.step) === cert.stepDigest, step ? "stepDigest matches bundled step" : "no bundled step for certificate.stepDigest");
      add(`cert_${i}_digest`, true, stepCertificateDigest(domain, cert));
    } else add(`cert_${i}_shape`, false, `unknown primaryType ${td.primaryType}`);
    await sig(`cert_${i}_signature`, c.signer, td, c.signature);
  }
  for (const [i, it] of (bundle.intents ?? []).entries()) {
    if (!isTyped(it.typedData)) {
      add(`intent_${i}_shape`, false, "typedData not EIP-712 shaped");
      continue;
    }
    const owner = (it.typedData.message as { owner?: `0x${string}` }).owner;
    if (!owner) add(`intent_${i}_owner`, false, "no owner in intent");
    else await sig(`intent_${i}_signature`, owner, it.typedData, it.signature);
  }
  if (bundle.mandate) {
    const m = bundle.mandate;
    if (!isTyped(m.typedData)) add("mandate_shape", false, "typedData not EIP-712 shaped");
    else {
      const td = m.typedData;
      const domain = makePlanGuardDomain(chainId, td.domain.verifyingContract);
      const digest = mandateDigest(domain, td.message as unknown as TradeMandate);
      const allMatch = m.steps.every((s) => s.step.mandateDigest === digest);
      add("mandate_digest", allMatch, allMatch ? digest : `steps reference a different mandateDigest than ${digest}`);
      for (const s of m.steps) {
        const sd = stepDigest(domain, s.step as MandateStep);
        add(`mandate_step_${s.stepIndex}_digest`, sd === s.stepDigest && (s.certificate === null || s.certificate.stepDigest === sd), sd);
        if (s.certificate && s.certificateSignature && signer) {
          const td2: TypedDataLike = { domain: { ...domain }, types: { StepCertificate: [...EIP712_TYPES_V2.StepCertificate] }, primaryType: "StepCertificate", message: s.certificate as unknown as Record<string, unknown> };
          await sig(`mandate_step_${s.stepIndex}_cert_signature`, signer, td2, s.certificateSignature);
        }
      }
      const owner = (td.message as { owner?: `0x${string}` }).owner;
      if (owner) await sig("mandate_signature", owner, td, m.signature);
    }
  }
  return checks;

  async function sig(id: string, address: `0x${string}`, typedData: TypedDataLike, signature: Hex) {
    if (!opts.verifyTypedData) {
      add(id, true, "skipped (no verifier injected)");
      return;
    }
    try {
      const ok = await opts.verifyTypedData({ address, typedData, signature });
      add(id, ok, ok ? `signed by ${address}` : `not signed by ${address}`);
    } catch (e) {
      add(id, false, `verifier threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 规则重算：用报告自带的 policySnapshot 与包内证据重跑引擎，比对 verdict / reasons / comparisonStatus / quote / reference */
function rerun(r: VerifyReport, ev: EvidenceRecord[], bundle: EvidenceBundle, opts: VerifyBundleOptions): { ok: boolean; detail: string } {
  const policy = buildEffectivePolicy(r.policySnapshot.definition, r.policySnapshot.params);
  const registry = { version: bundle.registryVersion, chainId: bundle.chainId, entries: bundle.registry };
  const job = bundle.job;
  if (!job) return { ok: false, detail: "bundle has no job (cannot re-run rules)" };
  if (requestHash(job) !== r.requestHash) return { ok: false, detail: `bundle.job requestHash ${requestHash(job)} != report.requestHash` };
  const res = evaluateVerification({ job, policy, registry, evidence: ev, evaluatedAt: r.evaluatedAt, ...(opts.calendar ? { calendar: opts.calendar } : {}) });
  const same =
    res.verdict === r.verdict &&
    res.comparisonStatus === r.comparisonStatus &&
    res.marketSession === r.marketSession &&
    hashCanonical(res.reasons) === hashCanonical(r.reasons) &&
    hashCanonical(res.normalizedQuote) === hashCanonical(r.normalizedQuote) &&
    hashCanonical(res.reference) === hashCanonical(r.reference);
  return { ok: same, detail: same ? `re-evaluated: ${res.verdict}` : `re-evaluation differs: ${res.verdict} vs ${r.verdict} (${res.reasons.map((x) => x.code).join(",")})` };
}

/** 规划哈希（re-export 便于验证器） */
export { planHash };
