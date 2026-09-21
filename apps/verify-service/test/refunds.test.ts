/** 退款工单（P-09）：只对已收款/结算异常订单开单；幂等；金额上限；状态机；PAID 必须带凭证 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { verifyOrders } from "@chaconne/db";
import { Orders } from "../src/payments/orders";
import { Refunds, RefundError } from "../src/payments/refunds";
import { testDb, TEST_MERCHANT } from "./helpers";

async function setup() {
  const { db, close } = await testDb();
  const now = new Date("2026-09-20T12:00:00Z");
  const orders = new Orders({ db, now: () => now, entitlement: { maxRefreshes: 2, windowSeconds: 300 } });
  const refunds = new Refunds(db, () => now);
  const setState = async (orderId: string, state: string) => {
    await db.update(verifyOrders).set({ state }).where(eq(verifyOrders.id, orderId));
  };
  return { db, close, orders, refunds, setState };
}

describe("refund tickets", () => {
  it("未收款订单不可开单；PAID 订单可开单且幂等；金额不得超价", async () => {
    const { close, orders, refunds, setState } = await setup();
    const order = await orders.create({ jobId: "job_a", priceUsd: "0.01", network: "eip155:1952", merchant: TEST_MERCHANT });
    await expect(refunds.open({ orderId: order.id, requestId: "r1", reason: "x" })).rejects.toMatchObject({ code: "order_not_refundable" });
    await setState(order.id, "PAID");
    const first = await refunds.open({ orderId: order.id, requestId: "r1", reason: "service failure: report never delivered" });
    expect(first.created).toBe(true);
    expect(first.refund.state).toBe("REQUESTED");
    expect(first.refund.requestedAmount).toBe("0.01");
    const again = await refunds.open({ orderId: order.id, requestId: "r1", reason: "different text" });
    expect(again.created).toBe(false);
    expect(again.refund.id).toBe(first.refund.id);
    await expect(refunds.open({ orderId: order.id, requestId: "r2", reason: "x", amountUsd: "0.02" })).rejects.toMatchObject({ code: "amount_exceeds_price" });
    await expect(refunds.open({ orderId: "ord_missing", requestId: "r", reason: "x" })).rejects.toBeInstanceOf(RefundError);
    await close();
  });

  it("状态机：REQUESTED→APPROVED→PAID(需凭证)；PAID/REJECTED 终态；非法转移拒绝", async () => {
    const { close, orders, refunds, setState } = await setup();
    const order = await orders.create({ jobId: "job_b", priceUsd: "0.05", network: "eip155:1952", merchant: TEST_MERCHANT });
    await setState(order.id, "FAILED");
    const { refund } = await refunds.open({ orderId: order.id, requestId: "r1", reason: "on-chain settle failed after delivery", amountUsd: "0.05" });
    await expect(refunds.transition(refund.id, "PAID", "0xabc")).rejects.toMatchObject({ code: "invalid_transition" });
    const approved = await refunds.transition(refund.id, "APPROVED");
    expect(approved.state).toBe("APPROVED");
    await expect(refunds.transition(refund.id, "PAID")).rejects.toMatchObject({ code: "provider_reference_required" });
    const paid = await refunds.transition(refund.id, "PAID", "0x" + "ab".repeat(32));
    expect(paid.state).toBe("PAID");
    expect(paid.providerReference).toMatch(/^0xab/);
    await expect(refunds.transition(refund.id, "REJECTED")).rejects.toMatchObject({ code: "invalid_transition" });
    const r2 = await refunds.open({ orderId: order.id, requestId: "r2", reason: "dup request" });
    const rejected = await refunds.transition(r2.refund.id, "REJECTED");
    expect(rejected.state).toBe("REJECTED");
    expect((await refunds.list()).length).toBe(2);
    expect((await refunds.list("PAID")).map((r) => r.id)).toEqual([refund.id]);
    expect((await refunds.byOrder(order.id)).length).toBe(2);
    await close();
  });
});
