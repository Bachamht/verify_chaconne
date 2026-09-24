/**
 * x402 付费闸门（技术设计 §7.1 / §7.3）：包一层 SDK 的 x402HTTPResourceServer，
 * 自己控制顺序：验证 → 登记尝试 → 结算 → 落库 → 交付。
 *
 *  - 未付款：402 + PAYMENT-REQUIRED（v2）
 *  - 已付款/结算中/免费：直接交付（同一订单不再次扣费）
 *  - 同一凭证重放：不再次结算，返回同一交付
 *  - 结算异常：PAYMENT_UNKNOWN，202 返回订单与查询入口，不引导重付
 */
import type { Request, Response } from "express";
import { ExpressAdapter } from "@okxweb3/x402-express";
import { x402ResourceServer, type RouteConfig, x402HTTPResourceServer } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import type { VerifyConfig } from "../config";
import { log } from "../log";
import type { Orders, OrderRow } from "../payments/orders";
import type { ObservedFacilitator } from "../payments/facilitator";
import { KeyedMutex } from "../payments/lock";

export const REPORT_ROUTE_PATTERN = "GET /v1/jobs/:id/report";
export const A2MCP_ROUTE_PATTERNS = ["POST /a2mcp/verify", "GET /a2mcp/verify"] as const;
/** v2 付费路由：规划报告 / 授权计划登记 / 第二个 A2MCP 服务 */
export const PLAN_REPORT_ROUTE_PATTERN = "GET /v1/plans/:id/report";
export const MANDATE_ROUTE_PATTERN = "POST /v1/mandates";
export const A2MCP_PLAN_ROUTE_PATTERNS = ["POST /a2mcp/plan", "POST /a2mcp/monitor"] as const;

export interface HandleOptions {
  /** 凭证 resource.url 必须包含其中之一（默认：本任务报告路径 + A2MCP verify 路径） */
  expectedPaths?: string[];
}

export interface Paywall {
  httpServer: x402HTTPResourceServer;
  initialize(): Promise<void>;
  /** 在报告路由里调用：负责 402/结算/交付 */
  handleReport(req: Request, res: Response, order: OrderRow, deliver: () => Promise<unknown>, opts?: HandleOptions): Promise<void>;
  /** 测试/诊断：进程内订单锁 */
  readonly locks: KeyedMutex;
}

