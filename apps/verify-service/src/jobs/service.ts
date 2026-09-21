/**
 * 任务用例层：HTTP / MCP / 页面共用同一套函数（技术设计 §3、§6.1、§7.4、§9.2）。
 * 只有这里能：创建任务、生成报告版本、预留/消耗额度、分配执行 nonce、签发证书。
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { verifyTypedData } from "viem";
import { randomBytes } from "node:crypto";
import type { Db } from "@chaconne/db";
import { verifyEvidence, verifyExecutionAttempts, verifyJobs, verifyReports } from "@chaconne/db";
import {
  buildReport,
  calldataHash as calldataHashOf,
  findEntry,
  intentDigest,
  makeDomain,
  registryHash,
  reportHash,
  requestHash,
  toCreateVerifyJob,
  validateCreateJob,
  EIP712_TYPES,
  type AssetRegistry,
  type EffectivePolicy,
  type EvmAddress,
  type NormalizedJob,
  type PolicyDefinition,
  type TradeIntent,
  type VerificationCertificate,
  type VerifyReport,
  type ValidationError,
} from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { AttestationSigner } from "../attestation/signer";
import type { EvidenceProvider } from "../evidence/provider";
import { GUARD_ABI } from "../execution/guardAbi";
import { newId } from "../ids";
import { log } from "../log";
import { Orders, type OrderRow } from "../payments/orders";

export type JobRow = typeof verifyJobs.$inferSelect;
export type ReportRow = typeof verifyReports.$inferSelect;
export type ExecutionAttemptRow = typeof verifyExecutionAttempts.$inferSelect;

export interface ServiceDeps {
  db: Db;
  cfg: VerifyConfig;
  registry: AssetRegistry;
  evidence: EvidenceProvider;
  signer: AttestationSigner | null;
  orders: Orders;
  now?: () => Date;
}

/**
 * 证书有效期（FIX-088 / G-13）：不得超过数据本身的时效——
 *   validUntil = min(issuedAt + certificateTtlSeconds, quote.receivedAt + quoteMaxAgeSeconds, [STRICT_LIVE] reference.sourcePublishedAt + liveReferenceMaxAgeSeconds)
 * 且至少 issuedAt + 1（同秒内已过期的数据在评估层就会被拒，这里只兜底）。
 */
