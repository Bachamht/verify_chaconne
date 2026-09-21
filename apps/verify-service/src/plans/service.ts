/**
 * 规划任务用例（W1，interfaces §10.4）：创建（幂等）→ 规划报告（SKU plan，经付费闸门交付）→ 候选转 job。
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyPlans } from "@chaconne/db";
import { candidateToCreateJob, findEntry, goalHash, type AssetRegistry, type EvidenceRecord, type PlanCandidate, type PlanGoal, type PlanReport } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { EvidenceProvider } from "../evidence/provider";
import { newId } from "../ids";
import { log } from "../log";
import { HttpError, type VerifyService } from "../jobs/service";
import type { Orders } from "../payments/orders";
import type { PlanEngine } from "./engine";
import { validatePlanGoal } from "./validate";

export type PlanRow = typeof verifyPlans.$inferSelect;

export interface PlansDeps {
  db: Db;
  cfg: VerifyConfig;
  registry: AssetRegistry;
  evidence: EvidenceProvider;
  engine: PlanEngine;
  orders: Orders;
  jobs: VerifyService;
  now?: () => Date;
}

export interface PlanView {
  planId: string;
  clientRequestId: string;
  goal: PlanGoal;
  goalHash: string;
  planHash: string;
  evidenceHash: string;
  evaluatedAt: string;
  candidateCount: number;
  recommended: string | null;
  /** 交付口径：免费或已付款时带完整规划报告（interfaces §10.12） */
  plan: PlanReport | null;
  order: { orderId: string; state: string; priceUsd: string; sku: string } | null;
  evidenceMode: "FIXTURE" | "LIVE";
}

export class PlansService {
  private readonly now: () => Date;
  constructor(private readonly d: PlansDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async create(callerId: string, raw: unknown): Promise<{ status: 200 | 201; body: PlanView }> {
    const v = validatePlanGoal(raw, this.d.cfg.EXECUTION_CHAIN_ID);
    if (!v.ok) throw new HttpError(400, "invalid_request", "规划目标校验失败", v.errors);
    const { goal, clientRequestId } = v;
    for (const k of [...goal.budget.inputAssetKeys, ...goal.legs.map((l) => l.outputAssetKey)]) {
      if (!findEntry(this.d.registry, k)) throw new HttpError(400, "asset_unsupported", `资产不在登记表内：${k}`);
    }
    const gHash = goalHash(goal);
    const existing = await this.findByClientRequest(callerId, clientRequestId);
    if (existing) {
      if (existing.goalHash !== gHash) throw new HttpError(409, "idempotency_conflict", "同一 clientRequestId 已绑定不同规划目标");
      return { status: 200, body: await this.view(existing) };
    }
    const nowDate = this.now();
    const planId = newId("pln");
    const result = await this.d.engine.plan(goal, { registry: this.d.registry, evidence: this.d.evidence, nowIso: nowDate.toISOString(), planId });
    const [inserted] = await this.d.db
      .insert(verifyPlans)
      .values({
        id: planId,
        callerId,
        clientRequestId,
        ownerAddress: goal.ownerAddress,
        goalJson: goal,
        goalHash: gHash,
        planJson: result.report,
        planHash: result.report.planHash,
        evidenceHash: result.report.evidenceHash,
        evidenceJson: result.evidence,
        registryHash: result.report.registryHash,
        policyDefinitionHash: result.policy.policyDefinitionHash,
        effectivePolicyHash: result.policy.effectivePolicyHash,
        policySnapshot: { definition: result.policy.definition, params: result.policy.params },
        evaluatedAt: new Date(result.report.evaluatedAt),
        createdAt: nowDate,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const again = await this.findByClientRequest(callerId, clientRequestId);
      if (!again) throw new HttpError(500, "internal", "规划插入失败");
      if (again.goalHash !== gHash) throw new HttpError(409, "idempotency_conflict");
      return { status: 200, body: await this.view(again) };
    }
    await this.d.orders.create({ jobId: planId, refKind: "plan", sku: "plan", priceUsd: this.d.cfg.PRODUCT_PRICE_PLAN_USD, network: this.d.cfg.PAYMENT_NETWORK, merchant: this.d.cfg.MERCHANT_RECIPIENT_ADDRESS || "0x0000000000000000000000000000000000000000" });
    log.info("规划已创建", { planId, callerId, candidates: result.report.candidates.length, recommended: result.report.recommended });
    return { status: 201, body: await this.view(inserted) };
  }

  private async findByClientRequest(callerId: string, clientRequestId: string): Promise<PlanRow | null> {
    return (await this.d.db.select().from(verifyPlans).where(and(eq(verifyPlans.callerId, callerId), eq(verifyPlans.clientRequestId, clientRequestId))).limit(1))[0] ?? null;
  }

  async requirePlan(callerId: string, planId: string): Promise<PlanRow> {
    const row = (await this.d.db.select().from(verifyPlans).where(eq(verifyPlans.id, planId)).limit(1))[0];
    if (!row || row.callerId !== callerId) throw new HttpError(404, "plan_not_found");
    return row;
  }

  async byId(planId: string): Promise<PlanRow | null> {
    return (await this.d.db.select().from(verifyPlans).where(eq(verifyPlans.id, planId)).limit(1))[0] ?? null;
  }

  async view(row: PlanRow): Promise<PlanView> {
    const order = await this.d.orders.byRef(row.id);
    const report = row.planJson as PlanReport;
    const deliverable = !order || order.priceUsd === "0" || this.d.orders.isDeliverable(order);
    return {
      planId: row.id,
      plan: deliverable ? report : null,
      clientRequestId: row.clientRequestId,
      goal: row.goalJson as PlanGoal,
      goalHash: row.goalHash,
      planHash: row.planHash,
      evidenceHash: row.evidenceHash,
      evaluatedAt: row.evaluatedAt.toISOString(),
      candidateCount: report.candidates.length,
      recommended: report.recommended,
      order: order ? { orderId: order.id, state: order.state, priceUsd: order.priceUsd, sku: order.sku } : null,
      evidenceMode: this.d.evidence.mode,
    };
  }

  /** 付费交付：完整规划报告 + 证据 */
  async deliver(row: PlanRow) {
    return { plan: row.planJson as PlanReport, planHash: row.planHash, evidence: row.evidenceJson as EvidenceRecord[], policySnapshot: row.policySnapshot };
  }

  /** 候选 → 任务（同 requestHash 链：任务 clientRequestId = `${planId}:${candidateId}`） */
  async toJob(callerId: string, row: PlanRow, candidateId: string | null) {
    const report = row.planJson as PlanReport;
    const id = candidateId ?? report.recommended;
    if (!id) throw new HttpError(409, "no_recommended_candidate", "该规划没有可推荐候选");
    const c: PlanCandidate | undefined = report.candidates.find((x) => x.candidateId === id);
    if (!c) throw new HttpError(404, "candidate_not_found");
    if (c.nextStep === "USER_MUST_RELAX_LIMIT") throw new HttpError(409, "candidate_requires_relaxed_limit", "该候选需要用户显式放宽限制，不可直接转任务");
    const goal = row.goalJson as PlanGoal;
    const body = candidateToCreateJob(goal, c, `${row.id}:${c.candidateId}`);
    const r = await this.d.jobs.createJob(callerId, body);
    return { ...r, candidate: c, planId: row.id };
  }
}
