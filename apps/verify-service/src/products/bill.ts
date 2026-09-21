/**
 * 账单（W4，U-02）：服务费（订单/付款尝试，含结算 tx）、交易本金（Guard 事件 spent）、gas（回执 gasUsed）分列；
 * 自付演示（付款人/owner ∈ DEMO_SELF_PAYMENT_ADDRESSES 或 payer == merchant）标 selfPayment。
 */
import type { Bill, BillLine } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { AttemptRow, OrderRow } from "../payments/orders";

export interface ExecutionForBill {
  attemptId: string;
  txHash: string | null;
  receipt: Record<string, unknown> | null;
  inputToken: string | null;
  chainId: number;
}

export function buildBill(cfg: VerifyConfig, order: OrderRow | null, attempts: AttemptRow[], executions: ExecutionForBill[], ownerAddress: string): Bill {
  const serviceFees: BillLine[] = [];
  const principal: BillLine[] = [];
  const gas: BillLine[] = [];
  let selfPayment = cfg.selfPaymentAddresses.has(ownerAddress.toLowerCase());
  if (order) {
    const settled = attempts.filter((a) => a.state === "SETTLED" || a.state === "SETTLEMENT_PENDING");
    if (order.priceUsd === "0") serviceFees.push({ label: `${order.sku} (free)`, asset: "USD", amountRaw: "0", amountUsd: "0", network: order.network, txHash: null });
    for (const a of settled) {
      serviceFees.push({ label: order.sku, asset: order.priceAsset ?? "USD", amountRaw: order.priceAmount ?? "", amountUsd: order.priceUsd, network: a.network, txHash: (a.providerReference as `0x${string}` | null) ?? null });
      if (a.payer && (cfg.selfPaymentAddresses.has(a.payer.toLowerCase()) || a.payer.toLowerCase() === order.merchant.toLowerCase())) selfPayment = true;
    }
  }
  for (const e of executions) {
    const ev = (e.receipt?.["event"] as Record<string, unknown> | undefined) ?? null;
    if (!ev || e.receipt?.["status"] !== "success") continue;
    principal.push({ label: `execution ${e.attemptId} spent`, asset: e.inputToken ?? "input", amountRaw: String(ev["spent"] ?? "0"), amountUsd: null, network: `eip155:${e.chainId}`, txHash: (e.txHash as `0x${string}` | null) ?? null });
    if (ev["refunded"] && ev["refunded"] !== "0") principal.push({ label: `execution ${e.attemptId} refunded`, asset: e.inputToken ?? "input", amountRaw: String(ev["refunded"]), amountUsd: null, network: `eip155:${e.chainId}`, txHash: (e.txHash as `0x${string}` | null) ?? null });
    if (e.receipt?.["gasUsed"]) gas.push({ label: `execution ${e.attemptId} gasUsed (units)`, asset: "gas", amountRaw: String(e.receipt["gasUsed"]), amountUsd: null, network: `eip155:${e.chainId}`, txHash: (e.txHash as `0x${string}` | null) ?? null });
  }
  return { serviceFees, principal, gas, selfPayment };
}
