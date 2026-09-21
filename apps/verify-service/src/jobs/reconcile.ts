/**
 * 对账 worker（同进程定时）：把 SETTLEMENT_PENDING / UNKNOWN 的付款尝试按 tx hash 向 facilitator 查最终状态。
 * 只推进状态，绝不发起新扣款（P-05 / P-08）。
 */
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import { log } from "../log";
import type { Orders } from "../payments/orders";

export async function reconcileOnce(orders: Orders, facilitator: FacilitatorClient): Promise<{ checked: number; resolved: number }> {
  const pending = await orders.pendingAttempts();
  let resolved = 0;
  const query = facilitator.getSettleStatus?.bind(facilitator);
  if (!query) {
    if (pending.length > 0) log.warn("facilitator 不支持状态查询，待核实付款只能人工处理", { pending: pending.length });
    return { checked: pending.length, resolved: 0 };
  }
  for (const a of pending) {
    const r = await orders.reconcileAttempt(a, (tx) => query(tx));
    if (r !== null) resolved += 1;
  }
  if (pending.length > 0) log.info("对账轮次", { checked: pending.length, resolved });
  return { checked: pending.length, resolved };
}

export function startReconciler(orders: Orders, facilitator: FacilitatorClient, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    reconcileOnce(orders, facilitator)
      .catch((err) => log.error("对账失败", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
