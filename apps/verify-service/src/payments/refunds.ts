/**
 * 退款工单（P-09，人工流程）：只记账与状态推进，不碰链上资金（服务没有任何能动钱的私钥，D-080）。
 * 口径（/v1/policies 公示）：rejected / limited 判定是已交付的核验服务，不退款；服务故障导致未交付才退。
 *   REQUESTED → APPROVED → PAID（填 providerReference = 运营者手工转账 tx）
 *   REQUESTED / APPROVED → REJECTED
 * 幂等：同 (orderId, requestId) 只建一单。金额不得超过订单价。
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyOrders, verifyRefunds } from "@chaconne/db";
import { newId } from "../ids";

export type RefundState = "REQUESTED" | "APPROVED" | "PAID" | "REJECTED";
export type RefundRow = typeof verifyRefunds.$inferSelect;

const TRANSITIONS: Record<RefundState, RefundState[]> = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["PAID", "REJECTED"],
  PAID: [],
  REJECTED: [],
};
/** 只有这些订单状态可能存在"已收款但未交付"或"结算异常" */
const REFUNDABLE_ORDER_STATES = new Set(["PAID", "DELIVERED", "FAILED", "PAYMENT_UNKNOWN", "SETTLEMENT_PENDING"]);

export class RefundError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

function toUsdMicros(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new RefundError("invalid_amount", `金额格式错误: ${s}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export class Refunds {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async open(args: { orderId: string; requestId: string; reason: string; amountUsd?: string; currency?: string }): Promise<{ refund: RefundRow; created: boolean }> {
    const order = (await this.db.select().from(verifyOrders).where(eq(verifyOrders.id, args.orderId)).limit(1))[0];
    if (!order) throw new RefundError("order_not_found");
    const existing = (await this.db.select().from(verifyRefunds).where(and(eq(verifyRefunds.orderId, args.orderId), eq(verifyRefunds.requestId, args.requestId))).limit(1))[0];
    if (existing) return { refund: existing, created: false };
    if (!REFUNDABLE_ORDER_STATES.has(order.state)) throw new RefundError("order_not_refundable", `订单状态 ${order.state} 不可退款（未收款）`);
    if (!args.reason.trim()) throw new RefundError("reason_required");
    const amount = args.amountUsd ?? order.priceUsd;
    if (toUsdMicros(amount) > toUsdMicros(order.priceUsd)) throw new RefundError("amount_exceeds_price", `退款 ${amount} 超过订单价 ${order.priceUsd}`);
    if (toUsdMicros(amount) === 0n) throw new RefundError("invalid_amount", "免费订单无可退金额");
    const now = this.now();
    const [row] = await this.db
      .insert(verifyRefunds)
      .values({ id: newId("rfd"), orderId: args.orderId, requestId: args.requestId, reason: args.reason.trim(), requestedAmount: amount, currency: args.currency ?? "USD", state: "REQUESTED", providerReference: null, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const raced = (await this.db.select().from(verifyRefunds).where(and(eq(verifyRefunds.orderId, args.orderId), eq(verifyRefunds.requestId, args.requestId))).limit(1))[0]!;
      return { refund: raced, created: false };
    }
    return { refund: row, created: true };
  }

  async transition(id: string, to: RefundState, providerReference?: string): Promise<RefundRow> {
    const row = (await this.db.select().from(verifyRefunds).where(eq(verifyRefunds.id, id)).limit(1))[0];
    if (!row) throw new RefundError("refund_not_found");
    const from = row.state as RefundState;
    if (!TRANSITIONS[from]?.includes(to)) throw new RefundError("invalid_transition", `${from} → ${to} 不允许`);
    if (to === "PAID" && !providerReference) throw new RefundError("provider_reference_required", "记 PAID 必须附退款 tx / 凭证");
    const [updated] = await this.db
      .update(verifyRefunds)
      .set({ state: to, providerReference: providerReference ?? row.providerReference, updatedAt: this.now() })
      .where(and(eq(verifyRefunds.id, id), eq(verifyRefunds.state, from)))
      .returning();
    if (!updated) throw new RefundError("concurrent_update");
    return updated;
  }

  async list(state?: RefundState): Promise<RefundRow[]> {
    const q = this.db.select().from(verifyRefunds);
    return (state ? q.where(eq(verifyRefunds.state, state)) : q).orderBy(desc(verifyRefunds.createdAt));
  }

  async byOrder(orderId: string): Promise<RefundRow[]> {
    return this.db.select().from(verifyRefunds).where(eq(verifyRefunds.orderId, orderId)).orderBy(desc(verifyRefunds.createdAt));
  }
}
