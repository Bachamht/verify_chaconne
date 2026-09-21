/**
 * OKX AI A2MCP 单端点入口（Lane F 的平台接入形态；技术设计 §6.1 末段"固定 URL 包装同一用例"）。
 *
 *   POST /a2mcp/verify   body = CreateVerifyJob 子集（见 A2MCP_INPUT_SCHEMA）
 *
 * 行为（A2MCP 官方口径：免费服务 HTTP 200 直接返回结果；付费走 x402 402；OKX 客户端把其它状态一律判 endpoint_unreachable）：
 *  - 参数缺失/非法 → **200** 结构化 `status: input_required`（附 schema/示例/缺失项/已解析项），供平台/Agent 收集参数（I2 2026-09-21，ASP 驳回修复）；
 *  - 输入宽容：符号/地址/assetKey、人类金额、常见别名、公开默认值（见 a2mcpInput.ts）；
 *  - 免费（REPORT_PRICE_USD=0）→ 200 直接返回报告；
 *  - 收费 → 复用 /v1/jobs/:id/report 的 x402 闸门（同一订单、同一凭证语义）。
 *
 * 调用方身份：平台调用不带我们的 API key；callerId = `a2mcp:` + 请求头 `x-okx-agent-id`（若平台提供）否则 owner 地址。
 * 幂等：clientRequestId 缺省 = requestHash 前 32 位（同参数重复调用返回同一任务，不重复计费）。
 */
import type { Request, Response } from "express";
import { hashCanonical, LATEST_POLICY_VERSION } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { log } from "../log";
import { rateLimit } from "./auth";
import type { Paywall } from "./paywall";
import { HttpError, type VerifyService } from "../jobs/service";
import { inputRequiredBody, parseFriendlyInput } from "./a2mcpInput";

export const A2MCP_PATH = "/a2mcp/verify";

