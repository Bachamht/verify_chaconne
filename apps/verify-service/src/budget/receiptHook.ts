/**
 * 回执 → 资金组账目（B-02 / B-03）：包装授权计划的 ReceiptStore，
 *   步骤 CONFIRMED → coordinator.settle(mandateId, stepIndex, event.spent)（幂等）
 *   步骤 REVERTED  → coordinator.unpend（只解除在途占用；预留仍在，等授权本身链上到期/撤销才释放）
 * 只在回执核实器之后追加动作，不改 MandatesService。
 */
import { eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyMandateSteps } from "@chaconne/db";
import type { ReceiptStore } from "../execution/receipts";
import type { BudgetCoordinator } from "./coordinator";
import { log } from "../log";

export function withBudgetSettlement(db: Db, store: ReceiptStore, coordinator: BudgetCoordinator): ReceiptStore {
  return {
    pendingExecutionAttempts: () => store.pendingExecutionAttempts(),
    async applyReceipt(stepId, state, receipt) {
      await store.applyReceipt(stepId, state, receipt);
      if (state !== "CONFIRMED" && state !== "REVERTED") return;
      const step = (await db.select({ mandateId: verifyMandateSteps.mandateId, stepIndex: verifyMandateSteps.stepIndex, stepJson: verifyMandateSteps.stepJson }).from(verifyMandateSteps).where(eq(verifyMandateSteps.id, stepId)).limit(1))[0];
      if (!step) return;
      try {
        if (state === "CONFIRMED") {
          const spent = (receipt["event"] as { spent?: string } | undefined)?.spent ?? "0";
          const r = await coordinator.settle(step.mandateId, step.stepIndex, spent, { txHash: (receipt["txHash"] as string | undefined) ?? null });
          if (r) log.info("资金组结算", { mandateId: step.mandateId, stepIndex: step.stepIndex, spent, applied: r.applied, promoted: r.promoted.length });
        } else {
          const amountIn = (step.stepJson as { step?: { amountIn?: string } }).step?.amountIn ?? "0";
          await coordinator.unpend(step.mandateId, step.stepIndex, amountIn, "reverted");
        }
      } catch (err) {
        log.error("资金组账目更新失败", { stepId, state, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
