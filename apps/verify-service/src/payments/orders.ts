/**
 * 服务订单 / 付款尝试 / 额度 的持久化状态机（技术设计 §7.2 / §7.3 / §7.4）。
 *
 * 订单：CREATED → REPORT_READY → PAYMENT_REQUIRED → SETTLEMENT_PENDING → PAID → DELIVERED
 *                                          └→ PAYMENT_UNKNOWN → (对账) PAID / FAILED
 * 原则：
 *  - 付款签名验证成功 ≠ 结算成功；PAID 只由 SDK 真实结算结果/对账结果写入；
 *  - 同一 (order, proofDigest) 只有一条尝试；重放返回同一交付，不再次结算；
 *  - 额度用单条 UPDATE … WHERE used+reserved<max 原子预留。
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyEntitlements, verifyOrders, verifyPaymentAttempts, verifyPaymentEvents } from "@chaconne/db";
import { hashCanonical, type OrderState } from "@chaconne/core/verify";
import type { SettleResponse, SettleStatusResponse, PaymentPayload } from "@okxweb3/x402-core/types";
import { newId } from "../ids";
import { log } from "../log";

export type OrderRow = typeof verifyOrders.$inferSelect;
export type AttemptRow = typeof verifyPaymentAttempts.$inferSelect;
export type EntitlementRow = typeof verifyEntitlements.$inferSelect;

/** 这些状态下报告可交付（pending = SDK 语义"卖方信任 facilitator"，对账兜底） */
export const DELIVERABLE_STATES: readonly OrderState[] = ["PAID", "DELIVERED", "SETTLEMENT_PENDING"];

export interface OrdersDeps {
  db: Db;
  now: () => Date;
  entitlement: { maxRefreshes: number; windowSeconds: number };
}

export class Orders {
  constructor(private readonly d: OrdersDeps) {}

