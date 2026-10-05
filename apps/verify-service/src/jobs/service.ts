/**
 * 任务用例层：HTTP / MCP / 页面共用同一套函数（技术设计 §3、§6.1、§7.4、§9.2）。
 * 只有这里能：创建任务、生成报告版本。单笔 Guard 执行（prepare-execution / submissions、执行 nonce、证书）10/5 起删除；历史执行尝试仍随任务视图、账单与证据包返回。
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyEvidence, verifyExecutionAttempts, verifyJobs, verifyReports } from "@chaconne/db";
import {
  buildReport,
  findEntry,
  registryHash,
  reportHash,
  requestHash,
  toCreateVerifyJob,
  validateCreateJob,
  type AssetRegistry,
  type NormalizedJob,
  type PolicyDefinition,
  type VerifyReport,
  type ValidationError,
} from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { AttestationSigner } from "../attestation/signer";
import type { EvidenceProvider } from "../evidence/provider";
import { callerActsFor } from "../http/auth";
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

  /** 任务所有权校验：非本调用方且不代表该 owner 钱包 → 404（不泄漏存在性）。 */
  async requireJob(callerId: string, jobId: string): Promise<JobRow> {
    const row = (await this.d.db.select().from(verifyJobs).where(eq(verifyJobs.id, jobId)).limit(1))[0];
    if (!row || (row.callerId !== callerId && !callerActsFor(callerId, row.ownerAddress))) throw new HttpError(404, "job_not_found");
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

  static toPublicJob(job: NormalizedJob) {
    return toCreateVerifyJob(job);
  }
}
