/**
 * 授权计划（W2 服务侧，interfaces §10.2 / §10.4）：登记已签 TradeMandate → 持续评估 → READY 时签发步骤证书 → 执行者提交 → 回执核实。
 * 服务端不发交易（D-081）：只校验签名、签证书、返回 calldata。
 */
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { verifyTypedData } from "viem";
import type { Db } from "@chaconne/db";
import { verifyMandateEvaluations, verifyMandateSteps, verifyMandates } from "@chaconne/db";
import {
  buildEffectivePolicy,
  buildReport,
  calldataHash as calldataHashOf,
  EIP712_TYPES_V2,
  explainDelta,
  findEntry,
  findPolicy,
  isEvmAddress,
  isRawAmount,
  makePlanGuardDomain,
  mandateDigest,
  normalizeAddress,
  outputSetHash,
  registryHash,
  reportHash,
  resolveParams,
  stepDigest,
  HARD_BLOCK_CODES,
  effectivePolicyHash as computeEffectivePolicyHash,
  withConditionsHash,
  type AssetRegistry,
  type Bytes32,
  type IsoUtc,
  type Reason,
  type EffectivePolicy,
  type EvidenceRecord,
  type EvmAddress,
  type MandateEvalStatus,
  type MandateState,
  type MandateStep,
  type NormalizedJob,
  type PolicyId,
  type ReasonCode,
  type StepCertificate,
  type TradeMandate,
  type VerifyReport,
} from "@chaconne/core/verify";
import { sessionAt } from "@chaconne/core";
import type { VerifyConfig } from "../config";
import type { AttestationSigner } from "../attestation/signer";
import type { EvidenceProvider } from "../evidence/provider";
import { newId } from "../ids";
import { log } from "../log";
import { certificateValidUntil, HttpError } from "../jobs/service";
import type { Orders } from "../payments/orders";
import { PLANGUARD_ABI } from "../execution/planGuardAbi";
import type { ReceiptAttempt, ReceiptStore } from "../execution/receipts";

export type MandateRow = typeof verifyMandates.$inferSelect;
export type EvaluationRow = typeof verifyMandateEvaluations.$inferSelect;
export type StepRow = typeof verifyMandateSteps.$inferSelect;

export interface MandatesDeps {
  db: Db;
  cfg: VerifyConfig;
  registry: AssetRegistry;
  evidence: EvidenceProvider;
  signer: AttestationSigner | null;
  orders: Orders;
  now?: () => Date;
}

/** 登记请求体（POST /v1/mandates） */
export interface RegisterMandateBody {
  clientRequestId: string;
  planId?: string | null;
  jobId?: string | null;
  sku?: "task_bundle" | "monitor_window";
  mandate: TradeMandate;
  signature: `0x${string}`;
  inputAssetKey: string;
  legs: Array<{ outputAssetKey: string; weightBps: number }>;
  side?: "buy" | "sell";
  policyId: PolicyId;
  policyVersion: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number | null;
  maxReferenceDeviationBps?: number | null;
  /* v6 Lane B：授权承诺的条件集哈希（进 effectivePolicyHash 展开参数；K-10） */
  conditionsHash?: Bytes32;
}

/* ---- v6 Lane B：任务前置链的闸门（条件层在报价证据齐备后再算一次，不过则不签发） ---- */
export interface EvaluateGateInput {
  report: VerifyReport;
  evidence: EvidenceRecord[];
  nowIso: IsoUtc;
}
export interface EvaluateGateResult {
  ok: boolean;
  reasons: Reason[];
  nextCheckAt: IsoUtc | null;
}
export interface EvaluateOptions {
  gate?: (input: EvaluateGateInput) => Promise<EvaluateGateResult>;
  /** false = 只评估不签发（任务建立/授权/恢复后的首评）；缺省签发 */
  issue?: boolean;
}
export type StepConfirmedListener = (args: { mandateId: string; taskId: string | null; stepIndex: number; spentRaw: string; confirmedAt: Date }) => Promise<void>;

export interface MandateJson {
  mandate: TradeMandate;
  domain: ReturnType<typeof makePlanGuardDomain>;
  inputAssetKey: string;
  legs: Array<{ outputAssetKey: string; weightBps: number }>;
  outputSet: EvmAddress[];
  side: "buy" | "sell";
  sku: "task_bundle" | "monitor_window";
  planId: string | null;
  jobId: string | null;
  /* v6 Lane B */
  conditionsHash?: Bytes32 | null;
  taskId?: string | null;
}

/** 这些阻断原因意味着"等条件变化"，不是"授权本身不可行" */
const WAIT_CODES: ReadonlySet<ReasonCode> = new Set(["MARKET_OUTSIDE_REGULAR", "REFERENCE_STALE", "QUOTE_TOO_OLD", "QUOTE_UNAVAILABLE", "CLOSE_SESSION_MISMATCH", "SOURCE_TIME_MISSING", "REFERENCE_MISSING", "REFERENCE_PROVISIONAL", "PRICE_IMPACT_UNKNOWN", "CLOSE_UNCONFIRMED"]);

export class MandatesService implements ReceiptStore {
  private readonly now: () => Date;
  /* v6 Lane B：步骤确认监听（任务层推进 stepsConfirmed / lastConfirmedStepAt / 资金组结算） */
  private stepListener: StepConfirmedListener | null = null;
  constructor(private readonly d: MandatesDeps) {
    this.now = d.now ?? (() => new Date());
  }
  setStepConfirmedListener(fn: StepConfirmedListener | null): void {
    this.stepListener = fn;
  }