export const A2MCP_INPUT_SCHEMA = {
  type: "object",
  required: ["ownerAddress", "outputAssetKey"],
  properties: {
    ownerAddress: { type: "string", description: "EVM wallet that will fund the trade (0x…, 40 hex). Aliases: owner, wallet, address" },
    recipientAddress: { type: "string", description: "EVM address that receives the stock token; defaults to ownerAddress" },
    inputAssetKey: { type: "string", description: "Stablecoin to spend: symbol (USDG | USDC | USDT0), 0x address, or eip155:196:<address>. Default USDG" },
    outputAssetKey: { type: "string", description: "Stock token to buy: symbol (AAPLx | NVDAx) or ticker (AAPL | NVDA), 0x address, or eip155:196:<address>. Aliases: stock, token, symbol" },
    amount: { type: "string", description: 'Human amount of the stablecoin, e.g. "100" (= 100 USDG). Use this OR amountInRaw' },
    amountInRaw: { type: "string", description: "Input amount in the stablecoin's smallest unit (6 decimals: 5 USDG = \"5000000\")" },
    policyId: { type: "string", enum: ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"], description: "Verification policy; default REFERENCE_CONTEXT (official close as context). STRICT_LIVE requires US regular hours + live reference. No automatic downgrade" },
    maxSlippageBps: { type: "integer", minimum: 1, maximum: 300, description: "Max slippage in basis points (50 = 0.5%); default 50" },
    maxPriceImpactBps: { type: "integer", minimum: 1, maximum: 1000, description: "Optional; default 100" },
    maxReferenceDeviationBps: { type: "integer", minimum: 1, maximum: 2000, description: "Optional; default 300; not used by QUOTE_ONLY" },
    clientRequestId: { type: "string", description: "Optional idempotency key" },
  },
} as const;

export function a2mcpExample(cfg: VerifyConfig, inputAssetKey: string, outputAssetKey: string) {
  void cfg;
  return {
    minimal: { ownerAddress: "0x1111111111111111111111111111111111111111", outputAssetKey: "AAPLx", amount: "100" },
    full: { ownerAddress: "0x1111111111111111111111111111111111111111", inputAssetKey, outputAssetKey, amountInRaw: "100000000", policyId: "STRICT_LIVE", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300 },
    curl: 'curl -X POST https://verify.chaconne.xyz/a2mcp/verify -H "Content-Type: application/json" -d \'{"ownerAddress":"0x1111111111111111111111111111111111111111","outputAssetKey":"AAPLx","amount":"100"}\'',
  };
}

export function createA2mcpHandler(d: { cfg: VerifyConfig; service: VerifyService; paywall: Paywall }) {
  const inputRequired = (res: Response, parsed: ReturnType<typeof parseFriendlyInput>, extra?: unknown) => {
    const [stable, stock] = [
      d.service.registry.entries.find((e) => e.role === "stable_input")?.assetKey ?? "eip155:196:0x…",
      d.service.registry.entries.find((e) => e.role === "stock_output")?.assetKey ?? "eip155:196:0x…",
    ];
    const body = inputRequiredBody({ service: "Chaconne Verify / StockProof", endpoint: "https://verify.chaconne.xyz" + A2MCP_PATH, method: "POST", schema: A2MCP_INPUT_SCHEMA, example: a2mcpExample(d.cfg, stable, stock), missing: parsed.missing, problems: parsed.problems, resolved: parsed.resolved, reg: d.service.registry });
    // 200 而不是 400：OKX 客户端只接受 200/402
    res.status(200).json(extra === undefined ? body : { ...body, details: extra });
  };

  return async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "private, no-store");
    const startedAt = Date.now();
    const ipKey = `a2mcp:${req.ip ?? "unknown"}`;
    const agentId = req.header("x-okx-agent-id") || req.header("x-agent-id") || "";
    const rawBody = ((req.method === "GET" ? req.query : req.body) ?? {}) as Record<string, unknown>;
    const finish = (status: number, outcome: string, jobId?: string) =>
      log.info("a2mcp 调用", { path: A2MCP_PATH, method: req.method, ip: req.ip, agentId: agentId || null, contentType: req.header("content-type") ?? null, ua: (req.header("user-agent") ?? "").slice(0, 80), fields: Object.keys(rawBody), status, outcome, jobId: jobId ?? null, ms: Date.now() - startedAt });
    res.on("finish", () => finish(res.statusCode, (res.getHeader("x-a2mcp-outcome") as string) ?? "sent"));
    if (!rateLimit(ipKey, d.cfg.RATE_LIMIT_PER_MIN, 60_000)) {
      res.setHeader("x-a2mcp-outcome", "rate_limited");
      res.status(429).json({ ok: false, status: "rate_limited", error: "rate_limited", retryAfterSeconds: 60 });
      return;
    }
    const parsed = parseFriendlyInput(req, d.service.registry, d.cfg.EXECUTION_CHAIN_ID);
    if (parsed.missing.length > 0 || parsed.problems.length > 0) {
      res.setHeader("x-a2mcp-outcome", "input_required");
      inputRequired(res, parsed);
      return;
    }
    const owner = parsed.ownerAddress;
    const callerId = `a2mcp:${agentId ? `agent:${agentId}` : `owner:${owner.toLowerCase()}`}`;
    const normalized = {
      clientRequestId: parsed.clientRequestId,
      ownerAddress: owner,
      recipientAddress: parsed.recipientAddress,
      executionChainId: d.cfg.EXECUTION_CHAIN_ID,
      inputAssetKey: parsed.inputAssetKey,
      outputAssetKey: parsed.outputAssetKey,
      amountInRaw: parsed.amountInRaw,
      mode: "exactIn",
      policyId: parsed.policyId,
      policyVersion: LATEST_POLICY_VERSION,
      maxSlippageBps: parsed.maxSlippageBps,
      maxPriceImpactBps: parsed.maxPriceImpactBps,
      maxReferenceDeviationBps: parsed.maxReferenceDeviationBps,
    };
    if (!normalized.clientRequestId) {
      const { clientRequestId: _omit, ...rest } = normalized;
      normalized.clientRequestId = `auto-${hashCanonical(rest).slice(2, 34)}`;
    }
    let created;
    try {
      created = await d.service.createJob(callerId, normalized);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        res.setHeader("x-a2mcp-outcome", "input_invalid");
        inputRequired(res, parsed, { code: err.code, message: err.message, fields: err.details ?? null });
        return;
      }
      throw err;
    }
    const jobId = created.body.jobId;
    const order = await d.service.requireOrder(jobId);
    // 报告交付经同一付费闸门；免费直接 200
    await d.paywall.handleReport(req, res, order, async () => {
      const delivered = await d.service.deliverReport(jobId);
      res.setHeader("x-a2mcp-outcome", `delivered:${delivered.report.verdict}`);
      const r = delivered.report;
      const ref = r.reference;
      const summary = `${r.verdict.toUpperCase()} under ${normalized.policyId}: ${r.executionEligible ? "this purchase is eligible for execution" : "not eligible"} (market ${r.marketSession}${ref ? `, reference ${ref.kind} $${ref.priceUsd}${ref.deviationBps !== null ? `, executable price ${ref.deviationBps > 0 ? "+" : ""}${(ref.deviationBps / 100).toFixed(2)}% vs reference` : ""}` : ""}${r.normalizedQuote?.adverseImpactBps !== null && r.normalizedQuote?.adverseImpactBps !== undefined ? `, price impact ${r.normalizedQuote.adverseImpactBps} bps` : ""}).${r.reasons.length ? " Reasons: " + r.reasons.map((x) => x.code).join(", ") + "." : ""} Report hash ${delivered.reportHash.slice(0, 10)}…; evidence is immutable and re-checkable at ${"https://verify.chaconne.xyz/jobs/" + jobId}.`;
      return {
        ok: true,
        status: "delivered",
        summary,
        resolvedInput: parsed.resolved,
        service: "Chaconne Verify / StockProof",
        jobId,
        statusUrl: `/v1/jobs/${jobId}`,
        verdict: delivered.report.verdict,
        executionEligible: delivered.report.executionEligible,
        comparisonStatus: delivered.report.comparisonStatus,
        marketSession: delivered.report.marketSession,
        reasons: delivered.report.reasons,
        reference: delivered.report.reference,
        normalizedQuote: delivered.report.normalizedQuote,
        evidenceMode: created.body.evidenceMode,
        report: delivered.report,
        reportHash: delivered.reportHash,
        disclaimer: "Verification of data comparability and execution constraints only. Not investment advice; no guarantee of fill or profit.",
      };
    });
  };
}