  async create(args: { jobId: string; priceUsd: string; network: string; merchant: string; refKind?: "job" | "plan" | "mandate"; sku?: string }): Promise<OrderRow> {
    const now = this.d.now();
    const free = args.priceUsd === "0" || Number(args.priceUsd) === 0;
    const row: typeof verifyOrders.$inferInsert = {
      id: newId("ord"),
      jobId: args.jobId,
      refKind: args.refKind ?? "job",
      sku: args.sku ?? "verify_once",
      priceUsd: args.priceUsd,
      priceAmount: free ? "0" : null,
      priceAsset: null,
      network: args.network,
      merchant: args.merchant,
      state: free ? "PAID" : "REPORT_READY",
      settledAt: free ? now : null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const [inserted] = await this.d.db.insert(verifyOrders).values(row).returning();
    if (free) await this.grantEntitlement(inserted!.id);
    return inserted!;
  }

  async byJobId(jobId: string): Promise<OrderRow | null> {
    return (await this.d.db.select().from(verifyOrders).where(eq(verifyOrders.jobId, jobId)).limit(1))[0] ?? null;
  }

  /** v2：按关联对象（plan / mandate）取订单；job_id 列存 ref id */
  async byRef(refId: string): Promise<OrderRow | null> {
    return this.byJobId(refId);
  }

  /** 该订单已结算过的付款尝试（SETTLED / SETTLEMENT_PENDING） */
  async settledAttempts(orderId: string): Promise<AttemptRow[]> {
    return this.d.db.select().from(verifyPaymentAttempts).where(and(eq(verifyPaymentAttempts.orderId, orderId), inArray(verifyPaymentAttempts.state, ["SETTLED", "SETTLEMENT_PENDING"])));
  }

  /** FIX-087：订单已由另一凭证放行 → 本凭证不结算，记 SUPERSEDED（不扣款、不作废对方） */
  async markSuperseded(attemptId: string): Promise<void> {
    const now = this.d.now();
    await this.d.db.update(verifyPaymentAttempts).set({ state: "SUPERSEDED", errorCode: "order_already_paid", lastCheckedAt: now, updatedAt: now }).where(eq(verifyPaymentAttempts.id, attemptId));
    await this.recordEvent("paywall", `${attemptId}:superseded`, attemptId, { reason: "order_already_paid" }, now);
  }

  async byId(id: string): Promise<OrderRow | null> {
    return (await this.d.db.select().from(verifyOrders).where(eq(verifyOrders.id, id)).limit(1))[0] ?? null;
  }

  isDeliverable(order: OrderRow): boolean {
    return DELIVERABLE_STATES.includes(order.state as OrderState);
  }

  private async setState(orderId: string, state: OrderState, extra: Partial<typeof verifyOrders.$inferInsert> = {}): Promise<void> {
    await this.d.db
      .update(verifyOrders)
      .set({ state, updatedAt: this.d.now(), ...extra })
      .where(eq(verifyOrders.id, orderId));
  }

  /** 首次遇到未付款请求：REPORT_READY → PAYMENT_REQUIRED（幂等） */
  async markPaymentRequired(orderId: string): Promise<void> {
    await this.d.db
      .update(verifyOrders)
      .set({ state: "PAYMENT_REQUIRED", updatedAt: this.d.now() })
      .where(and(eq(verifyOrders.id, orderId), eq(verifyOrders.state, "REPORT_READY")));
  }

  /** 付款凭证摘要：不存明文，keccak(canonical(payload))。 */
  proofDigest(payload: PaymentPayload): string {
    return hashCanonical({ x402Version: payload.x402Version, accepted: payload.accepted, payload: payload.payload, resource: payload.resource });
  }

  /** 该凭证是否已用于其它订单（一次付款只能换一次交付，P-04）。 */
  async proofUsedElsewhere(orderId: string, payload: PaymentPayload): Promise<boolean> {
    const digest = this.proofDigest(payload);
    const rows = await this.d.db
      .select({ orderId: verifyPaymentAttempts.orderId })
      .from(verifyPaymentAttempts)
      .where(and(eq(verifyPaymentAttempts.proofDigest, digest), sql`${verifyPaymentAttempts.orderId} <> ${orderId}`))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * SDK 验证通过 → 登记尝试（同 (order, proofDigest) 幂等返回已存在的尝试）。
   * 返回 { attempt, replay }：replay=true 表示该凭证已处理过，调用方不得再次结算。
   */
  async onPaymentVerified(order: OrderRow, payload: PaymentPayload, payer: string | undefined): Promise<{ attempt: AttemptRow; replay: boolean }> {
    const digest = this.proofDigest(payload);
    const existing = (
      await this.d.db
        .select()
        .from(verifyPaymentAttempts)
        .where(and(eq(verifyPaymentAttempts.orderId, order.id), eq(verifyPaymentAttempts.proofDigest, digest)))
        .limit(1)
    )[0];
    if (existing) return { attempt: existing, replay: existing.state !== "FAILED" };
    const now = this.d.now();
    const [attempt] = await this.d.db
      .insert(verifyPaymentAttempts)
      .values({
        id: newId("pay"),
        orderId: order.id,
        proofDigest: digest,
        payer: payer ?? null,
        providerReference: null,
        network: order.network,
        state: "VERIFIED",
        errorCode: null,
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!attempt) {
      // 并发同凭证：另一请求已插入
      const again = (
        await this.d.db
          .select()
          .from(verifyPaymentAttempts)
          .where(and(eq(verifyPaymentAttempts.orderId, order.id), eq(verifyPaymentAttempts.proofDigest, digest)))
          .limit(1)
      )[0]!;
      return { attempt: again, replay: true };
    }
    await this.recordEvent("sdk_verify", `${attempt.id}:verified`, attempt.id, { payer: payer ?? null }, now);
    await this.setState(order.id, "SETTLEMENT_PENDING");
    return { attempt, replay: false };
  }

  /** SDK 结算结果 → 尝试/订单状态。 */
  async onSettleResult(attempt: AttemptRow, result: SettleResponse): Promise<OrderState> {
    const now = this.d.now();
    const tx = result.transaction || null;
    await this.recordEvent("sdk_settle", `${attempt.id}:${result.status ?? (result.success ? "success" : "failed")}:${tx ?? "-"}`, attempt.id, {
      success: result.success,
      status: result.status ?? null,
      errorReason: result.errorReason ?? null,
      transaction: tx,
    }, now);
    if (result.success && (result.status === "success" || result.status === undefined)) {
      await this.d.db
        .update(verifyPaymentAttempts)
        .set({ state: "SETTLED", providerReference: tx, lastCheckedAt: now, updatedAt: now })
        .where(eq(verifyPaymentAttempts.id, attempt.id));
      await this.setState(attempt.orderId, "PAID", { settledAt: now });
      await this.grantEntitlement(attempt.orderId);
      return "PAID";
    }
    if (result.success && result.status === "pending") {
      await this.d.db
        .update(verifyPaymentAttempts)
        .set({ state: "SETTLEMENT_PENDING", providerReference: tx, lastCheckedAt: now, updatedAt: now })
        .where(eq(verifyPaymentAttempts.id, attempt.id));
      await this.setState(attempt.orderId, "SETTLEMENT_PENDING");
      await this.grantEntitlement(attempt.orderId);
      return "SETTLEMENT_PENDING";
    }
    if (result.success && result.status === "timeout") {
      await this.d.db
        .update(verifyPaymentAttempts)
        .set({ state: "UNKNOWN", providerReference: tx, errorCode: "settlement_timeout", lastCheckedAt: now, updatedAt: now })
        .where(eq(verifyPaymentAttempts.id, attempt.id));
      await this.setState(attempt.orderId, "PAYMENT_UNKNOWN");
      return "PAYMENT_UNKNOWN";
    }
    await this.d.db
      .update(verifyPaymentAttempts)
      .set({ state: "FAILED", errorCode: result.errorReason ?? "settle_failed", lastCheckedAt: now, updatedAt: now })
      .where(eq(verifyPaymentAttempts.id, attempt.id));
    await this.setState(attempt.orderId, "PAYMENT_REQUIRED");
    return "PAYMENT_REQUIRED";
  }

  /** 结算调用抛异常（网络/超时）：外部结果未知 → PAYMENT_UNKNOWN，只对账不重付。 */
  async onSettleUnknown(attempt: AttemptRow, err: unknown, txHash: string | null): Promise<void> {
    const now = this.d.now();
    const msg = err instanceof Error ? err.message : String(err);
    await this.recordEvent("sdk_settle", `${attempt.id}:unknown:${now.getTime()}`, attempt.id, { error: msg.slice(0, 200), transaction: txHash }, now);
    await this.d.db
      .update(verifyPaymentAttempts)
      .set({ state: "UNKNOWN", errorCode: txHash ? "settlement_timeout" : "settle_exception", providerReference: txHash, lastCheckedAt: now, updatedAt: now })
      .where(eq(verifyPaymentAttempts.id, attempt.id));
    await this.setState(attempt.orderId, "PAYMENT_UNKNOWN");
  }

  async markDelivered(orderId: string): Promise<void> {
    const now = this.d.now();
    const order = await this.byId(orderId);
    if (!order) return;
    await this.d.db
      .update(verifyOrders)
      .set({
        deliveredAt: order.deliveredAt ?? now,
        state: order.state === "PAID" ? "DELIVERED" : order.state,
        updatedAt: now,
      })
      .where(eq(verifyOrders.id, orderId));
  }

  /* ---------- 额度 ---------- */

  async grantEntitlement(orderId: string): Promise<void> {
    const now = this.d.now();
    await this.d.db
      .insert(verifyEntitlements)
      .values({
        orderId,
        expiresAt: new Date(now.getTime() + this.d.entitlement.windowSeconds * 1000),
        maxRefreshes: this.d.entitlement.maxRefreshes,
        usedRefreshes: 0,
        reservedRefreshes: 0,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  async entitlement(orderId: string): Promise<EntitlementRow | null> {
    return (await this.d.db.select().from(verifyEntitlements).where(eq(verifyEntitlements.orderId, orderId)).limit(1))[0] ?? null;
  }

  /** 原子预留一次；无额度/过期 → null。 */
  async reserveRefresh(orderId: string): Promise<EntitlementRow | null> {
    const now = this.d.now();
    const rows = await this.d.db
      .update(verifyEntitlements)
      .set({ reservedRefreshes: sql`${verifyEntitlements.reservedRefreshes} + 1`, updatedAt: now })
      .where(
        and(
          eq(verifyEntitlements.orderId, orderId),
          gt(verifyEntitlements.expiresAt, now),
          sql`${verifyEntitlements.usedRefreshes} + ${verifyEntitlements.reservedRefreshes} < ${verifyEntitlements.maxRefreshes}`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async consumeRefresh(orderId: string): Promise<void> {
    await this.d.db
      .update(verifyEntitlements)
      .set({
        reservedRefreshes: sql`${verifyEntitlements.reservedRefreshes} - 1`,
        usedRefreshes: sql`${verifyEntitlements.usedRefreshes} + 1`,
        updatedAt: this.d.now(),
      })
      .where(and(eq(verifyEntitlements.orderId, orderId), gt(verifyEntitlements.reservedRefreshes, 0)));
  }

  async releaseRefresh(orderId: string): Promise<void> {
    await this.d.db
      .update(verifyEntitlements)
      .set({ reservedRefreshes: sql`${verifyEntitlements.reservedRefreshes} - 1`, updatedAt: this.d.now() })
      .where(and(eq(verifyEntitlements.orderId, orderId), gt(verifyEntitlements.reservedRefreshes, 0)));
  }

  /* ---------- 事件 / 对账 ---------- */

  async recordEvent(source: string, eventKey: string, attemptId: string | null, payload: Record<string, unknown>, at: Date): Promise<void> {
    await this.d.db
      .insert(verifyPaymentEvents)
      .values({
        paymentAttemptId: attemptId,
        source,
        eventKey,
        digest: hashCanonical(payload),
        payload,
        occurredAt: at,
        processed: true,
        createdAt: at,
      })
      .onConflictDoNothing();
  }

  async pendingAttempts(): Promise<AttemptRow[]> {
    return this.d.db.select().from(verifyPaymentAttempts).where(inArray(verifyPaymentAttempts.state, ["SETTLEMENT_PENDING", "UNKNOWN"]));
  }

  /** 对账一条尝试：有 tx hash 才能查；没有的保持 UNKNOWN 等人工。 */
  async reconcileAttempt(attempt: AttemptRow, query: (txHash: string) => Promise<SettleStatusResponse>): Promise<OrderState | null> {
    const now = this.d.now();
    if (!attempt.providerReference) {
      await this.d.db.update(verifyPaymentAttempts).set({ lastCheckedAt: now, updatedAt: now }).where(eq(verifyPaymentAttempts.id, attempt.id));
      return null;
    }
    let status: SettleStatusResponse;
    try {
      status = await query(attempt.providerReference);
    } catch (err) {
      log.warn("对账查询失败，保持待核实", { attemptId: attempt.id, error: err instanceof Error ? err.message : String(err) });
      await this.d.db.update(verifyPaymentAttempts).set({ lastCheckedAt: now, updatedAt: now }).where(eq(verifyPaymentAttempts.id, attempt.id));
      return null;
    }
    await this.recordEvent("reconcile", `${attempt.id}:${status.status ?? "?"}:${now.getTime()}`, attempt.id, { status: status.status ?? null, success: status.success }, now);
    if (status.success && status.status === "success") {
      await this.d.db.update(verifyPaymentAttempts).set({ state: "SETTLED", lastCheckedAt: now, updatedAt: now }).where(eq(verifyPaymentAttempts.id, attempt.id));
      const order = await this.byId(attempt.orderId);
      await this.setState(attempt.orderId, order?.deliveredAt ? "DELIVERED" : "PAID", { settledAt: now });
      await this.grantEntitlement(attempt.orderId);
      return "PAID";
    }
    if (status.status === "failed") {
      await this.d.db.update(verifyPaymentAttempts).set({ state: "FAILED", errorCode: status.errorReason ?? "settle_failed", lastCheckedAt: now, updatedAt: now }).where(eq(verifyPaymentAttempts.id, attempt.id));
      const order = await this.byId(attempt.orderId);
      if (order?.deliveredAt) {
        // 已按"信任 facilitator"交付但链上最终失败：记 FAILED 供人工处理，不自动重扣
        log.error("已交付订单结算最终失败，需人工核实", { orderId: attempt.orderId, attemptId: attempt.id });
        await this.setState(attempt.orderId, "FAILED");
        return "FAILED";
      }
      await this.setState(attempt.orderId, "PAYMENT_REQUIRED");
      return "PAYMENT_REQUIRED";
    }
    await this.d.db.update(verifyPaymentAttempts).set({ lastCheckedAt: now, updatedAt: now }).where(eq(verifyPaymentAttempts.id, attempt.id));
    return null;
  }
}