export function createPaywall(cfg: VerifyConfig, facilitator: ObservedFacilitator, orders: Orders): Paywall {
  const resourceServer = new x402ResourceServer(facilitator).register(cfg.PAYMENT_NETWORK, new ExactEvmScheme());
  const locks = new KeyedMutex();
  const payTo = cfg.MERCHANT_RECIPIENT_ADDRESS || "0x0000000000000000000000000000000000000000";
  const routes: Record<string, RouteConfig> = {
    [PLAN_REPORT_ROUTE_PATTERN]: {
      accepts: {
        scheme: "exact",
        network: cfg.PAYMENT_NETWORK,
        payTo,
        price: async (ctx) => {
          const planId = ctx.path.split("/")[3] ?? "";
          const order = await orders.byRef(planId);
          return `$${order?.priceUsd ?? cfg.PRODUCT_PRICE_PLAN_USD}`;
        },
        maxTimeoutSeconds: 120,
      },
      description: "Chaconne Verify — trade plan (finite candidates, evidence-hashed)",
      mimeType: "application/json",
      unpaidResponseBody: async (ctx) => {
        const planId = ctx.path.split("/")[3] ?? "";
        const order = await orders.byRef(planId);
        if (order) await orders.markPaymentRequired(order.id);
        return { contentType: "application/json", body: { error: "payment_required", planId, orderId: order?.id ?? null, sku: "plan", priceUsd: order?.priceUsd ?? cfg.PRODUCT_PRICE_PLAN_USD, network: cfg.PAYMENT_NETWORK } };
      },
    },
    [MANDATE_ROUTE_PATTERN]: {
      accepts: {
        scheme: "exact",
        network: cfg.PAYMENT_NETWORK,
        payTo,
        // 登记授权计划：价格按 body.sku（task_bundle 默认 / monitor_window）；SDK 只给 path，价格由 ctx 之外的订单决定 → 用两档中较高者作 402 挑战，结算金额以订单为准
        price: async () => `$${maxUsd(cfg.PRODUCT_PRICE_TASK_BUNDLE_USD, cfg.PRODUCT_PRICE_MONITOR_WINDOW_USD)}`,
        maxTimeoutSeconds: 120,
      },
      description: "Chaconne Verify — register a signed trade mandate (task bundle / monitor window)",
      mimeType: "application/json",
      unpaidResponseBody: async () => ({ contentType: "application/json", body: { error: "payment_required", sku: "task_bundle|monitor_window", network: cfg.PAYMENT_NETWORK, note: "Re-POST the same body with PAYMENT-SIGNATURE; registration is idempotent by clientRequestId." } }),
    },
    [REPORT_ROUTE_PATTERN]: {
      accepts: {
        scheme: "exact",
        network: cfg.PAYMENT_NETWORK,
        payTo: cfg.MERCHANT_RECIPIENT_ADDRESS || "0x0000000000000000000000000000000000000000",
        price: async (ctx) => {
          const jobId = ctx.path.split("/")[3] ?? "";
          const order = await orders.byJobId(jobId);
          return `$${order?.priceUsd ?? cfg.REPORT_PRICE_USD}`;
        },
        maxTimeoutSeconds: 120,
      },
      description: "Chaconne Verify — StockProof verification report (immutable, evidence-bound)",
      mimeType: "application/json",
      unpaidResponseBody: async (ctx) => {
        const jobId = ctx.path.split("/")[3] ?? "";
        const order = await orders.byJobId(jobId);
        if (order) await orders.markPaymentRequired(order.id);
        return {
          contentType: "application/json",
          body: {
            error: "payment_required",
            jobId,
            orderId: order?.id ?? null,
            priceUsd: order?.priceUsd ?? cfg.REPORT_PRICE_USD,
            network: cfg.PAYMENT_NETWORK,
            note: "Pay via x402 (PAYMENT-SIGNATURE header) and retry the same request. Reading an already-paid report never charges again.",
          },
        };
      },
    },
  };
  for (const pattern of A2MCP_PLAN_ROUTE_PATTERNS) {
    routes[pattern] = {
      accepts: { scheme: "exact", network: cfg.PAYMENT_NETWORK, payTo, price: `$${cfg.PRODUCT_PRICE_PLAN_USD}`, maxTimeoutSeconds: 120 },
      description: "Chaconne Verify — Plan & Monitor (OKX AI A2MCP endpoint)",
      mimeType: "application/json",
      unpaidResponseBody: async () => ({ contentType: "application/json", body: { error: "payment_required", priceUsd: cfg.PRODUCT_PRICE_PLAN_USD, network: cfg.PAYMENT_NETWORK } }),
    };
  }
  for (const pattern of A2MCP_ROUTE_PATTERNS) {
    routes[pattern] = {
      accepts: {
        scheme: "exact",
        network: cfg.PAYMENT_NETWORK,
        payTo: cfg.MERCHANT_RECIPIENT_ADDRESS || "0x0000000000000000000000000000000000000000",
        price: `$${cfg.REPORT_PRICE_USD}`,
        maxTimeoutSeconds: 120,
      },
      description: "Chaconne Verify — StockProof verification (OKX AI A2MCP endpoint)",
      mimeType: "application/json",
      unpaidResponseBody: async () => ({
        contentType: "application/json",
        body: {
          error: "payment_required",
          priceUsd: cfg.REPORT_PRICE_USD,
          network: cfg.PAYMENT_NETWORK,
          note: "Pay via x402 (PAYMENT-SIGNATURE header) and retry the same request with the same parameters. A paid verification is never charged twice.",
        },
      }),
    };
  }
  const httpServer = new x402HTTPResourceServer(resourceServer, routes).setPollDeadline(cfg.SETTLE_POLL_DEADLINE_MS);

  return {
    httpServer,
    locks,
    async initialize() {
      await httpServer.initialize();
    },
    // FIX-087：同一订单串行化——并发同凭证/不同凭证不得二次结算，交付前必有结算落库
    async handleReport(req, res, order0, deliver, opts) {
      await locks.withLock(order0.id, async () => {
        const order = (await orders.byId(order0.id)) ?? order0;
        await handleLocked(req, res, order, deliver, opts);
      });
    },
  };

  async function handleLocked(req: Request, res: Response, order: OrderRow, deliver: () => Promise<unknown>, opts?: HandleOptions): Promise<void> {
    {
      // 免费或已放行状态：直接交付
      if (order.priceUsd === "0" || orders.isDeliverable(order)) {
        const body = await deliver();
        await orders.markDelivered(order.id);
        res.status(200).json(body);
        return;
      }
      if (order.state === "PAYMENT_UNKNOWN") {
        res.status(202).json({
          error: "payment_unknown",
          orderId: order.id,
          message: "The previous payment's settlement result is unknown and is being reconciled; do not pay again, retry the same request shortly.",
          messageZh: "上一笔付款结算结果未知，正在对账；请勿重复付款，稍后重试同一请求。",
          statusUrl: `/v1/jobs/${order.jobId}`,
        });
        return;
      }

      const ctx = { adapter: new ExpressAdapter(req), path: req.path, method: req.method };
      const result = await httpServer.processHTTPRequest(ctx);
      if (result.type === "payment-error") {
        res.status(result.response.status);
        for (const [k, v] of Object.entries(result.response.headers)) res.setHeader(k, v);
        if (result.response.isHtml) res.send(result.response.body as string);
        else res.json(result.response.body ?? {});
        return;
      }
      if (result.type === "no-payment-required") {
        const body = await deliver();
        await orders.markDelivered(order.id);
        res.status(200).json(body);
        return;
      }

      // 凭证绑定检查：资源 URL 必须指向本任务或 A2MCP 端点（防把别的任务的付款凭证重放过来，P-04）
      const resourceUrl = result.paymentPayload.resource?.url ?? "";
      const expectedPaths = opts?.expectedPaths ?? [`/v1/jobs/${order.jobId}/report`, ...A2MCP_ROUTE_PATTERNS.map((p) => p.split(" ")[1]!)];
      if (!expectedPaths.some((p) => resourceUrl.includes(p))) {
        res.status(402).json({ error: "payment_resource_mismatch", orderId: order.id });
        return;
      }
      // 同一凭证不得用于另一订单（A2MCP 路径下资源 URL 对所有任务相同，靠凭证全局唯一兜底）
      if (await orders.proofUsedElsewhere(order.id, result.paymentPayload)) {
        res.status(402).json({ error: "payment_proof_reused", orderId: order.id });
        return;
      }

      const { attempt, replay } = await orders.onPaymentVerified(order, result.paymentPayload, undefined);
      if (replay) {
        // 同凭证重放：不重复结算；若已可交付则直接交付，否则告知对账中
        const fresh = await orders.byId(order.id);
        if (fresh && orders.isDeliverable(fresh)) {
          const body = await deliver();
          await orders.markDelivered(order.id);
          res.status(200).json(body);
        } else {
          res.status(202).json({ error: "payment_pending_reconciliation", orderId: order.id, attemptId: attempt.id });
        }
        return;
      }

      // FIX-087：锁内再查——订单已被另一凭证结算放行 → 本凭证不结算（不重复扣款），直接交付
      {
        const settled = (await orders.settledAttempts(order.id)).filter((a) => a.id !== attempt.id);
        if (settled.length > 0) {
          await orders.markSuperseded(attempt.id);
          const body = await deliver();
          await orders.markDelivered(order.id);
          res.status(200).json(body);
          return;
        }
      }

      let settle;
      facilitator.reset();
      try {
        settle = await httpServer.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: ctx });
      } catch (err) {
        await orders.onSettleUnknown(attempt, err, null);
        log.warn("结算调用异常 → PAYMENT_UNKNOWN", { orderId: order.id, attemptId: attempt.id });
        res.status(202).json({ error: "payment_unknown", orderId: order.id, attemptId: attempt.id, statusUrl: `/v1/jobs/${order.jobId}` });
        return;
      }
      const exception = facilitator.consumeSettleException();
      if (!settle.success && (exception !== null || settle.errorReason === "settlement_timeout")) {
        // 外部结果未知（网络异常 / 链上确认超时）：只对账，不重付
        await orders.onSettleUnknown(attempt, exception ?? new Error(settle.errorReason), settle.transaction || null);
        log.warn("结算结果未知 → PAYMENT_UNKNOWN", { orderId: order.id, attemptId: attempt.id, reason: settle.errorReason });
        res.status(202).json({ error: "payment_unknown", orderId: order.id, attemptId: attempt.id, statusUrl: `/v1/jobs/${order.jobId}` });
        return;
      }
      const state = await orders.onSettleResult(attempt, settle);
      for (const [k, v] of Object.entries(settle.headers ?? {})) res.setHeader(k, v);
      if (state === "PAID" || state === "SETTLEMENT_PENDING") {
        const body = await deliver();
        await orders.markDelivered(order.id);
        res.status(200).json(body);
        return;
      }
      if (state === "PAYMENT_UNKNOWN") {
        res.status(202).json({ error: "payment_unknown", orderId: order.id, attemptId: attempt.id, statusUrl: `/v1/jobs/${order.jobId}` });
        return;
      }
      // 结算失败：按 SDK 给的 402 指令返回
      if (!settle.success) {
        res.status(settle.response.status);
        for (const [k, v] of Object.entries(settle.response.headers)) res.setHeader(k, v);
        res.json({ error: "settlement_failed", reason: settle.errorReason, orderId: order.id, ...(typeof settle.response.body === "object" ? settle.response.body : {}) });
        return;
      }
      res.status(402).json({ error: "payment_required", orderId: order.id });
    }
  }
}

function maxUsd(a: string, b: string): string {
  return Number(a) >= Number(b) ? a : b;
}