  private planGuard(): EvmAddress {
    const a = this.d.cfg.PLANGUARD_ADDRESS;
    if (!a) throw new HttpError(503, "planguard_not_configured");
    return a as EvmAddress;
  }

  /* ---------- 登记 ---------- */

  async register(callerId: string, raw: unknown, internal: { taskId?: string } = {}): Promise<{ status: 200 | 201; row: MandateRow }> {
    const planGuard = this.planGuard();
    const b = (raw ?? {}) as Partial<RegisterMandateBody>;
    const errors: Array<{ field: string; code: string }> = [];
    const conditionsHash = b.conditionsHash === undefined || b.conditionsHash === null ? null : b.conditionsHash;
    if (conditionsHash !== null && !/^0x[0-9a-f]{64}$/.test(String(conditionsHash))) errors.push({ field: "conditionsHash", code: "invalid_bytes32" });
    if (typeof b.clientRequestId !== "string" || !/^[A-Za-z0-9_\-:.]{1,128}$/.test(b.clientRequestId)) errors.push({ field: "clientRequestId", code: "required" });
    const m = b.mandate as Partial<TradeMandate> | undefined;
    if (!m || typeof m !== "object") errors.push({ field: "mandate", code: "required" });
    if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) errors.push({ field: "signature", code: "invalid" });
    if (typeof b.inputAssetKey !== "string") errors.push({ field: "inputAssetKey", code: "required" });
    if (!Array.isArray(b.legs) || b.legs.length === 0 || b.legs.length > 4) errors.push({ field: "legs", code: "expected_1_to_4" });
    const policyId = b.policyId;
    const policyVersion = typeof b.policyVersion === "string" ? b.policyVersion : "1.1.0";
    const def = policyId ? findPolicy(policyId, policyVersion) : null;
    if (!def) errors.push({ field: "policyId", code: "unknown_policy" });
    if (errors.length > 0) throw new HttpError(400, "invalid_request", "授权计划校验失败", errors);
    const mandate = m as TradeMandate;
    const side = b.side === "sell" ? "sell" : "buy";
    const sku = b.sku === "monitor_window" ? "monitor_window" : "task_bundle";

    // 幂等
    const existing = (await this.d.db.select().from(verifyMandates).where(and(eq(verifyMandates.callerId, callerId), eq(verifyMandates.clientRequestId, b.clientRequestId!))).limit(1))[0];
    if (existing) {
      if (existing.mandateDigest !== this.digestOf(mandate, planGuard).toLowerCase()) throw new HttpError(409, "idempotency_conflict", "同一 clientRequestId 已绑定不同授权计划");
      return { status: 200, row: existing };
    }

