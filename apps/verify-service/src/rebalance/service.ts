/**
 * 调仓编排（C3 第五个模板 `portfolio_rebalance`，Y-07）：
 *   POST /v1/rebalance/preview  当前持仓（含未知成本/未知价格）+ 目标权重 + 现金下限 → 各腿（先卖后买）、每腿单独授权草案、顺序、预计部分完成情形
 *   POST /v1/rebalance/plans    落库执行；POST …/plans/:id/legs/:n/authorize 提交该腿已签 TradeMandate（复用 /v1/mandates 登记逻辑）
 *   GET  /v1/rebalance/plans/:id 推进：卖出腿链上确认后按**真实**现金余额重算买力，再出买入腿草案 → 买入腿授权后由 prepare-step 签证书
 * 任一腿失败 → 计划 PARTIAL（其余腿照常推进），不承诺原子回到目标。服务端不发交易、不代签。
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyMandateSteps, verifyMandates, verifyRebalanceLegs, verifyRebalancePlans } from "@chaconne/db";
import { buildEffectivePolicy, EIP712_TYPES_V2, findEntry, findPolicy, isEvmAddress, isRawAmount, makePlanGuardDomain, outputSetHash, registryHash, resolveParams, type AssetRegistry, type EvmAddress, type PolicyId, type TradeMandate } from "@chaconne/core/verify";
import { planRebalance, recomputeBuys, type RebalanceHolding, type RebalanceLeg, type RebalancePreview } from "@chaconne/core/verify/budget/index";
import type { VerifyConfig } from "../config";
import { HttpError } from "../jobs/service";
import { newId } from "../ids";
import { log } from "../log";
import type { PortfolioService } from "../portfolio/service";
import type { PortfolioReader } from "../portfolio/chain";
import type { MandatesService, MandateJson, RegisterMandateBody } from "../mandates/service";
import type { Orders } from "../payments/orders";
import type { BudgetService } from "../budget/service";
import type { NotifyService } from "../notify/service";
import { assertOwner } from "../portfolio/ownerAuth";

export type PlanRow = typeof verifyRebalancePlans.$inferSelect;
export type LegRow = typeof verifyRebalanceLegs.$inferSelect;

export interface RebalanceRequest {
  clientRequestId?: string;
  ownerAddress: string;
  inputAssetKey: string;
  targets: Array<{ assetKey: string; weightBps: number }>;
  cashFloorRaw?: string;
  /** 价格来源拿不到时由调用方提供（标 user_supplied，只用于预估腿大小，不进证书） */
  pricesUsd?: Record<string, string>;
  policyId?: PolicyId;
  policyVersion?: string;
  maxSlippageBps?: number;
  maxPriceImpactBps?: number | null;
  maxReferenceDeviationBps?: number | null;
  /** 各腿授权 deadline（ISO，缺省 24 h） */
  deadline?: string;
  budgetGroupId?: string;
  taskId?: string;
}
interface PolicyJson {
  policyId: PolicyId;
  policyVersion: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number | null;
  maxReferenceDeviationBps: number | null;
  deadline: string;
}
export interface MandateDraft {
  mandate: TradeMandate;
  typedData: { domain: ReturnType<typeof makePlanGuardDomain>; types: typeof EIP712_TYPES_V2; primaryType: "TradeMandate"; message: TradeMandate };
  /** 直接可用于 POST …/legs/:n/authorize 的 body（补上 signature） */
  registerBody: Omit<RegisterMandateBody, "signature"> & { signature: "<sign typedData with the owner wallet>" };
}

const LEG_TERMINAL = new Set(["CONFIRMED", "FAILED", "SKIPPED"]);

export class RebalanceService {
  private readonly now: () => Date;
  constructor(private readonly d: { db: Db; cfg: VerifyConfig; registry: AssetRegistry; portfolio: PortfolioService; reader: PortfolioReader; mandates: MandatesService; orders: Orders; budget?: BudgetService | null; notify?: NotifyService | null; now?: () => Date }) {
    this.now = d.now ?? (() => new Date());
  }

