/**
 * 商品目录（W4，U-01）：价格来自配置（审核期 0），文案与 A2MCP 材料一致；每种商品写明"没有可行方案/信息不足算什么"。
 */
import type { Product, ProductSku } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";

export function productCatalog(cfg: VerifyConfig): Product[] {
  const net = cfg.PAYMENT_NETWORK;
  return [
    {
      sku: "verify_once",
      name: { en: "StockProof verification (one intent)", zh: "StockProof 单次核验" },
      priceUsd: cfg.REPORT_PRICE_USD,
      network: net,
      validitySeconds: null,
      delivery: { en: "One immutable, evidence-hashed report (eligible / limited / rejected) with reason codes and source times, plus re-verification credits for Guard execution.", zh: "一份不可变、带证据哈希的报告（eligible / limited / rejected），含原因码与源时间；附 Guard 执行用的再核验额度。" },
      noResultIs: { en: "A rejected or limited verdict is a delivered verification and is not refunded.", zh: "rejected / limited 判定就是已交付的核验，不退款。" },
    },
    {
      sku: "plan",
      name: { en: "Trade plan (finite candidates)", zh: "交易规划（有限候选）" },
      priceUsd: cfg.PRODUCT_PRICE_PLAN_USD,
      network: net,
      validitySeconds: null,
      delivery: { en: "Up to 12 deterministic candidates (amount ladder × funding asset × three policies) with completion ratio, fees, blocking reasons and next step; one recommended candidate at most.", zh: "最多 12 个确定性候选（金额阶梯 × 资金币种 × 三策略），含完成比例、费用、阻断原因与下一步；最多推荐一个。" },
      noResultIs: { en: "'No feasible candidate' is a delivered plan: it tells you which limit or condition blocks the goal. Shrinking the amount is never counted as completing the original goal.", zh: "「无可行候选」也是已交付的规划：它告诉你哪条限制或条件挡住了目标。缩小金额不算完成原目标。" },
    },
    {
      sku: "monitor_window",
      name: { en: "Monitoring window", zh: "监测窗口" },
      priceUsd: cfg.PRODUCT_PRICE_MONITOR_WINDOW_USD,
      network: net,
      validitySeconds: cfg.MONITOR_WINDOW_SECONDS,
      delivery: { en: "A registered mandate is re-evaluated continuously (30 s in regular hours, 5 min when closed); every evaluation records what changed, what it affects and the next step. Steps are certified only while READY.", zh: "已登记的授权计划持续再核验（常规时段 30 s，休市 5 min）；每次评估记录什么变了、影响什么、下一步是什么。只有 READY 时才签发步骤证书。" },
      noResultIs: { en: "A window that ends in WAIT or BLOCKED is delivered monitoring; nothing is executed and nothing is charged for execution.", zh: "窗口结束时仍是 WAIT / BLOCKED 也算已交付的监测；不执行任何交易，也不收执行费。" },
    },
    {
      sku: "task_bundle",
      name: { en: "Task bundle (plan + mandate + steps + evidence bundle)", zh: "任务套餐（规划 + 授权计划 + 步骤 + 证据包）" },
      priceUsd: cfg.PRODUCT_PRICE_TASK_BUNDLE_USD,
      network: net,
      validitySeconds: cfg.MONITOR_WINDOW_SECONDS,
      delivery: { en: "Monitoring window plus step certificates for a signed TradeMandate (executed by your own wallet or agent through PlanGuard), a bill and a signed evidence bundle you can verify offline.", zh: "监测窗口 + 已签 TradeMandate 的步骤证书（由你自己的钱包或 Agent 经 PlanGuard 执行）+ 账单 + 可离线验证的签名证据包。" },
      noResultIs: { en: "Steps that expire unexecuted, a paused or cancelled mandate, or a window that never reaches READY are all delivered service; the service never moves your funds.", zh: "步骤过期未执行、暂停或取消授权、窗口内从未 READY，都算已交付；服务从不动你的资金。" },
    },
  ];
}

export function productPrice(cfg: VerifyConfig, sku: ProductSku): string {
  switch (sku) {
    case "verify_once":
      return cfg.REPORT_PRICE_USD;
    case "plan":
      return cfg.PRODUCT_PRICE_PLAN_USD;
    case "monitor_window":
      return cfg.PRODUCT_PRICE_MONITOR_WINDOW_USD;
    case "task_bundle":
      return cfg.PRODUCT_PRICE_TASK_BUNDLE_USD;
  }
}

export function isProductSku(s: unknown): s is ProductSku {
  return s === "verify_once" || s === "plan" || s === "monitor_window" || s === "task_bundle";
}