    // 结构与范围
    for (const k of ["owner", "recipient", "inputToken"] as const) if (!isEvmAddress(mandate[k])) errors.push({ field: `mandate.${k}`, code: "invalid_address" });
    for (const k of ["budgetCap", "perStepCap", "maxSteps", "validFrom", "deadline", "nonce"] as const) if (!isRawAmount(mandate[k])) errors.push({ field: `mandate.${k}`, code: "invalid_uint" });
    for (const k of ["outputSetHash", "policyDefinitionHash", "effectivePolicyHash", "registryHash"] as const) if (!/^0x[0-9a-fA-F]{64}$/.test(String(mandate[k]))) errors.push({ field: `mandate.${k}`, code: "invalid_bytes32" });
    if (errors.length > 0) throw new HttpError(400, "invalid_request", "授权计划字段非法", errors);
    const budgetCap = BigInt(mandate.budgetCap);
    const perStepCap = BigInt(mandate.perStepCap);
    const maxSteps = Number(mandate.maxSteps);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (budgetCap <= 0n) errors.push({ field: "mandate.budgetCap", code: "must_be_positive" });
    if (perStepCap <= 0n || perStepCap > budgetCap) errors.push({ field: "mandate.perStepCap", code: "must_be_in_(0,budgetCap]" });
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) errors.push({ field: "mandate.maxSteps", code: "expected_1_to_1000" });
    if (Number(mandate.deadline) <= nowSec) errors.push({ field: "mandate.deadline", code: "must_be_future" });
    if (Number(mandate.validFrom) > Number(mandate.deadline)) errors.push({ field: "mandate.validFrom", code: "after_deadline" });

    // registry / outputSet / policy hashes
    //
    // 方向语义（V-18）：登记表始终按「inputAssetKey = 资金币种，legs = 股票」书写，
    // 但**链上的 mandate 描述的是这一步实际的转账方向**：
    //   买入：合约拉 inputAssetKey（稳定币），输出集 = legs 的股票代币；
    //   卖出：合约拉 legs 的股票代币（只允许一条腿），输出集 = [inputAssetKey]（换回的稳定币）。
    // `nextStepJob` 在 side=sell 时同样对调输入/输出，两处必须一致，否则步骤的 outputToken
    // 永远不在 mandate 的 outputSet 里，PlanGuard 的输出集校验必失败（卖出授权计划根本无法上链）。
    const inEntry = findEntry(this.d.registry, String(b.inputAssetKey).toLowerCase());
    if (!inEntry) errors.push({ field: "inputAssetKey", code: "asset_unsupported" });
    const legs = (b.legs ?? []).map((l) => ({ outputAssetKey: String(l.outputAssetKey).toLowerCase(), weightBps: Number(l.weightBps) }));
    const legTokens: EvmAddress[] = [];
    let weightSum = 0;
    for (const l of legs) {
      const e = findEntry(this.d.registry, l.outputAssetKey);
      if (!e) errors.push({ field: "legs.outputAssetKey", code: "asset_unsupported" });
      else legTokens.push(e.tokenAddress);
      if (!Number.isInteger(l.weightBps) || l.weightBps <= 0) errors.push({ field: "legs.weightBps", code: "invalid" });
      weightSum += l.weightBps;
    }
    if (weightSum !== 10_000) errors.push({ field: "legs.weightBps", code: "must_sum_to_10000" });
    if (side === "sell" && legs.length !== 1) errors.push({ field: "legs", code: "sell_expects_single_leg" });
    // 链上输入代币：买入 = 资金币种；卖出 = 被卖出的股票代币
    const chainInput = side === "sell" ? legTokens[0] : inEntry?.tokenAddress;
    if (chainInput && chainInput.toLowerCase() !== mandate.inputToken.toLowerCase()) errors.push({ field: "mandate.inputToken", code: "registry_mismatch" });
    // 链上输出集：买入 = legs；卖出 = [资金币种]
    const outputSet: EvmAddress[] = side === "sell" ? (inEntry ? [inEntry.tokenAddress] : []) : legTokens;
    if (outputSet.length > 0 && outputSetHash(outputSet).toLowerCase() !== mandate.outputSetHash.toLowerCase()) errors.push({ field: "mandate.outputSetHash", code: "mismatch" });
    const regHash = registryHash(this.d.registry);
    if (regHash.toLowerCase() !== mandate.registryHash.toLowerCase()) errors.push({ field: "mandate.registryHash", code: "registry_mismatch" });
    const resolved = resolveParams(def!, { maxSlippageBps: b.maxSlippageBps as number, maxPriceImpactBps: b.maxPriceImpactBps ?? null, maxReferenceDeviationBps: policyId === "QUOTE_ONLY" ? null : (b.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) errors.push({ field: "params", code: "policy_param_out_of_range" });
    // v6：任务授权把 conditionsHash 并入展开参数（证书、证据包、验证器复算都用这份 params）
    const policy: EffectivePolicy | null = resolved.ok ? (conditionsHash ? policyWithConditions(def!, resolved.params, conditionsHash) : buildEffectivePolicy(def!, resolved.params)) : null;
    if (policy && (policy.policyDefinitionHash.toLowerCase() !== mandate.policyDefinitionHash.toLowerCase() || policy.effectivePolicyHash.toLowerCase() !== mandate.effectivePolicyHash.toLowerCase())) errors.push({ field: "mandate.policyDefinitionHash|effectivePolicyHash", code: "policy_hash_mismatch" });
    if (errors.length > 0) throw new HttpError(422, "mandate_rejected", "授权计划与登记表/策略不一致", errors);

    // 签名
    const domain = makePlanGuardDomain(this.d.cfg.EXECUTION_CHAIN_ID, planGuard);
    const ok = await verifyTypedData({
      address: normalizeAddress(mandate.owner),
      domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
      types: EIP712_TYPES_V2,
      primaryType: "TradeMandate",
      message: { ...mandate, budgetCap, perStepCap, maxSteps, validFrom: BigInt(mandate.validFrom), deadline: BigInt(mandate.deadline), nonce: BigInt(mandate.nonce) },
      signature: b.signature as `0x${string}`,
    }).catch(() => false);
    if (!ok) throw new HttpError(422, "mandate_signature_invalid", "TradeMandate 签名不是 owner 签的");

    const digest = mandateDigest(domain, mandate).toLowerCase();
    const dup = (await this.d.db.select({ id: verifyMandates.id }).from(verifyMandates).where(eq(verifyMandates.mandateDigest, digest)).limit(1))[0];
    if (dup) throw new HttpError(409, "mandate_already_registered", "同一 mandateDigest 已登记", { mandateId: dup.id });

    const nowDate = this.now();
    const priceUsd = sku === "monitor_window" ? this.d.cfg.PRODUCT_PRICE_MONITOR_WINDOW_USD : this.d.cfg.PRODUCT_PRICE_TASK_BUNDLE_USD;
    const free = priceUsd === "0" || Number(priceUsd) === 0;
    const json: MandateJson = { mandate, domain, inputAssetKey: inEntry!.assetKey, legs, outputSet, side, sku, planId: typeof b.planId === "string" ? b.planId : null, jobId: typeof b.jobId === "string" ? b.jobId : null, conditionsHash, taskId: internal.taskId ?? null };
    const [row] = await this.d.db
      .insert(verifyMandates)
      .values({
        id: newId("mnd"),
        callerId,
        clientRequestId: b.clientRequestId!,
        planId: json.planId,
        jobId: json.jobId,
        ownerAddress: normalizeAddress(mandate.owner),
        chainId: this.d.cfg.EXECUTION_CHAIN_ID,
        planGuardAddress: planGuard.toLowerCase(),
        mandateJson: json,
        mandateDigest: digest,
        signature: b.signature!,
        policyDefinitionHash: policy!.policyDefinitionHash,
        effectivePolicyHash: policy!.effectivePolicyHash,
        policySnapshot: { definition: policy!.definition, params: policy!.params },
        registryHash: regHash,
        state: free ? "ACTIVE" : "DRAFT",
        budgetCap: mandate.budgetCap,
        spent: "0",
        stepsDone: 0,
        maxSteps,
        validFrom: new Date(Number(mandate.validFrom) * 1000),
        deadline: new Date(Number(mandate.deadline) * 1000),
        createdAt: nowDate,
        updatedAt: nowDate,
        taskId: internal.taskId ?? null,
        conditionsHash,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HttpError(409, "idempotency_conflict");
    await this.d.orders.create({ jobId: row.id, refKind: "mandate", sku, priceUsd, network: this.d.cfg.PAYMENT_NETWORK, merchant: this.d.cfg.MERCHANT_RECIPIENT_ADDRESS || "0x0000000000000000000000000000000000000000" });
    log.info("授权计划已登记", { mandateId: row.id, callerId, state: row.state, sku });
    return { status: 201, row };
  }

  digestOf(m: TradeMandate, planGuard: EvmAddress): string {
    return mandateDigest(makePlanGuardDomain(this.d.cfg.EXECUTION_CHAIN_ID, planGuard), m);
  }

  /** 付款放行后激活（DRAFT → ACTIVE） */
  async activate(mandateId: string): Promise<void> {
    await this.d.db.update(verifyMandates).set({ state: "ACTIVE", updatedAt: this.now() }).where(and(eq(verifyMandates.id, mandateId), eq(verifyMandates.state, "DRAFT")));
  }

  /* ---------- 查询 ---------- */

  async requireMandate(callerId: string, id: string): Promise<MandateRow> {
    const row = (await this.d.db.select().from(verifyMandates).where(eq(verifyMandates.id, id)).limit(1))[0];
    if (!row || row.callerId !== callerId) throw new HttpError(404, "mandate_not_found");
    return row;
  }
  async byId(id: string): Promise<MandateRow | null> {
    return (await this.d.db.select().from(verifyMandates).where(eq(verifyMandates.id, id)).limit(1))[0] ?? null;
  }
  async latestEvaluation(mandateId: string): Promise<EvaluationRow | null> {
    return (await this.d.db.select().from(verifyMandateEvaluations).where(eq(verifyMandateEvaluations.mandateId, mandateId)).orderBy(desc(verifyMandateEvaluations.evaluatedAt)).limit(1))[0] ?? null;
  }
  async evaluations(mandateId: string, limit = 50): Promise<EvaluationRow[]> {
    return this.d.db.select().from(verifyMandateEvaluations).where(eq(verifyMandateEvaluations.mandateId, mandateId)).orderBy(desc(verifyMandateEvaluations.evaluatedAt)).limit(limit);
  }
  async steps(mandateId: string): Promise<StepRow[]> {
    return this.d.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.mandateId, mandateId)).orderBy(asc(verifyMandateSteps.stepIndex));
  }

  async view(row: MandateRow) {
    const order = await this.d.orders.byRef(row.id);
    const latest = await this.latestEvaluation(row.id);
    const steps = await this.steps(row.id);
    const json = row.mandateJson as MandateJson;
    const remaining = (BigInt(row.budgetCap) - BigInt(row.spent)).toString();
    return {
      mandateId: row.id,
      clientRequestId: row.clientRequestId,
      state: row.state as MandateState,
      owner: row.ownerAddress,
      chainId: row.chainId,
      planGuard: row.planGuardAddress,
      mandate: json.mandate,
      mandateDigest: row.mandateDigest,
      typedData: { domain: json.domain, types: EIP712_TYPES_V2, primaryType: "TradeMandate" as const, message: json.mandate },
      outputSet: json.outputSet,
      legs: json.legs,
      inputAssetKey: json.inputAssetKey,
      side: json.side,
      sku: json.sku,
      planId: row.planId,
      jobId: row.jobId,
      spent: row.spent,
      stepsDone: row.stepsDone,
      maxSteps: row.maxSteps,
      budget: { cap: row.budgetCap, spent: row.spent, remaining },
      steps: { done: row.stepsDone, max: row.maxSteps },
      validFrom: row.validFrom.toISOString(),
      deadline: row.deadline.toISOString(),
      order: order ? { orderId: order.id, state: order.state, priceUsd: order.priceUsd, sku: order.sku } : null,
      latestEvaluation: latest ? this.evalView(latest) : null,
      stepRecords: steps.map((s) => this.stepView(s)),
      evidenceMode: this.d.evidence.mode,
      /* v6 Lane B */
      taskId: row.taskId ?? null,
      conditionsHash: row.conditionsHash ?? null,
      /** 已取走且未过期的步骤证书（服务侧停止后仍可能可执行，D-088） */
      pulledUnexpiredSteps: steps.filter((s) => s.pulledAt && !s.txHash && s.validUntil.getTime() > this.now().getTime()).map((s) => s.stepIndex),
    };
  }

  evalView(e: EvaluationRow) {
    const report = e.reportJson as VerifyReport | null;
    return { evaluationId: e.id, evaluatedAt: e.evaluatedAt.toISOString(), status: e.status as MandateEvalStatus, verdict: report?.verdict ?? null, marketSession: report?.marketSession ?? null, reasons: e.reasonsJson, delta: e.deltaJson, reportHash: e.reportHash, preparedStepIndex: e.preparedStepIndex };
  }

  stepView(s: StepRow) {
    const sj = s.stepJson as { step: MandateStep; routerCalldata: `0x${string}`; domain: unknown; reportHash: string };
    const cj = s.certificateJson as { certificate: StepCertificate; signer: string };
    return {
      stepId: s.id,
      stepIndex: s.stepIndex,
      state: s.state,
      step: sj.step,
      stepDigest: s.stepDigest,
      typedData: { domain: sj.domain, types: EIP712_TYPES_V2, primaryType: "MandateStep" as const, message: sj.step },
      certificate: cj.certificate,
      certificateSignature: s.certificateSignature,
      attestationSigner: cj.signer,
      routerCalldata: sj.routerCalldata,
      validUntil: s.validUntil.toISOString(),
      pulledAt: s.pulledAt?.toISOString() ?? null,
      txHash: s.txHash,
      receipt: (s.receiptJson as Record<string, unknown> | null) ?? null,
      reportHash: sj.reportHash,
    };
  }

  /* ---------- 链下状态 ---------- */

  async transition(callerId: string, id: string, to: "PAUSED" | "ACTIVE" | "CANCELLED"): Promise<MandateRow> {
    const row = await this.requireMandate(callerId, id);
    const from = row.state as MandateState;
    const allowed: Record<string, MandateState[]> = { PAUSED: ["ACTIVE"], ACTIVE: ["PAUSED"], CANCELLED: ["ACTIVE", "PAUSED", "DRAFT"] };
    if (!allowed[to]!.includes(from)) throw new HttpError(409, "invalid_transition", `${from} → ${to} 不允许`);
    const now = this.now();
    const [updated] = await this.d.db.update(verifyMandates).set({ state: to, updatedAt: now }).where(and(eq(verifyMandates.id, id), eq(verifyMandates.state, from))).returning();
    if (!updated) throw new HttpError(409, "concurrent_update");
    if (to !== "ACTIVE") {
      // 暂停/取消：未拉取的 PREPARED 步骤作废
      await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", updatedAt: now }).where(and(eq(verifyMandateSteps.mandateId, id), eq(verifyMandateSteps.state, "PREPARED"), isNull(verifyMandateSteps.txHash)));
    }
    return updated;
  }

  /* ---------- 评估（monitor 与 prepare-step 共用） ---------- */

  /** 下一步的目标腿：按 stepIndex 轮转 */
  private nextStepJob(row: MandateRow): { job: NormalizedJob; outputToken: EvmAddress; amountIn: bigint } | null {
    const json = row.mandateJson as MandateJson;
    const policy = row.policySnapshot as { definition: EffectivePolicy["definition"]; params: EffectivePolicy["params"] };
    const remaining = BigInt(row.budgetCap) - BigInt(row.spent);
    if (remaining <= 0n || row.stepsDone >= row.maxSteps) return null;
    const leg = json.legs[row.stepsDone % json.legs.length]!;
    const planned = (BigInt(row.budgetCap) * BigInt(leg.weightBps)) / 10_000n;
    let amountIn = planned;
    if (amountIn > BigInt(json.mandate.perStepCap)) amountIn = BigInt(json.mandate.perStepCap);
    if (amountIn > remaining) amountIn = remaining;
    if (amountIn <= 0n) return null;
    const outEntry = findEntry(this.d.registry, leg.outputAssetKey)!;
    // 卖出（rebasing 输入）：报价/路由按 amountIn − tolerance 取，步骤 amountIn 仍为全额（D2：路由多拉会 revert）
    const routeAmount = json.side === "sell" ? (amountIn > BigInt(this.d.cfg.SELL_INPUT_TOLERANCE_WEI) ? amountIn - BigInt(this.d.cfg.SELL_INPUT_TOLERANCE_WEI) : amountIn) : amountIn;
    const job: NormalizedJob = {
      clientRequestId: `${row.id}:${row.stepsDone}`,
      ownerAddress: row.ownerAddress as EvmAddress,
      recipientAddress: normalizeAddress(json.mandate.recipient),
      executionChainId: row.chainId,
      inputAssetKey: json.side === "sell" ? leg.outputAssetKey : json.inputAssetKey,
      outputAssetKey: json.side === "sell" ? json.inputAssetKey : leg.outputAssetKey,
      amountInRaw: routeAmount.toString(),
      mode: "exactIn",
      policyId: policy.definition.policyId,
      policyVersion: policy.definition.version,
      params: policy.params,
      ...(json.side === "sell" ? { side: "sell" as const } : {}),
    };
    return { job, outputToken: (json.side === "sell" ? findEntry(this.d.registry, json.inputAssetKey)!.tokenAddress : outEntry.tokenAddress) as EvmAddress, amountIn };
  }

  /** 过期未执行的步骤作废（M-13） */
  async expireSteps(): Promise<number> {
    const now = this.now();
    const rows = await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", updatedAt: now }).where(and(eq(verifyMandateSteps.state, "PREPARED"), isNull(verifyMandateSteps.txHash), lt(verifyMandateSteps.validUntil, now))).returning({ id: verifyMandateSteps.id });
    return rows.length;
  }

  /** 到期授权 → EXPIRED */
  async expireMandates(): Promise<number> {
    const now = this.now();
    const rows = await this.d.db.update(verifyMandates).set({ state: "EXPIRED", updatedAt: now }).where(and(inArray(verifyMandates.state, ["ACTIVE", "PAUSED", "DRAFT"]), lt(verifyMandates.deadline, now))).returning({ id: verifyMandates.id });
    return rows.length;
  }

  async activeMandates(opts: { standalone?: boolean } = {}): Promise<MandateRow[]> {
    const rows = await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.state, ["ACTIVE", "PAUSED"]));
    // v6：挂在任务上的授权只经任务前置链（条件闸门）评估，mandates monitor 不直接对它签发
    return opts.standalone ? rows.filter((r) => !r.taskId) : rows;
  }

  /**
   * 一次评估：取新证据 → 报告 → 状态 → delta → 落库；ACTIVE 且 READY → 预生成步骤证书（未拉取不算已发出）。
   * PAUSED：照常评估（记录变化），但不签发步骤（M-14）。
   */
  async evaluate(row0: MandateRow, opts: EvaluateOptions = {}): Promise<{ evaluation: EvaluationRow; step: StepRow | null }> {
    const row = (await this.byId(row0.id)) ?? row0;
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const prev = await this.latestEvaluation(row.id);
    const prevReport = (prev?.reportJson as VerifyReport | null) ?? null;
    const next = this.nextStepJob(row);
    const policy = row.policySnapshot as { definition: EffectivePolicy["definition"]; params: EffectivePolicy["params"] };
    const eff: EffectivePolicy = { definition: policy.definition, params: policy.params, policyDefinitionHash: row.policyDefinitionHash as `0x${string}`, effectivePolicyHash: row.effectivePolicyHash as `0x${string}` };

    if (!next) {
      const [evaluation] = await this.d.db.insert(verifyMandateEvaluations).values({ id: newId("evl"), mandateId: row.id, evaluatedAt: nowDate, status: "DONE", reportJson: null, reportHash: null, evidenceJson: [], reasonsJson: [], deltaJson: null, preparedStepIndex: null }).returning();
      if (row.state === "ACTIVE" || row.state === "PAUSED") await this.d.db.update(verifyMandates).set({ state: "COMPLETED", updatedAt: nowDate }).where(eq(verifyMandates.id, row.id));
      return { evaluation: evaluation!, step: null };
    }

    let collected: Awaited<ReturnType<EvidenceProvider["collect"]>>;
    try {
      // 步骤由 PlanGuard 执行：路由收款人必须是 PlanGuard（I2 2026-09-21 端到端发现）
      collected = await this.d.evidence.collect(next.job, this.d.registry, nowIso, { executorContract: row.planGuardAddress as EvmAddress });
    } catch (err) {
      const [evaluation] = await this.d.db.insert(verifyMandateEvaluations).values({ id: newId("evl"), mandateId: row.id, evaluatedAt: nowDate, status: "WAIT", reportJson: null, reportHash: null, evidenceJson: [], reasonsJson: [{ code: "QUOTE_UNAVAILABLE", severity: "block", evidenceIds: [], detail: { error: err instanceof Error ? err.message.slice(0, 200) : String(err) } }], deltaJson: null, preparedStepIndex: null }).returning();
      return { evaluation: evaluation!, step: null };
    }
    const report = buildReport({ jobId: row.id, reportVersion: (prev ? await this.countEvaluations(row.id) : 0) + 1, job: next.job, policy: eff, registry: this.d.registry, evidence: collected.evidence, evaluatedAt: nowIso });
    const withinWindow = Number(nowDate.getTime() / 1000) >= row.validFrom.getTime() / 1000 && nowDate.getTime() <= row.deadline.getTime();
    let status: MandateEvalStatus;
    if (report.executionEligible && collected.route && withinWindow) status = "READY";
    else {
      const blocks = report.reasons.filter((r) => r.severity === "block").map((r) => r.code);
      status = blocks.length === 0 || blocks.every((c) => WAIT_CODES.has(c)) || !withinWindow ? "WAIT" : blocks.some((c) => HARD_BLOCK_CODES.has(c) && !WAIT_CODES.has(c)) ? "BLOCKED" : "WAIT";
    }
    const delta = explainDelta(prevReport, report);
    // v6 Lane B：条件闸门——授权层 READY 也要过条件层（用本轮报价/参考价证据），不过 → WAIT，不签发
    let reasons: Reason[] = report.reasons;
    if (opts.gate) {
      const g = await opts.gate({ report, evidence: collected.evidence, nowIso });
      if (!g.ok) {
        status = status === "BLOCKED" ? "BLOCKED" : "WAIT";
        reasons = [...report.reasons, ...g.reasons];
      }
    }
    const [evaluation] = await this.d.db
      .insert(verifyMandateEvaluations)
      .values({ id: newId("evl"), mandateId: row.id, evaluatedAt: nowDate, status, reportJson: report, jobJson: next.job, reportHash: reportHash(report), evidenceJson: collected.evidence, reasonsJson: reasons, deltaJson: delta, preparedStepIndex: null })
      .returning();

    let step: StepRow | null = null;
    if (status === "READY" && row.state === "ACTIVE" && opts.issue !== false) {
      // 已有未过期的 PREPARED 步骤（同 index）→ 复用，不重复签发
      const existing = (await this.d.db.select().from(verifyMandateSteps).where(and(eq(verifyMandateSteps.mandateId, row.id), eq(verifyMandateSteps.stepIndex, row.stepsDone))).limit(1))[0];
      if (existing && (existing.state === "SUBMITTED" || existing.state === "REORG_PENDING" || existing.state === "CONFIRMED")) step = existing;
      else if (existing && existing.state === "PREPARED" && existing.validUntil.getTime() > nowDate.getTime()) step = existing;
      else step = await this.issueStep(row, evaluation!, next, collected.route!, report, collected.evidence);
      await this.d.db.update(verifyMandateEvaluations).set({ preparedStepIndex: step.stepIndex }).where(eq(verifyMandateEvaluations.id, evaluation!.id));
      evaluation!.preparedStepIndex = step.stepIndex;
    }
    return { evaluation: evaluation!, step };
  }

  private async countEvaluations(mandateId: string): Promise<number> {
    return (await this.d.db.select({ id: verifyMandateEvaluations.id }).from(verifyMandateEvaluations).where(eq(verifyMandateEvaluations.mandateId, mandateId))).length;
  }

  private async issueStep(row: MandateRow, evaluation: EvaluationRow, next: NonNullable<ReturnType<MandatesService["nextStepJob"]>>, route: { router: EvmAddress; spender: EvmAddress; calldata: `0x${string}` }, report: VerifyReport, _evidence: EvidenceRecord[]): Promise<StepRow> {
    if (!this.d.signer) throw new HttpError(503, "attestation_disabled");
    const json = row.mandateJson as MandateJson;
    const nowDate = this.now();
    const issuedAt = Math.floor(nowDate.getTime() / 1000);
    let validUntil = certificateValidUntil(issuedAt, (row.policySnapshot as { definition: EffectivePolicy["definition"] }).definition, report);
    validUntil = Math.min(validUntil, Math.floor(row.deadline.getTime() / 1000), issuedAt + 120); // PlanGuard：validUntil ≤ min(step.deadline, m.deadline)，TTL ≤ 120 s
    const planGuard = row.planGuardAddress as EvmAddress;
    const domain = makePlanGuardDomain(row.chainId, planGuard);
    const step: MandateStep = {
      mandateDigest: row.mandateDigest as `0x${string}`,
      stepIndex: String(row.stepsDone),
      outputToken: next.outputToken,
      amountIn: next.amountIn.toString(),
      minAmountOut: report.normalizedQuote!.minOutRaw,
      router: route.router,
      spender: route.spender,
      calldataHash: calldataHashOf(route.calldata),
      evidenceHash: report.evidenceHash,
      deadline: String(validUntil),
    };
    const sd = stepDigest(domain, step);
    const cert: StepCertificate = { stepDigest: sd, evidenceHash: report.evidenceHash, policyDefinitionHash: row.policyDefinitionHash as `0x${string}`, effectivePolicyHash: row.effectivePolicyHash as `0x${string}`, issuedAt: String(issuedAt), validUntil: String(validUntil), signerEpoch: String(this.d.signer.epoch) };
    const signed = await this.d.signer.signStepCertificate(row.chainId, planGuard, cert);
    // 同 index 旧的 PREPARED/EXPIRED 行：删除后重签（唯一约束 (mandate, stepIndex)）
    await this.d.db.delete(verifyMandateSteps).where(and(eq(verifyMandateSteps.mandateId, row.id), eq(verifyMandateSteps.stepIndex, row.stepsDone), inArray(verifyMandateSteps.state, ["PREPARED", "EXPIRED"]), isNull(verifyMandateSteps.txHash)));
    const [inserted] = await this.d.db
      .insert(verifyMandateSteps)
      .values({ id: newId("stp"), mandateId: row.id, stepIndex: row.stepsDone, evaluationId: evaluation.id, state: "PREPARED", stepJson: { step, routerCalldata: route.calldata, domain, reportHash: reportHash(report), outputSet: json.outputSet, mandate: json.mandate, mandateSignature: row.signature }, stepDigest: sd, certificateJson: { certificate: cert, signer: this.d.signer.address }, certificateSignature: signed.signature, validUntil: new Date(validUntil * 1000), pulledAt: null, txHash: null, receiptJson: null, createdAt: nowDate, updatedAt: nowDate })
      .returning();
    log.info("步骤证书已签发", { mandateId: row.id, stepIndex: row.stepsDone, validUntil });
    return inserted!;
  }

  /* ---------- prepare-step / submissions ---------- */

  async prepareStep(callerId: string, id: string, opts: EvaluateOptions = {}) {
    const row = await this.requireMandate(callerId, id);
    if (!["ACTIVE", "PAUSED"].includes(row.state)) throw new HttpError(409, "mandate_not_active", `授权计划状态 ${row.state}`);
    if (row.state === "PAUSED") return { status: "WAIT" as const, reasons: [], delta: null, message: "mandate is paused; no step certificate is issued while paused", step: null, stepIndex: row.stepsDone };
    await this.expireSteps();
    const { evaluation, step } = await this.evaluate(row, opts);
    // 同一步已提交/待重组确认：不能再当 READY 交出去，否则执行者重复提交会被合约以 StepOutOfOrder 回滚
    // （链上 stepIndex 只在回执确认后推进；I2 2026-09-21 端到端发现）
    if (step && (step.state === "SUBMITTED" || step.state === "REORG_PENDING")) {
      return {
        status: "WAIT" as const,
        stepIndex: step.stepIndex,
        evaluation: this.evalView(evaluation),
        reasons: [{ code: "STEP_AWAITING_CONFIRMATION" as ReasonCode, severity: "info" as const, evidenceIds: [], detail: { stepIndex: step.stepIndex, txHash: step.txHash, state: step.state } }],
        delta: evaluation.deltaJson,
        message: `step ${step.stepIndex} already submitted (${step.txHash ?? "no tx"}); waiting for on-chain confirmation before the next step`,
        step: null,
      };
    }
    if (evaluation.status === "READY" && step) {
      if (!step.pulledAt) await this.d.db.update(verifyMandateSteps).set({ pulledAt: this.now(), updatedAt: this.now() }).where(eq(verifyMandateSteps.id, step.id));
      const sv = this.stepView(step);
      const sj = step.stepJson as { outputSet: EvmAddress[]; mandate: TradeMandate; mandateSignature: string };
      return {
        status: "READY" as const,
        stepIndex: step.stepIndex,
        typedData: sv.typedData,
        step: sv.step,
        stepDigest: sv.stepDigest,
        certificate: sv.certificate,
        certificateSignature: sv.certificateSignature,
        attestationSigner: sv.attestationSigner,
        routerCalldata: sv.routerCalldata,
        outputSet: sj.outputSet,
        planGuard: row.planGuardAddress,
        validUntil: sv.validUntil,
        mandate: sj.mandate,
        mandateSignature: sj.mandateSignature,
        evaluation: this.evalView(evaluation),
        guardCall: { to: row.planGuardAddress, functionName: "executeStep", abi: PLANGUARD_ABI, args: { m: sj.mandate, mandateSig: sj.mandateSignature, outputSet: sj.outputSet, s: sv.step, c: sv.certificate, certSig: sv.certificateSignature, routerCalldata: sv.routerCalldata }, argOrder: ["m", "mandateSig", "outputSet", "s", "c", "certSig", "routerCalldata"], value: "0", gasHint: "650000" },
        approval: { token: (row.mandateJson as MandateJson).mandate.inputToken, spender: row.planGuardAddress, amount: sv.step.amountIn, note: "执行者需确保 owner 已向 PlanGuard 授权 ≥ amountIn（一次授权 budgetCap 即可）" },
      };
    }
    return { status: evaluation.status, stepIndex: row.stepsDone, evaluation: this.evalView(evaluation), reasons: evaluation.reasonsJson, delta: evaluation.deltaJson, step: null };
  }

  async recordSubmission(callerId: string, id: string, stepIndex: number, txHash: string): Promise<StepRow> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, "invalid_tx_hash");
    await this.requireMandate(callerId, id);
    const step = (await this.d.db.select().from(verifyMandateSteps).where(and(eq(verifyMandateSteps.mandateId, id), eq(verifyMandateSteps.stepIndex, stepIndex))).limit(1))[0];
    if (!step) throw new HttpError(404, "step_not_found");
    if (step.txHash && step.txHash.toLowerCase() !== txHash.toLowerCase()) throw new HttpError(409, "tx_hash_conflict");
    if (step.state === "EXPIRED" && !step.txHash) throw new HttpError(409, "step_expired", "该步骤证书已过期，需重新 prepare-step");
    const now = this.now();
    const [updated] = await this.d.db.update(verifyMandateSteps).set({ txHash: txHash.toLowerCase(), state: step.txHash ? step.state : "SUBMITTED", updatedAt: now }).where(eq(verifyMandateSteps.id, step.id)).returning();
    return updated!;
  }

  /* ---------- ReceiptStore（回执核实器复用，事件 MandateStep） ---------- */

  async pendingExecutionAttempts(): Promise<ReceiptAttempt[]> {
    const rows = await this.d.db.select().from(verifyMandateSteps).where(inArray(verifyMandateSteps.state, ["SUBMITTED", "REORG_PENDING", "UNKNOWN"]));
    return rows.filter((r) => r.txHash).map((r) => ({ id: r.id, state: r.state, txHash: r.txHash, intentDigest: `${(r.stepJson as { step: MandateStep }).step.mandateDigest.toLowerCase()}:${r.stepIndex}`, updatedAt: r.updatedAt, receiptJson: r.receiptJson }));
  }

  async applyReceipt(stepId: string, state: "CONFIRMED" | "REVERTED" | "UNKNOWN" | "REORG_PENDING" | "SUBMITTED", receipt: Record<string, unknown>): Promise<void> {
    const now = this.now();
    const step = (await this.d.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.id, stepId)).limit(1))[0];
    if (!step) return;
    const wasConfirmed = step.state === "CONFIRMED";
    await this.d.db.update(verifyMandateSteps).set({ state, receiptJson: receipt, updatedAt: now }).where(eq(verifyMandateSteps.id, stepId));
    if (state === "CONFIRMED" && !wasConfirmed) {
      const ev = receipt["event"] as { spent?: string } | undefined;
      const row = await this.byId(step.mandateId);
      if (!row) return;
      const spent = (BigInt(row.spent) + BigInt(ev?.spent ?? "0")).toString();
      const stepsDone = Math.max(row.stepsDone, step.stepIndex + 1);
      const json = row.mandateJson as MandateJson;
      const remaining = BigInt(row.budgetCap) - BigInt(spent);
      const minStep = json.legs.reduce((m, l) => (BigInt(row.budgetCap) * BigInt(l.weightBps)) / 10_000n < m ? (BigInt(row.budgetCap) * BigInt(l.weightBps)) / 10_000n : m, BigInt(row.budgetCap));
      const done = stepsDone >= row.maxSteps || remaining <= 0n || remaining < (minStep < BigInt(json.mandate.perStepCap) ? minStep : BigInt(json.mandate.perStepCap)) / 10n;
      await this.d.db.update(verifyMandates).set({ spent, stepsDone, state: done && (row.state === "ACTIVE" || row.state === "PAUSED") ? "COMPLETED" : row.state, updatedAt: now }).where(eq(verifyMandates.id, row.id));
      log.info("授权计划步骤已确认", { mandateId: row.id, stepIndex: step.stepIndex, spent, stepsDone, completed: done });
      if (this.stepListener) await this.stepListener({ mandateId: row.id, taskId: row.taskId ?? null, stepIndex: step.stepIndex, spentRaw: ev?.spent ?? "0", confirmedAt: now }).catch((err) => log.warn("任务步骤确认监听失败", { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** monitor 间隔：常规时段 30 s，其余 5 min */
  intervalMs(): number {
    return sessionAt(this.now()).session === "REGULAR" ? this.d.cfg.MONITOR_INTERVAL_REGULAR_MS : this.d.cfg.MONITOR_INTERVAL_CLOSED_MS;
  }
}

/* ---- v6 Lane B：带 conditionsHash 的有效策略（结构扩展，不改冻结的 EffectivePolicyParams） ---- */
export function policyWithConditions(def: EffectivePolicy["definition"], params: EffectivePolicy["params"], conditionsHash: Bytes32): EffectivePolicy {
  const base = buildEffectivePolicy(def, params);
  const withHash = withConditionsHash(params, conditionsHash);
  return { definition: def, policyDefinitionHash: base.policyDefinitionHash, params: withHash, effectivePolicyHash: computeEffectivePolicyHash(base.policyDefinitionHash, withHash) };
}