  /* ---------- 校验 ---------- */
  private parse(raw: unknown): RebalanceRequest & { policy: PolicyJson; cashFloorRaw: string } {
    const b = (raw ?? {}) as Partial<RebalanceRequest>;
    const errors: Array<{ field: string; code: string }> = [];
    if (!isEvmAddress(b.ownerAddress)) errors.push({ field: "ownerAddress", code: "invalid_address" });
    const input = typeof b.inputAssetKey === "string" ? findEntry(this.d.registry, b.inputAssetKey.toLowerCase()) : null;
    if (!input || input.role !== "stable_input") errors.push({ field: "inputAssetKey", code: "must_be_stable_input" });
    if (!Array.isArray(b.targets) || b.targets.length === 0 || b.targets.length > 8) errors.push({ field: "targets", code: "expected_1_to_8" });
    else {
      let sum = 0;
      for (const t of b.targets) {
        const e = findEntry(this.d.registry, String(t.assetKey).toLowerCase());
        if (!e || e.role !== "stock_output") errors.push({ field: "targets.assetKey", code: "asset_unsupported" });
        else if (!e.executionAllowed) errors.push({ field: "targets.assetKey", code: "execution_not_allowed" });
        if (!Number.isInteger(t.weightBps) || t.weightBps < 0 || t.weightBps > 10_000) errors.push({ field: "targets.weightBps", code: "invalid" });
        sum += Number(t.weightBps) || 0;
      }
      if (sum > 10_000) errors.push({ field: "targets.weightBps", code: "sum_exceeds_10000" });
    }
    if (b.cashFloorRaw !== undefined && !isRawAmount(b.cashFloorRaw)) errors.push({ field: "cashFloorRaw", code: "invalid_raw" });
    if (b.pricesUsd !== undefined && (typeof b.pricesUsd !== "object" || b.pricesUsd === null || Object.values(b.pricesUsd).some((v) => typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v)))) errors.push({ field: "pricesUsd", code: "invalid" });
    const policyId = (b.policyId ?? "STRICT_LIVE") as PolicyId;
    const policyVersion = b.policyVersion ?? "1.1.0";
    const def = findPolicy(policyId, policyVersion);
    if (!def) errors.push({ field: "policyId", code: "unknown_policy" });
    const deadline = b.deadline ?? new Date(this.now().getTime() + 24 * 3600_000).toISOString();
    if (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= this.now().getTime()) errors.push({ field: "deadline", code: "must_be_future" });
    if (errors.length > 0) throw new HttpError(400, "invalid_request", "调仓参数校验失败", errors);
    return { ...(b as RebalanceRequest), inputAssetKey: input!.assetKey, cashFloorRaw: b.cashFloorRaw ?? "0", targets: b.targets!.map((t) => ({ assetKey: findEntry(this.d.registry, String(t.assetKey).toLowerCase())!.assetKey, weightBps: Number(t.weightBps) })), policy: { policyId, policyVersion, maxSlippageBps: b.maxSlippageBps ?? 50, maxPriceImpactBps: b.maxPriceImpactBps === undefined ? 100 : b.maxPriceImpactBps, maxReferenceDeviationBps: policyId === "QUOTE_ONLY" ? null : (b.maxReferenceDeviationBps === undefined ? 300 : b.maxReferenceDeviationBps), deadline } };
  }

  /* ---------- 草案 ---------- */
  draftFor(owner: string, inputAssetKey: string, leg: Pick<RebalanceLeg, "side" | "assetKey" | "amountRaw" | "legIndex">, policy: PolicyJson, nonceBase: string): MandateDraft {
    const planGuard = this.d.cfg.PLANGUARD_ADDRESS;
    if (!planGuard) throw new HttpError(503, "planguard_not_configured");
    const stable = findEntry(this.d.registry, inputAssetKey)!;
    const stock = findEntry(this.d.registry, leg.assetKey)!;
    const def = findPolicy(policy.policyId, policy.policyVersion)!;
    const params = resolveParams(def, { maxSlippageBps: policy.maxSlippageBps, maxPriceImpactBps: policy.maxPriceImpactBps, maxReferenceDeviationBps: policy.maxReferenceDeviationBps });
    if (!params.ok) throw new HttpError(400, "invalid_request", "策略参数超范围");
    const eff = buildEffectivePolicy(def, params.params);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const mandate: TradeMandate = {
      owner: owner.toLowerCase() as EvmAddress,
      recipient: owner.toLowerCase() as EvmAddress,
      inputToken: leg.side === "sell" ? stock.tokenAddress : stable.tokenAddress,
      outputSetHash: outputSetHash(leg.side === "sell" ? [stable.tokenAddress] : [stock.tokenAddress]),
      budgetCap: leg.amountRaw,
      perStepCap: leg.amountRaw,
      maxSteps: "1",
      policyDefinitionHash: eff.policyDefinitionHash,
      effectivePolicyHash: eff.effectivePolicyHash,
      registryHash: registryHash(this.d.registry),
      validFrom: String(nowSec - 60),
      deadline: String(Math.floor(Date.parse(policy.deadline) / 1000)),
      nonce: `${nonceBase}${leg.legIndex}`,
    };
    const domain = makePlanGuardDomain(this.d.cfg.EXECUTION_CHAIN_ID, planGuard as EvmAddress);
    return {
      mandate,
      typedData: { domain, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: mandate },
      registerBody: { clientRequestId: `rebalance-leg-${leg.legIndex}-${nonceBase}`, mandate, signature: "<sign typedData with the owner wallet>", inputAssetKey: stable.assetKey, legs: [{ outputAssetKey: stock.assetKey, weightBps: 10_000 }], side: leg.side, policyId: policy.policyId, policyVersion: policy.policyVersion, maxSlippageBps: policy.maxSlippageBps, maxPriceImpactBps: policy.maxPriceImpactBps, maxReferenceDeviationBps: policy.maxReferenceDeviationBps, sku: "task_bundle" },
    };
  }

  /* ---------- preview ---------- */
  async preview(callerId: string, raw: unknown) {
    const req = this.parse(raw);
    const owner = await assertOwner(this.d.db, callerId, req.ownerAddress);
    const snap = await this.d.portfolio.snapshot(owner);
    const stable = findEntry(this.d.registry, req.inputAssetKey)!;
    const cashBal = snap.cash.find((c) => c.assetKey === stable.assetKey);
    const userSupplied: string[] = [];
    const holdings: RebalanceHolding[] = [];
    const relevant = new Set<string>([...snap.holdings.map((h) => h.assetKey), ...req.targets.map((t) => t.assetKey)]);
    for (const key of relevant) {
      const e = findEntry(this.d.registry, key)!;
      const h = snap.holdings.find((x) => x.assetKey === key);
      let price = snap.prices.get(key) ?? null;
      if (price === null && req.pricesUsd) {
        const u = req.pricesUsd[key] ?? req.pricesUsd[key.toLowerCase()];
        if (u) {
          price = u;
          userSupplied.push(key);
        }
      }
      holdings.push({ assetKey: key, balanceRaw: h?.balanceRaw ?? "0", decimals: e.tokenDecimals, priceUsd: price, costCoverageBps: (h?.coverage as { coverageBps: number | null } | undefined)?.coverageBps ?? null });
    }
    const preview = planRebalance({ holdings, cash: { assetKey: stable.assetKey, balanceRaw: cashBal?.balanceRaw ?? "0", decimals: stable.tokenDecimals }, cashFloorRaw: req.cashFloorRaw, targets: req.targets });
    const nonceBase = String(Math.floor(this.now().getTime() / 1000));
    const legs = preview.legs.map((l) => ({ ...l, state: l.side === "sell" || preview.legs.every((x) => x.side === "buy") ? "READY_TO_AUTHORIZE" : "PLANNED", draft: l.side === "sell" || preview.legs.every((x) => x.side === "buy") ? this.draftFor(owner, stable.assetKey, l, req.policy, nonceBase) : null, draftNote: l.side === "buy" && preview.legs.some((x) => x.side === "sell") ? "Buy-leg authorization is drafted only after all sell legs are confirmed on-chain and buying power is recomputed from the real cash balance." : null }));
    return {
      owner,
      inputAssetKey: stable.assetKey,
      cashFloorRaw: req.cashFloorRaw,
      targets: req.targets,
      preview,
      legs,
      order: legs.map((l) => ({ legIndex: l.legIndex, side: l.side, assetKey: l.assetKey })),
      snapshot: { block: { number: snap.chain.blockNumber, hash: snap.chain.blockHash, timestamp: snap.chain.blockTimestamp }, evidence: snap.evidence },
      prices: { source: this.d.portfolio.priceSourceKind, userSupplied },
      policy: req.policy,
      mode: "PREVIEW",
      notes: ["Each leg is a separate TradeMandate (maxSteps = 1) signed by the owner; nothing here is signed by the service.", ...preview.partialOutcomes],
    };
  }

  /* ---------- plans ---------- */
  async createPlan(callerId: string, raw: unknown): Promise<{ status: 200 | 201; body: Awaited<ReturnType<RebalanceService["view"]>> }> {
    const b = (raw ?? {}) as Partial<RebalanceRequest>;
    if (typeof b.clientRequestId !== "string" || !/^[A-Za-z0-9_\-:.]{1,128}$/.test(b.clientRequestId)) throw new HttpError(400, "invalid_request", "clientRequestId 必填");
    const existing = (await this.d.db.select().from(verifyRebalancePlans).where(and(eq(verifyRebalancePlans.callerId, callerId), eq(verifyRebalancePlans.clientRequestId, b.clientRequestId))).limit(1))[0];
    if (existing) return { status: 200, body: await this.view(callerId, existing.id) };
    const p = await this.preview(callerId, raw);
    if (p.legs.length === 0) throw new HttpError(422, "nothing_to_rebalance", "当前持仓已在目标权重内（或价格未知），没有可执行的腿", { unknownPriceAssets: p.preview.unknownPriceAssets });
    const now = this.now();
    const hasSells = p.legs.some((l) => l.side === "sell");
    const [plan] = await this.d.db
      .insert(verifyRebalancePlans)
      .values({ id: newId("rbp"), callerId, clientRequestId: b.clientRequestId, ownerAddress: p.owner, taskId: typeof b.taskId === "string" ? b.taskId : null, budgetGroupId: typeof b.budgetGroupId === "string" ? b.budgetGroupId : null, inputAssetKey: p.inputAssetKey, cashFloorRaw: p.cashFloorRaw, targetsJson: p.targets, previewJson: p.preview, snapshotJson: p.snapshot.evidence, policyJson: p.policy, state: "DRAFT", phase: hasSells ? "selling" : "buying", createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!plan) throw new HttpError(409, "idempotency_conflict");
    for (const l of p.legs) {
      await this.d.db.insert(verifyRebalanceLegs).values({ id: newId("rbl"), planId: plan.id, legIndex: l.legIndex, side: l.side, assetKey: l.assetKey, amountRaw: l.amountRaw, estUsd: l.estUsd, state: l.state, mandateId: null, draftJson: l.draft, resultJson: null, createdAt: now, updatedAt: now });
    }
    log.info("调仓计划已创建", { planId: plan.id, legs: p.legs.length, phase: plan.phase });
    return { status: 201, body: await this.view(callerId, plan.id) };
  }

  async requirePlan(callerId: string, id: string): Promise<PlanRow> {
    const row = (await this.d.db.select().from(verifyRebalancePlans).where(eq(verifyRebalancePlans.id, id)).limit(1))[0];
    if (!row) throw new HttpError(404, "rebalance_plan_not_found");
    if (row.callerId !== callerId) await assertOwner(this.d.db, callerId, row.ownerAddress);
    return row;
  }
  private async legs(planId: string): Promise<LegRow[]> {
    return this.d.db.select().from(verifyRebalanceLegs).where(eq(verifyRebalanceLegs.planId, planId)).orderBy(asc(verifyRebalanceLegs.legIndex));
  }

  /** 提交该腿已签 TradeMandate（复用 /v1/mandates 登记与校验），并与草案比对 */
  async authorizeLeg(callerId: string, planId: string, legIndex: number, raw: unknown) {
    const plan = await this.requirePlan(callerId, planId);
    const leg = (await this.d.db.select().from(verifyRebalanceLegs).where(and(eq(verifyRebalanceLegs.planId, planId), eq(verifyRebalanceLegs.legIndex, legIndex))).limit(1))[0];
    if (!leg) throw new HttpError(404, "leg_not_found");
    if (leg.state !== "READY_TO_AUTHORIZE") throw new HttpError(409, "leg_not_ready", `该腿状态 ${leg.state}：${leg.side === "buy" ? "买入腿要等卖出腿链上确认、买力重算后才出草案" : "不能重复授权"}`);
    const draft = leg.draftJson as MandateDraft | null;
    if (!draft) throw new HttpError(409, "leg_draft_missing");
    const m = ((raw ?? {}) as { mandate?: Partial<TradeMandate> }).mandate;
    if (!m || typeof m !== "object") throw new HttpError(400, "invalid_request", "mandate 必填");
    const mismatch: string[] = [];
    if (String(m.inputToken).toLowerCase() !== draft.mandate.inputToken.toLowerCase()) mismatch.push("inputToken");
    if (String(m.outputSetHash).toLowerCase() !== draft.mandate.outputSetHash.toLowerCase()) mismatch.push("outputSetHash");
    if (String(m.maxSteps) !== "1") mismatch.push("maxSteps");
    if (!isRawAmount(m.budgetCap) || BigInt(m.budgetCap!) > BigInt(draft.mandate.budgetCap)) mismatch.push("budgetCap");
    if (String(m.owner).toLowerCase() !== plan.ownerAddress.toLowerCase()) mismatch.push("owner");
    if (mismatch.length > 0) throw new HttpError(422, "leg_draft_mismatch", "签署的授权与该腿草案不一致", { fields: mismatch, draft: draft.mandate });
    const r = await this.d.mandates.register(callerId, { ...draft.registerBody, ...(raw as object), side: leg.side });
    const order = await this.d.orders.byRef(r.row.id);
    if (order && (order.priceUsd === "0" || this.d.orders.isDeliverable(order))) {
      await this.d.mandates.activate(r.row.id);
      await this.d.orders.markDelivered(order.id);
    }
    const now = this.now();
    await this.d.db.update(verifyRebalanceLegs).set({ mandateId: r.row.id, state: "AUTHORIZED", updatedAt: now }).where(eq(verifyRebalanceLegs.id, leg.id));
    await this.d.db.update(verifyRebalancePlans).set({ state: plan.state === "DRAFT" ? "ACTIVE" : plan.state, updatedAt: now }).where(eq(verifyRebalancePlans.id, planId));
    let budget: unknown = null;
    if (plan.budgetGroupId && leg.side === "buy" && this.d.budget) {
      budget = (await this.d.budget.allocate(callerId, plan.budgetGroupId, { taskId: plan.taskId ?? planId, mandateId: r.row.id, priority: 100, amountRaw: (BigInt(r.row.budgetCap) - BigInt(r.row.spent)).toString() })).body;
    }
    return { plan: await this.view(callerId, planId), mandateId: r.row.id, mandateState: (await this.d.mandates.byId(r.row.id))!.state, budget, note: "Certificates for this leg are issued by POST /v1/mandates/:id/prepare-step after all conditions re-check; the service signs no transaction." };
  }

  /**
   * 推进：授权腿看链上回执 → CONFIRMED / FAILED；卖出全部终态 → 用真实现金余额重算买力 → 买入腿出草案；
   * 任一腿 FAILED → 计划 PARTIAL；全部 CONFIRMED → COMPLETED。
   */
  async advance(planId: string): Promise<PlanRow> {
    let plan = (await this.d.db.select().from(verifyRebalancePlans).where(eq(verifyRebalancePlans.id, planId)).limit(1))[0];
    if (!plan) throw new HttpError(404, "rebalance_plan_not_found");
    if (plan.state === "COMPLETED" || plan.state === "CANCELLED") return plan;
    const legs = await this.legs(planId);
    const now = this.now();
    const mandateIds = legs.map((l) => l.mandateId).filter((x): x is string => Boolean(x));
    const mandates = mandateIds.length > 0 ? await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, mandateIds)) : [];
    const steps = mandateIds.length > 0 ? await this.d.db.select().from(verifyMandateSteps).where(inArray(verifyMandateSteps.mandateId, mandateIds)) : [];
    for (const leg of legs) {
      if (leg.state !== "AUTHORIZED" || !leg.mandateId) continue;
      const m = mandates.find((x) => x.id === leg.mandateId);
      if (!m) continue;
      const ss = steps.filter((s) => s.mandateId === leg.mandateId);
      const confirmed = ss.find((s) => s.state === "CONFIRMED");
      const reverted = ss.find((s) => s.state === "REVERTED");
      const inFlight = ss.some((s) => s.state === "SUBMITTED" || s.state === "REORG_PENDING");
      if (confirmed) {
        const ev = (confirmed.receiptJson as { event?: { spent?: string; received?: string } } | null)?.event ?? {};
        leg.state = "CONFIRMED";
        await this.d.db.update(verifyRebalanceLegs).set({ state: "CONFIRMED", resultJson: { spentRaw: ev.spent ?? null, receivedRaw: ev.received ?? null, txHash: confirmed.txHash, stepIndex: confirmed.stepIndex }, updatedAt: now }).where(eq(verifyRebalanceLegs.id, leg.id));
        continue;
      }
      const failReason = reverted ? "step_reverted" : m.state === "EXPIRED" ? "mandate_expired" : m.state === "REVOKED" ? "mandate_revoked" : m.state === "CANCELLED" && !inFlight ? "mandate_cancelled" : null;
      if (failReason) {
        leg.state = "FAILED";
        await this.d.db.update(verifyRebalanceLegs).set({ state: "FAILED", resultJson: { reason: failReason, txHash: reverted?.txHash ?? null }, updatedAt: now }).where(eq(verifyRebalanceLegs.id, leg.id));
      }
    }
    const sells = legs.filter((l) => l.side === "sell");
    const buys = legs.filter((l) => l.side === "buy");
    let phase = plan.phase;
    if (phase === "selling" && sells.every((l) => LEG_TERMINAL.has(l.state))) {
      // 卖出所得以真实链上余额为准，不拿预估收入启动买入
      const stable = findEntry(this.d.registry, plan.inputAssetKey)!;
      const { balanceRaw, blockNumber } = await this.d.reader.balanceOf(plan.ownerAddress, plan.inputAssetKey);
      const planned = buys.filter((l) => l.state === "PLANNED");
      const sized = recomputeBuys(planned.map((l) => ({ legIndex: l.legIndex, estUsd: l.estUsd })), balanceRaw, stable.tokenDecimals, plan.cashFloorRaw);
      const policy = plan.policyJson as PolicyJson;
      const nonceBase = String(Math.floor(now.getTime() / 1000));
      for (const s of sized) {
        const leg = planned.find((l) => l.legIndex === s.legIndex)!;
        if (BigInt(s.amountRaw) <= 0n) {
          leg.state = "SKIPPED";
          await this.d.db.update(verifyRebalanceLegs).set({ state: "SKIPPED", amountRaw: "0", estUsd: "0", resultJson: { reason: "no_buying_power", cashBalanceRaw: balanceRaw, blockNumber }, updatedAt: now }).where(eq(verifyRebalanceLegs.id, leg.id));
          continue;
        }
        const draft = this.draftFor(plan.ownerAddress, plan.inputAssetKey, { side: "buy", assetKey: leg.assetKey, amountRaw: s.amountRaw, legIndex: leg.legIndex }, policy, nonceBase);
        leg.state = "READY_TO_AUTHORIZE";
        await this.d.db.update(verifyRebalanceLegs).set({ state: "READY_TO_AUTHORIZE", amountRaw: s.amountRaw, estUsd: s.estUsd, draftJson: draft, resultJson: { buyingPower: { cashBalanceRaw: balanceRaw, blockNumber, cashFloorRaw: plan.cashFloorRaw, scaled: s.scaled } }, updatedAt: now }).where(eq(verifyRebalanceLegs.id, leg.id));
      }
      phase = buys.length > 0 ? "buying" : "done";
    }
    const allTerminal = legs.every((l) => LEG_TERMINAL.has(l.state));
    const anyFailed = legs.some((l) => l.state === "FAILED");
    let state = plan.state;
    if (allTerminal) {
      state = anyFailed ? "PARTIAL" : "COMPLETED";
      phase = "done";
    } else if (anyFailed) state = "PARTIAL";
    else if (legs.some((l) => l.state === "AUTHORIZED" || l.state === "CONFIRMED")) state = "ACTIVE";
    if (state !== plan.state || phase !== plan.phase) {
      [plan] = await this.d.db.update(verifyRebalancePlans).set({ state, phase, updatedAt: now }).where(eq(verifyRebalancePlans.id, planId)).returning();
      if (this.d.notify) await this.d.notify.notify("task.status_changed", planId, legs.filter((l) => LEG_TERMINAL.has(l.state)).length, `Rebalance plan ${planId}: ${state} (${phase}).`, `${this.d.cfg.PUBLIC_BASE_URL}/v1/rebalance/plans/${planId}`, plan!.ownerAddress);
    }
    return plan!;
  }

  async view(callerId: string, id: string) {
    await this.requirePlan(callerId, id);
    const plan = await this.advance(id);
    const legs = await this.legs(id);
    const mandateIds = legs.map((l) => l.mandateId).filter((x): x is string => Boolean(x));
    const mandates = mandateIds.length > 0 ? await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, mandateIds)) : [];
    return {
      planId: plan.id,
      owner: plan.ownerAddress,
      state: plan.state as "DRAFT" | "ACTIVE" | "PARTIAL" | "COMPLETED" | "CANCELLED",
      phase: plan.phase as "selling" | "buying" | "done",
      inputAssetKey: plan.inputAssetKey,
      cashFloorRaw: plan.cashFloorRaw,
      targets: plan.targetsJson,
      preview: plan.previewJson as RebalancePreview,
      snapshotEvidence: plan.snapshotJson,
      policy: plan.policyJson,
      taskId: plan.taskId,
      budgetGroupId: plan.budgetGroupId,
      legs: legs.map((l) => {
        const m = mandates.find((x) => x.id === l.mandateId);
        return { legIndex: l.legIndex, side: l.side as "sell" | "buy", assetKey: l.assetKey, amountRaw: l.amountRaw, estUsd: l.estUsd, state: l.state, mandateId: l.mandateId, mandateState: (m?.state as string | undefined) ?? null, mandateSide: m ? (m.mandateJson as MandateJson).side : null, draft: l.draftJson as MandateDraft | null, result: l.resultJson, updatedAt: l.updatedAt.toISOString() };
      }),
      partial: plan.state === "PARTIAL" ? { note: "One or more legs failed. The remaining legs continue independently; the plan does not return to the target atomically.", failedLegs: legs.filter((l) => l.state === "FAILED").map((l) => l.legIndex) } : null,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
    };
  }

  /** 最近的计划（组合视图 / 复盘用） */
  async plansForOwner(owner: string, limit = 20): Promise<PlanRow[]> {
    return this.d.db.select().from(verifyRebalancePlans).where(eq(verifyRebalancePlans.ownerAddress, owner.toLowerCase())).orderBy(desc(verifyRebalancePlans.createdAt)).limit(limit);
  }
}