export function certificateValidUntil(issuedAt: number, def: PolicyDefinition, report: Pick<VerifyReport, "normalizedQuote" | "reference">): number {
  let v = issuedAt + def.certificateTtlSeconds;
  if (report.normalizedQuote?.receivedAt) v = Math.min(v, Math.floor(Date.parse(report.normalizedQuote.receivedAt) / 1000) + def.quoteMaxAgeSeconds);
  if (def.referenceRequirement === "live" && report.reference?.sourcePublishedAt) v = Math.min(v, Math.floor(Date.parse(report.reference.sourcePublishedAt) / 1000) + def.liveReferenceMaxAgeSeconds);
  return Math.max(v, issuedAt + 1);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export interface JobView {
  jobId: string;
  clientRequestId: string;
  requestHash: string;
  job: NormalizedJob;
  policyDefinitionHash: string;
  effectivePolicyHash: string;
  registryVersion: string;
  registryHash: string;
  createdAt: string;
  order: {
    orderId: string;
    state: string;
    priceUsd: string;
    network: string;
    settledAt: string | null;
    deliveredAt: string | null;
  };
  entitlement: { expiresAt: string; maxRefreshes: number; usedRefreshes: number; remaining: number } | null;
  latestReport: { version: number; verdict: string; executionEligible: boolean; evaluatedAt: string; evidenceHash: string } | null;
  executions: Array<{ attemptId: string; reportVersion: number; state: string; validUntil: string | null; txHash: string | null; receipt: Record<string, unknown> | null }>;
  evidenceMode: "FIXTURE" | "LIVE";
}

export class VerifyService {
  private readonly now: () => Date;
  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  get registry(): AssetRegistry {
    return this.d.registry;
  }

  /* ---------- 创建任务（幂等） ---------- */

  async createJob(callerId: string, raw: unknown): Promise<{ status: 200 | 201; body: JobView }> {
    const v = validateCreateJob(raw);
    if (!v.ok) throw new HttpError(400, "invalid_request", "请求校验失败", v.errors satisfies ValidationError[]);
    const { job, policy } = v;
    if (job.executionChainId !== this.d.cfg.EXECUTION_CHAIN_ID) {
      throw new HttpError(400, "invalid_request", "executionChainId 与服务配置不一致", [{ field: "executionChainId", code: "unsupported" }]);
    }
    if (!findEntry(this.d.registry, job.inputAssetKey) || !findEntry(this.d.registry, job.outputAssetKey)) {
      throw new HttpError(400, "asset_unsupported", "资产不在登记表内（见 GET /v1/assets）");
    }
    const reqHash = requestHash(job);

    const existing = await this.findByClientRequest(callerId, job.clientRequestId);
    if (existing) {
      if (existing.requestHash !== reqHash) throw new HttpError(409, "idempotency_conflict", "同一 clientRequestId 已绑定不同请求内容");
      return { status: 200, body: await this.view(existing) };
    }

    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const jobId = newId("job");
    const regHash = registryHash(this.d.registry);

    // 先算报告（上游完全不可用时抛错，不落库不收费）
    const collected = await this.d.evidence.collect(job, this.d.registry, nowIso);
    const report = buildReport({
      jobId,
      reportVersion: 1,
      job,
      policy,
      registry: this.d.registry,
      evidence: collected.evidence,
      evaluatedAt: nowIso,
    });

    let inserted: JobRow | undefined;
    {
      [inserted] = await this.d.db
        .insert(verifyJobs)
        .values({
          id: jobId,
          callerId,
          clientRequestId: job.clientRequestId,
          requestHash: reqHash,
          jobJson: job,
          policyDefinitionHash: policy.policyDefinitionHash,
          effectivePolicyHash: policy.effectivePolicyHash,
          policySnapshot: { definition: policy.definition, params: policy.params },
          registryVersion: this.d.registry.version,
          registryHash: regHash,
          executionChainId: job.executionChainId,
          guardAddress: null,
          ownerAddress: job.ownerAddress,
          executionNonce: null,
          createdAt: nowDate,
        })
        .onConflictDoNothing()
        .returning();
    }
    if (!inserted) {
      // 并发同键：另一请求赢了
      const again = await this.findByClientRequest(callerId, job.clientRequestId);
      if (!again) throw new HttpError(500, "internal", "任务插入失败");
      if (again.requestHash !== reqHash) throw new HttpError(409, "idempotency_conflict");
      return { status: 200, body: await this.view(again) };
    }
    await this.persistReport(jobId, 1, report, collected.evidence, nowDate);
    await this.d.orders.create({
      jobId,
      priceUsd: this.d.cfg.REPORT_PRICE_USD,
      network: this.d.cfg.PAYMENT_NETWORK,
      merchant: this.d.cfg.MERCHANT_RECIPIENT_ADDRESS || "0x0000000000000000000000000000000000000000",
    });
    log.info("任务已创建", { jobId, callerId, verdict: report.verdict, evidenceMode: this.d.evidence.mode });
    return { status: 201, body: await this.view(inserted) };
  }

  private async persistReport(jobId: string, version: number, report: VerifyReport, evidence: Parameters<typeof buildReport>[0]["evidence"], at: Date): Promise<void> {
    if (evidence.length > 0) {
      await this.d.db.insert(verifyEvidence).values(
        evidence.map((e) => ({ evidenceId: e.evidenceId, jobId, reportVersion: version, record: e, rawRef: null, createdAt: at })),
      );
    }
    await this.d.db.insert(verifyReports).values({
      jobId,
      version,
      reportJson: report,
      reportHash: reportHash(report),
      evidenceHash: report.evidenceHash,
      policyDefinitionHash: report.policyDefinitionHash,
      effectivePolicyHash: report.effectivePolicyHash,
      verdict: report.verdict,
      createdAt: at,
    });
  }

  /* ---------- 查询 ---------- */

  private async findByClientRequest(callerId: string, clientRequestId: string): Promise<JobRow | null> {
    return (
      (await this.d.db.select().from(verifyJobs).where(and(eq(verifyJobs.callerId, callerId), eq(verifyJobs.clientRequestId, clientRequestId))).limit(1))[0] ?? null
    );
  }

  /** 任务所有权校验：非本调用方 → 404（不泄漏存在性）。 */
  async requireJob(callerId: string, jobId: string): Promise<JobRow> {
    const row = (await this.d.db.select().from(verifyJobs).where(eq(verifyJobs.id, jobId)).limit(1))[0];
    if (!row || row.callerId !== callerId) throw new HttpError(404, "job_not_found");
    return row;
  }

  async requireOrder(jobId: string): Promise<OrderRow> {
    const order = await this.d.orders.byJobId(jobId);
    if (!order) throw new HttpError(500, "order_missing");
    return order;
  }

  async latestReport(jobId: string): Promise<ReportRow | null> {
    return (await this.d.db.select().from(verifyReports).where(eq(verifyReports.jobId, jobId)).orderBy(desc(verifyReports.version)).limit(1))[0] ?? null;
  }

  async reportVersion(jobId: string, version: number): Promise<ReportRow | null> {
    return (await this.d.db.select().from(verifyReports).where(and(eq(verifyReports.jobId, jobId), eq(verifyReports.version, version))).limit(1))[0] ?? null;
  }

  async evidenceFor(jobId: string, version: number) {
    return this.d.db.select().from(verifyEvidence).where(and(eq(verifyEvidence.jobId, jobId), eq(verifyEvidence.reportVersion, version)));
  }

  async executions(jobId: string): Promise<ExecutionAttemptRow[]> {
    return this.d.db.select().from(verifyExecutionAttempts).where(eq(verifyExecutionAttempts.jobId, jobId)).orderBy(desc(verifyExecutionAttempts.createdAt));
  }

  async view(row: JobRow): Promise<JobView> {
    const order = await this.requireOrder(row.id);
    const ent = await this.d.orders.entitlement(order.id);
    const latest = await this.latestReport(row.id);
    const execs = await this.executions(row.id);
    const latestJson = latest?.reportJson as VerifyReport | undefined;
    return {
      jobId: row.id,
      clientRequestId: row.clientRequestId,
      requestHash: row.requestHash,
      job: row.jobJson as NormalizedJob,
      policyDefinitionHash: row.policyDefinitionHash,
      effectivePolicyHash: row.effectivePolicyHash,
      registryVersion: row.registryVersion,
      registryHash: row.registryHash,
      createdAt: row.createdAt.toISOString(),
      order: {
        orderId: order.id,
        state: order.state,
        priceUsd: order.priceUsd,
        network: order.network,
        settledAt: order.settledAt?.toISOString() ?? null,
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
      },
      entitlement: ent
        ? {
            expiresAt: ent.expiresAt.toISOString(),
            maxRefreshes: ent.maxRefreshes,
            usedRefreshes: ent.usedRefreshes,
            remaining: Math.max(0, ent.maxRefreshes - ent.usedRefreshes - ent.reservedRefreshes),
          }
        : null,
      latestReport: latestJson
        ? { version: latest!.version, verdict: latestJson.verdict, executionEligible: latestJson.executionEligible, evaluatedAt: latestJson.evaluatedAt, evidenceHash: latestJson.evidenceHash }
        : null,
      executions: execs.map((e) => ({ attemptId: e.id, reportVersion: e.reportVersion, state: e.state, validUntil: e.validUntil?.toISOString() ?? null, txHash: e.txHash, receipt: (e.receiptJson as Record<string, unknown> | null) ?? null })),
      evidenceMode: this.d.evidence.mode,
    };
  }

  /** 付费报告交付内容（付款闸门由 HTTP 层负责；本函数假定已放行）。 */
  async deliverReport(jobId: string, version?: number) {
    const rep = version ? await this.reportVersion(jobId, version) : await this.latestReport(jobId);
    if (!rep) throw new HttpError(404, "report_not_found");
    const ev = await this.evidenceFor(jobId, rep.version);
    return { report: rep.reportJson as VerifyReport, reportHash: rep.reportHash, evidence: ev.map((e) => e.record) };
  }

  /* ---------- 准备执行（消耗额度，新证据版本，证书） ---------- */

  async prepareExecution(callerId: string, jobId: string, refreshKey: string) {
    if (!/^[A-Za-z0-9_\-:.]{1,128}$/.test(refreshKey)) throw new HttpError(400, "invalid_refresh_key");
    const job = await this.requireJob(callerId, jobId);
    const order = await this.requireOrder(jobId);
    if (!this.d.orders.isDeliverable(order)) throw new HttpError(402, "payment_required", "报告尚未付款", { orderState: order.state });
    const guard = this.d.cfg.GUARD_ADDRESS as EvmAddress;
    if (!guard) throw new HttpError(503, "guard_not_configured");
    if (!this.d.signer) throw new HttpError(503, "attestation_disabled");

    // 幂等：同 refreshKey 返回同一结果，不消耗额度
    const prior = (
      await this.d.db.select().from(verifyExecutionAttempts).where(and(eq(verifyExecutionAttempts.jobId, jobId), eq(verifyExecutionAttempts.refreshKey, refreshKey))).limit(1)
    )[0];
    if (prior) return { status: prior.certificateJson ? 200 : 422, body: await this.attemptView(prior, job), replay: true };

    const reserved = await this.d.orders.reserveRefresh(order.id);
    if (!reserved) {
      const ent = await this.d.orders.entitlement(order.id);
      throw new HttpError(409, "entitlement_exhausted", "再核验额度已用尽或已过期；需要新建任务", {
        expiresAt: ent?.expiresAt.toISOString() ?? null,
        usedRefreshes: ent?.usedRefreshes ?? null,
        maxRefreshes: ent?.maxRefreshes ?? null,
      });
    }

    try {
      const nowDate = this.now();
      const nowIso = nowDate.toISOString();
      const normalized = job.jobJson as NormalizedJob;
      const policy: EffectivePolicy = {
        definition: (job.policySnapshot as EffectivePolicy["definition"] extends infer D ? { definition: D; params: EffectivePolicy["params"] } : never).definition,
        params: (job.policySnapshot as { params: EffectivePolicy["params"] }).params,
        policyDefinitionHash: job.policyDefinitionHash as `0x${string}`,
        effectivePolicyHash: job.effectivePolicyHash as `0x${string}`,
      };
      const latest = await this.latestReport(jobId);
      const version = (latest?.version ?? 0) + 1;
      const collected = await this.d.evidence.collect(normalized, this.d.registry, nowIso);
      const report = buildReport({ jobId, reportVersion: version, job: normalized, policy, registry: this.d.registry, evidence: collected.evidence, evaluatedAt: nowIso });
      await this.persistReport(jobId, version, report, collected.evidence, nowDate);

      const inEntry = findEntry(this.d.registry, normalized.inputAssetKey)!;
      const outEntry = findEntry(this.d.registry, normalized.outputAssetKey)!;
      const route = collected.route;

      if (!report.executionEligible || !route || !report.normalizedQuote) {
        // 拒绝也是一次已交付的核验：消耗额度，记录 REJECTED
        const [attempt] = await this.d.db
          .insert(verifyExecutionAttempts)
          .values({
            id: newId("exe"),
            jobId,
            refreshKey,
            reportVersion: version,
            nonce: job.executionNonce ?? "",
            intentJson: {},
            intentDigest: "",
            calldataHash: "",
            certificateJson: null,
            certificateSignature: null,
            validUntil: null,
            state: "REJECTED",
            txHash: null,
            receiptJson: null,
            createdAt: nowDate,
            updatedAt: nowDate,
          })
          .returning();
        await this.d.orders.consumeRefresh(order.id);
        return { status: 422 as const, body: await this.attemptView(attempt!, job), replay: false };
      }

      const nonce = await this.ensureNonce(job, guard);
      const issuedAt = Math.floor(nowDate.getTime() / 1000);
      const validUntil = certificateValidUntil(issuedAt, policy.definition, report);
      const cdHash = calldataHashOf(route.calldata);
      const intent: TradeIntent = {
        owner: normalized.ownerAddress,
        recipient: normalized.recipientAddress,
        inputToken: inEntry.tokenAddress,
        outputToken: outEntry.tokenAddress,
        amountIn: normalized.amountInRaw,
        minAmountOut: report.normalizedQuote.minOutRaw,
        router: route.router,
        spender: route.spender,
        calldataHash: cdHash,
        policyDefinitionHash: policy.policyDefinitionHash,
        effectivePolicyHash: policy.effectivePolicyHash,
        registryHash: report.registryHash,
        evidenceHash: report.evidenceHash,
        nonce,
        deadline: String(validUntil),
      };
      const domain = makeDomain(normalized.executionChainId, guard);
      const digest = intentDigest(domain, intent);
      const cert: VerificationCertificate = {
        intentDigest: digest,
        evidenceHash: report.evidenceHash,
        policyDefinitionHash: policy.policyDefinitionHash,
        effectivePolicyHash: policy.effectivePolicyHash,
        issuedAt: String(issuedAt),
        validUntil: String(validUntil),
        signerEpoch: String(this.d.signer.epoch),
      };
      const signed = await this.d.signer.signCertificate(normalized.executionChainId, guard, cert);

      const [attempt] = await this.d.db
        .insert(verifyExecutionAttempts)
        .values({
          id: newId("exe"),
          jobId,
          refreshKey,
          reportVersion: version,
          nonce,
          intentJson: { intent, routerCalldata: route.calldata, domain },
          intentDigest: digest,
          calldataHash: cdHash,
          certificateJson: { certificate: cert, signer: this.d.signer.address },
          certificateSignature: signed.signature,
          validUntil: new Date(validUntil * 1000),
          state: "PREPARED",
          txHash: null,
          receiptJson: null,
          createdAt: nowDate,
          updatedAt: nowDate,
        })
        .returning();
      await this.d.orders.consumeRefresh(order.id);
      log.info("执行已准备", { jobId, attemptId: attempt!.id, version, validUntil });
      return { status: 200 as const, body: await this.attemptView(attempt!, job), replay: false };
    } catch (err) {
      await this.d.orders.releaseRefresh(order.id);
      throw err;
    }
  }

  /** 同任务全部刷新共用一个执行 nonce（首次准备时原子分配；随机 128 bit，唯一约束兜底）。 */
  private async ensureNonce(job: JobRow, guard: EvmAddress): Promise<string> {
    if (job.executionNonce && job.guardAddress === guard) return job.executionNonce;
    for (let i = 0; i < 5; i++) {
      const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`).toString();
      const rows = await this.d.db
        .update(verifyJobs)
        .set({ executionNonce: nonce, guardAddress: guard })
        .where(and(eq(verifyJobs.id, job.id), sql`${verifyJobs.executionNonce} IS NULL`))
        .returning();
      if (rows[0]) return rows[0].executionNonce!;
      const again = (await this.d.db.select().from(verifyJobs).where(eq(verifyJobs.id, job.id)).limit(1))[0];
      if (again?.executionNonce) return again.executionNonce;
    }
    throw new HttpError(500, "nonce_allocation_failed");
  }

  async attemptView(attempt: ExecutionAttemptRow, job: JobRow) {
    const rep = await this.reportVersion(job.id, attempt.reportVersion);
    const report = rep?.reportJson as VerifyReport | undefined;
    const ij = attempt.intentJson as { intent?: TradeIntent; routerCalldata?: `0x${string}`; domain?: ReturnType<typeof makeDomain> };
    const cj = attempt.certificateJson as { certificate: VerificationCertificate; signer: string } | null;
    const ent = await this.d.orders.entitlement((await this.requireOrder(job.id)).id);
    return {
      attemptId: attempt.id,
      jobId: job.id,
      state: attempt.state,
      reportVersion: attempt.reportVersion,
      report: report ?? null,
      verdict: report?.verdict ?? null,
      executionEligible: report?.executionEligible ?? false,
      refreshesRemaining: ent ? Math.max(0, ent.maxRefreshes - ent.usedRefreshes - ent.reservedRefreshes) : 0,
      entitlementExpiresAt: ent?.expiresAt.toISOString() ?? null,
      execution:
        attempt.state === "REJECTED" || !ij.intent || !cj
          ? null
          : {
              typedData: { domain: ij.domain, types: EIP712_TYPES, primaryType: "TradeIntent" as const, message: ij.intent },
              intentDigest: attempt.intentDigest,
              certificate: cj.certificate,
              certificateSignature: attempt.certificateSignature,
              attestationSigner: cj.signer,
              routerCalldata: ij.routerCalldata,
              approval: { token: ij.intent.inputToken, spender: this.d.cfg.GUARD_ADDRESS, amount: ij.intent.amountIn },
              guardCall: {
                to: this.d.cfg.GUARD_ADDRESS,
                functionName: "execute",
                abi: GUARD_ABI,
                argsWithoutSignatures: { intent: ij.intent, cert: cj.certificate, certSignature: attempt.certificateSignature, routerCalldata: ij.routerCalldata },
                value: "0",
              },
              validUntil: attempt.validUntil?.toISOString() ?? null,
              txHash: attempt.txHash,
              receipt: (attempt.receiptJson as Record<string, unknown> | null) ?? null,
            },
    };
  }

  /* ---------- 提交记录 ---------- */

  async recordSubmission(callerId: string, jobId: string, attemptId: string, txHash: string, intentSignature?: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, "invalid_tx_hash");
    const job = await this.requireJob(callerId, jobId);
    const attempt = (await this.d.db.select().from(verifyExecutionAttempts).where(and(eq(verifyExecutionAttempts.id, attemptId), eq(verifyExecutionAttempts.jobId, jobId))).limit(1))[0];
    if (!attempt) throw new HttpError(404, "attempt_not_found");
    if (attempt.state === "REJECTED") throw new HttpError(409, "attempt_rejected");
    if (attempt.txHash && attempt.txHash.toLowerCase() !== txHash.toLowerCase()) throw new HttpError(409, "tx_hash_conflict", "该尝试已绑定另一笔交易");
    const now = this.now();
    // 可选：执行者回传用户的 TradeIntent 签名（证据包用，服务自己不需要它）
    let intentJson = attempt.intentJson as Record<string, unknown>;
    if (intentSignature !== undefined) {
      if (!/^0x[0-9a-fA-F]{130}$/.test(intentSignature)) throw new HttpError(400, "invalid_intent_signature");
      const ij = attempt.intentJson as { intent?: TradeIntent; domain?: ReturnType<typeof makeDomain> };
      if (!ij.intent || !ij.domain) throw new HttpError(409, "attempt_rejected");
      const ok = await verifyTypedData({
        address: ij.intent.owner,
        domain: { name: ij.domain.name, version: ij.domain.version, chainId: ij.domain.chainId, verifyingContract: ij.domain.verifyingContract },
        types: EIP712_TYPES,
        primaryType: "TradeIntent",
        message: { ...ij.intent, amountIn: BigInt(ij.intent.amountIn), minAmountOut: BigInt(ij.intent.minAmountOut), nonce: BigInt(ij.intent.nonce), deadline: BigInt(ij.intent.deadline) },
        signature: intentSignature as `0x${string}`,
      }).catch(() => false);
      if (!ok) throw new HttpError(422, "intent_signature_invalid", "TradeIntent 签名不是 owner 签的");
      intentJson = { ...intentJson, intentSignature };
    }
    const [updated] = await this.d.db
      .update(verifyExecutionAttempts)
      .set({ txHash: txHash.toLowerCase(), intentJson, state: attempt.txHash ? attempt.state : "SUBMITTED", updatedAt: now })
      .where(eq(verifyExecutionAttempts.id, attemptId))
      .returning();
    return this.attemptView(updated!, job);
  }

  /** 供链上回执核实器（Lane B/D）更新状态；本模块不信任客户端的成功声明。 */
  async applyReceipt(attemptId: string, state: "CONFIRMED" | "REVERTED" | "UNKNOWN" | "REORG_PENDING" | "SUBMITTED", receipt: Record<string, unknown>) {
    await this.d.db.update(verifyExecutionAttempts).set({ state, receiptJson: receipt, updatedAt: this.now() }).where(eq(verifyExecutionAttempts.id, attemptId));
  }

  /** 待核实的执行尝试：已有 tx hash、非终态、48 h 内有更新（更久的留给人工） */
  async pendingExecutionAttempts(): Promise<ExecutionAttemptRow[]> {
    const since = new Date(this.now().getTime() - 48 * 3600 * 1000);
    return this.d.db
      .select()
      .from(verifyExecutionAttempts)
      .where(and(inArray(verifyExecutionAttempts.state, ["SUBMITTED", "REORG_PENDING", "UNKNOWN"]), isNotNull(verifyExecutionAttempts.txHash), gt(verifyExecutionAttempts.updatedAt, since)))
      .orderBy(asc(verifyExecutionAttempts.updatedAt));
  }

  static toPublicJob(job: NormalizedJob) {
    return toCreateVerifyJob(job);
  }
}
