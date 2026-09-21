/**
 * 第二个 A2MCP 服务「Plan & Monitor」（D-083：先做端点与材料，提交待 #13803 审核结果）。
 *   POST /a2mcp/plan            body = 规划目标子集 → 规划报告（免费 200 / 收费 402）
 *   POST /a2mcp/monitor         body = 已签 TradeMandate 登记 → 授权计划视图（免费 200 / 收费 402）
 *   GET  /a2mcp/monitor/:id     授权计划状态（id 不可猜；平台无 key）
 */
import type { Request, Response } from "express";
import { hashCanonical } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { rateLimit } from "./auth";
import type { Paywall } from "./paywall";
import { HttpError } from "../jobs/service";
import type { PlansService } from "../plans/service";
import type { MandatesService } from "../mandates/service";

export const A2MCP_PLAN_PATH = "/a2mcp/plan";
export const A2MCP_MONITOR_PATH = "/a2mcp/monitor";

export const A2MCP_PLAN_INPUT_SCHEMA = {
  type: "object",
  required: ["ownerAddress", "inputAssetKeys", "outputAssetKey", "amountInRaw", "policyId", "maxSlippageBps"],
  properties: {
    ownerAddress: { type: "string", description: "EVM address that will fund the trade (0x…, 40 hex)" },
    recipientAddress: { type: "string", description: "Receives the stock token; defaults to ownerAddress" },
    inputAssetKeys: { type: "array", items: { type: "string" }, description: "Allowed funding stablecoins (eip155:<chainId>:<address>), first one is the budget unit; see GET /v1/assets" },
    outputAssetKey: { type: "string", description: "Stock token to buy (or sell), as eip155:<chainId>:<address>" },
    legs: { type: "array", description: "Optional basket instead of outputAssetKey: [{ outputAssetKey, weightBps }] summing to 10000", items: { type: "object" } },
    amountInRaw: { type: "string", description: "Total budget in the first input asset's smallest unit" },
    side: { type: "string", enum: ["buy", "sell"], description: "Default buy" },
    policyId: { type: "string", enum: ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"] },
    maxSlippageBps: { type: "integer", minimum: 1, maximum: 300 },
    maxPriceImpactBps: { type: "integer", minimum: 1, maximum: 1000 },
    maxReferenceDeviationBps: { type: "integer", minimum: 1, maximum: 2000 },
    deadline: { type: "string", description: "ISO time; default now + 1 h" },
    ladderBps: { type: "array", items: { type: "integer" }, description: "Optional amount ladder, default [10000,7500,5000,2500,1000]" },
    clientRequestId: { type: "string", description: "Optional idempotency key" },
  },
} as const;

export function createA2mcpPlanHandler(d: { cfg: VerifyConfig; plans: PlansService; paywall: Paywall }) {
  return async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!rateLimit(`a2mcp-plan:${req.ip ?? "unknown"}`, d.cfg.RATE_LIMIT_PER_MIN, 60_000)) {
      res.status(429).json({ ok: false, status: "rate_limited", error: "rate_limited", retryAfterSeconds: 60 });
      return;
    }
    // GET 探活/带 query 也接受（第三方与目录爬虫会用 GET；OKX 客户端只认 200/402）
    const body = ((req.method === "GET" ? req.query : req.body) ?? {}) as Record<string, unknown>;
    const inputRequired = (details: unknown) =>
      res.status(200).json({ ok: false, status: "input_required", error: "input_required", message: "Provide the planning goal. Fields are described in `schema`; a runnable example is in `example`.", schema: A2MCP_PLAN_INPUT_SCHEMA, example: { ownerAddress: "0x1111111111111111111111111111111111111111", inputAssetKeys: ["eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8"], outputAssetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", amountInRaw: "100000000", policyId: "REFERENCE_CONTEXT", maxSlippageBps: 50 }, details });
    if (Object.keys(body).length === 0) {
      inputRequired(null);
      return;
    }
    const owner = typeof body["ownerAddress"] === "string" ? body["ownerAddress"].toLowerCase() : "";
    const agentId = req.header("x-okx-agent-id") || req.header("x-agent-id") || "";
    const callerId = `a2mcp:${agentId ? `agent:${agentId}` : `owner:${owner}`}`;
    const legs = Array.isArray(body["legs"]) ? body["legs"] : typeof body["outputAssetKey"] === "string" ? [{ outputAssetKey: body["outputAssetKey"], weightBps: 10_000 }] : [];
    const goal: Record<string, unknown> = {
      ownerAddress: owner,
      recipientAddress: body["recipientAddress"],
      legs,
      budget: { inputAssetKeys: body["inputAssetKeys"], amountInRaw: body["amountInRaw"] },
      side: body["side"] ?? "buy",
      policyId: body["policyId"],
      policyVersion: typeof body["policyVersion"] === "string" ? body["policyVersion"] : "1.1.0",
      maxSlippageBps: body["maxSlippageBps"],
      maxPriceImpactBps: body["maxPriceImpactBps"] ?? null,
      maxReferenceDeviationBps: body["maxReferenceDeviationBps"],
      deadline: typeof body["deadline"] === "string" ? body["deadline"] : new Date(Date.now() + 3600_000).toISOString(),
      ladderBps: body["ladderBps"],
      clientRequestId: typeof body["clientRequestId"] === "string" ? body["clientRequestId"] : undefined,
    };
    if (!goal["clientRequestId"]) {
      const { clientRequestId: _o, deadline: _d, ...rest } = goal;
      void _o;
      void _d;
      goal["clientRequestId"] = `auto-${hashCanonical(rest).slice(2, 34)}`;
    }
    let created;
    try {
      created = await d.plans.create(callerId, goal);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        inputRequired({ code: err.code, message: err.message, fields: err.details ?? null });
        return;
      }
      throw err;
    }
    const row = await d.plans.requirePlan(callerId, created.body.planId);
    const order = (await d.plans.view(row)).order;
    const orderRow = order ? await d.plans["d"].orders.byId(order.orderId) : null;
    if (!orderRow) throw new HttpError(500, "order_missing");
    await d.paywall.handleReport(req, res, orderRow, async () => {
      const delivered = await d.plans.deliver(row);
      return { service: "Chaconne Verify / Plan & Monitor", planId: row.id, statusUrl: `/v1/plans/${row.id}`, evidenceMode: created.body.evidenceMode, recommended: delivered.plan.recommended, candidates: delivered.plan.candidates, plan: delivered.plan, planHash: delivered.planHash, disclaimer: "Planning of feasible, evidence-checked candidates only. Not investment advice; no guarantee of fill or profit. Shrinking the amount never counts as completing the original goal." };
    }, { expectedPaths: [A2MCP_PLAN_PATH, `/v1/plans/${row.id}/report`] });
  };
}

export function createA2mcpMonitorHandler(d: { cfg: VerifyConfig; mandates: MandatesService; paywall: Paywall }) {
  const register = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!rateLimit(`a2mcp-monitor:${req.ip ?? "unknown"}`, d.cfg.RATE_LIMIT_PER_MIN, 60_000)) {
      res.status(429).json({ ok: false, status: "rate_limited", error: "rate_limited", retryAfterSeconds: 60 });
      return;
    }
    // GET 探活/带 query 也接受（第三方与目录爬虫会用 GET；OKX 客户端只认 200/402）
    const body = ((req.method === "GET" ? req.query : req.body) ?? {}) as Record<string, unknown>;
    if (Object.keys(body).length === 0) {
      res.status(200).json({ ok: false, status: "input_required", error: "input_required", message: "POST a signed TradeMandate registration (same body as POST /v1/mandates): { clientRequestId, mandate, signature, inputAssetKey, legs, policyId, policyVersion, maxSlippageBps, maxPriceImpactBps, maxReferenceDeviationBps, sku }. Get the typed data to sign from GET /v1/policies + GET /v1/assets, domain ChaconneVerifyPlanGuard v1.", planGuard: d.cfg.PLANGUARD_ADDRESS || null });
      return;
    }
    const m = body["mandate"] as { owner?: string } | undefined;
    const owner = typeof m?.owner === "string" ? m.owner.toLowerCase() : "";
    const agentId = req.header("x-okx-agent-id") || req.header("x-agent-id") || "";
    const callerId = `a2mcp:${agentId ? `agent:${agentId}` : `owner:${owner}`}`;
    const r = await d.mandates.register(callerId, body);
    const orders = d.mandates["d"].orders;
    const orderRow = await orders.byRef(r.row.id);
    if (!orderRow) throw new HttpError(500, "order_missing");
    if (orderRow.priceUsd === "0" || orders.isDeliverable(orderRow)) {
      await d.mandates.activate(r.row.id);
      await orders.markDelivered(orderRow.id);
      res.status(r.status).json({ service: "Chaconne Verify / Plan & Monitor", ...(await d.mandates.view((await d.mandates.byId(r.row.id))!)), statusUrl: `${A2MCP_MONITOR_PATH}/${r.row.id}` });
      return;
    }
    await d.paywall.handleReport(req, res, orderRow, async () => {
      await d.mandates.activate(r.row.id);
      const fresh = (await d.mandates.byId(r.row.id))!;
      return { service: "Chaconne Verify / Plan & Monitor", ...(await d.mandates.view(fresh)), statusUrl: `${A2MCP_MONITOR_PATH}/${r.row.id}` };
    }, { expectedPaths: [A2MCP_MONITOR_PATH, "/v1/mandates"] });
  };
  const status = async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "private, no-store");
    const row = await d.mandates.byId(String(req.params["id"]));
    if (!row) throw new HttpError(404, "mandate_not_found");
    res.json(await d.mandates.view(row));
  };
  return { register, status };
}
