/**
 * 运营者命令行（只读订单/付款 + 退款工单，P-09 人工流程）。不发交易、不碰私钥。
 *   pnpm ops orders [STATE]                 列订单（默认 FAILED/PAYMENT_UNKNOWN）
 *   pnpm ops attempts                       列待核实付款尝试 + 待核实执行尝试
 *   pnpm ops refund open <orderId> <requestId> <reason> [amountUsd]
 *   pnpm ops refund list [STATE]
 *   pnpm ops refund set <refundId> <APPROVED|PAID|REJECTED> [providerReference]
 * 环境：DATABASE_URL（与 verify-service 同库）。
 */
import { desc, inArray, isNotNull, and } from "drizzle-orm";
import { verifyExecutionAttempts, verifyOrders, verifyPaymentAttempts } from "@chaconne/db";
import { openDb } from "../src/db";
import { Refunds, RefundError, type RefundState } from "../src/payments/refunds";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("缺 DATABASE_URL");
const out = (v: unknown) => console.info(JSON.stringify(v, (_k, x) => (x instanceof Date ? x.toISOString() : x), 2));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { db, close } = await openDb(url!);
  const refunds = new Refunds(db);
  try {
    switch (cmd) {
      case "orders": {
        const states = rest[0] ? [rest[0]] : ["FAILED", "PAYMENT_UNKNOWN"];
        out(await db.select().from(verifyOrders).where(inArray(verifyOrders.state, states)).orderBy(desc(verifyOrders.createdAt)).limit(100));
        break;
      }
      case "attempts": {
        const payments = await db.select().from(verifyPaymentAttempts).where(inArray(verifyPaymentAttempts.state, ["SETTLEMENT_PENDING", "UNKNOWN", "FAILED"])).orderBy(desc(verifyPaymentAttempts.createdAt)).limit(100);
        const executions = await db.select({ id: verifyExecutionAttempts.id, jobId: verifyExecutionAttempts.jobId, state: verifyExecutionAttempts.state, txHash: verifyExecutionAttempts.txHash, updatedAt: verifyExecutionAttempts.updatedAt }).from(verifyExecutionAttempts).where(and(inArray(verifyExecutionAttempts.state, ["SUBMITTED", "REORG_PENDING", "UNKNOWN"]), isNotNull(verifyExecutionAttempts.txHash))).orderBy(desc(verifyExecutionAttempts.updatedAt)).limit(100);
        out({ payments, executions });
        break;
      }
      case "refund": {
        const [sub, a, b, c, d] = rest;
        if (sub === "open") {
          if (!a || !b || !c) throw new Error("用法: refund open <orderId> <requestId> <reason> [amountUsd]");
          out(await refunds.open({ orderId: a, requestId: b, reason: c, ...(d ? { amountUsd: d } : {}) }));
        } else if (sub === "list") {
          out(await refunds.list(a as RefundState | undefined));
        } else if (sub === "set") {
          if (!a || !b) throw new Error("用法: refund set <refundId> <APPROVED|PAID|REJECTED> [providerReference]");
          out(await refunds.transition(a, b as RefundState, c));
        } else throw new Error("refund 子命令: open | list | set");
        break;
      }
      default:
        throw new Error("命令: orders | attempts | refund");
    }
  } catch (e) {
    if (e instanceof RefundError) {
      console.error(JSON.stringify({ error: e.code, message: e.message }));
      process.exitCode = 2;
    } else throw e;
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("ops failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
