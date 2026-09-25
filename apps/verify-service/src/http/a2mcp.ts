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
import type { Paywall } from "./paywall";
import { HttpError, type VerifyService } from "../jobs/service";
import type { ClubService } from "../club/service";
import { inputRequiredBody, parseFriendlyInput } from "./a2mcpInput";
import { discoveryLinks } from "./a2mcpAgentTasks";
import { englishMessage, translateDetails } from "./errors";

/** V-42：同一 (owner, 标的, 金额, 策略) 在 60 s 内复用同一 job（不重复打上游、不重复建库存）；显式 clientRequestId 的幂等语义不变 */
export const A2MCP_REUSE_WINDOW_MS = 60_000;

/**
 * 调用方没给 clientRequestId 时的自动幂等键（FIX-178）：参数哈希 + 60 s 时间窗。
 * 此前只哈希参数 → 同参数永远命中第一次建的 job（幂等表按 caller+clientRequestId 查库，没有时限），
 * Agent「交易前再核验一次」拿回的是几天前的报告。现在同参数只在同一分钟内复用，过了就重新采证。
 */
export function autoClientRequestId(rest: Record<string, unknown>, nowMs: number): string {
  return `auto-${hashCanonical({ ...rest, window: Math.floor(nowMs / A2MCP_REUSE_WINDOW_MS) }).slice(2, 34)}`;
}

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

/** 对外绝对地址的根：PUBLIC_BASE_URL（运营者 env），缺省线上域名 */
export function publicBase(cfg: Pick<VerifyConfig, "PUBLIC_BASE_URL">): string {
  return (cfg.PUBLIC_BASE_URL || "https://verify.chaconne.xyz").replace(/\/$/, "");
}

export function a2mcpExample(cfg: VerifyConfig, inputAssetKey: string, outputAssetKey: string) {
  return {
    minimal: { ownerAddress: "0x1111111111111111111111111111111111111111", outputAssetKey: "AAPLx", amount: "100" },
    full: { ownerAddress: "0x1111111111111111111111111111111111111111", inputAssetKey, outputAssetKey, amountInRaw: "100000000", policyId: "STRICT_LIVE", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300 },
    curl: `curl -X POST ${publicBase(cfg)}${A2MCP_PATH} -H "Content-Type: application/json" -d '{"ownerAddress":"0x1111111111111111111111111111111111111111","outputAssetKey":"AAPLx","amount":"100"}'`,
  };
}

export function createA2mcpHandler(d: { cfg: VerifyConfig; service: VerifyService; paywall: Paywall; club?: ClubService | null; now?: () => Date }) {
  const base = publicBase(d.cfg);
  const now = d.now ?? (() => new Date());
  const recent = new Map<string, { jobId: string; at: number }>();
  const inputRequired = (res: Response, parsed: ReturnType<typeof parseFriendlyInput>, extra?: unknown) => {
    const [stable, stock] = [
      d.service.registry.entries.find((e) => e.role === "stable_input")?.assetKey ?? "eip155:196:0x…",
      d.service.registry.entries.find((e) => e.role === "stock_output")?.assetKey ?? "eip155:196:0x…",
    ];
    const body = inputRequiredBody({ service: "Chaconne Verify / StockProof", endpoint: base + A2MCP_PATH, method: "POST", schema: A2MCP_INPUT_SCHEMA, example: a2mcpExample(d.cfg, stable, stock), missing: parsed.missing, problems: parsed.problems, resolved: parsed.resolved, reg: d.service.registry, discovery: discoveryLinks(d.cfg) });
    // 200 而不是 400：OKX 客户端只接受 200/402
    res.status(200).json(extra === undefined ? body : { ...body, details: extra });
  };

  return async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "private, no-store");
    const startedAt = Date.now();
    const agentId = req.header("x-okx-agent-id") || req.header("x-agent-id") || "";
    const rawBody = ((req.method === "GET" ? req.query : req.body) ?? {}) as Record<string, unknown>;
    const finish = (status: number, outcome: string, jobId?: string) =>
      log.info("a2mcp 调用", { path: A2MCP_PATH, method: req.method, ip: req.ip, agentId: agentId || null, contentType: req.header("content-type") ?? null, ua: (req.header("user-agent") ?? "").slice(0, 80), fields: Object.keys(rawBody), status, outcome, jobId: jobId ?? null, ms: Date.now() - startedAt });
    res.on("finish", () => finish(res.statusCode, (res.getHeader("x-a2mcp-outcome") as string) ?? "sent"));
    // 限流由 app.ts 的 freeRateLimiter 统一处理（V-42：RateLimit-* 头 + Retry-After）
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
    const nowMs = now().getTime();
    if (!normalized.clientRequestId) {
      const { clientRequestId: _omit, ...rest } = normalized;
      normalized.clientRequestId = autoClientRequestId(rest, nowMs);
    }
    // V-42：60 s 内同一 (owner, 标的, 金额, 策略) 复用同一 job（只在调用方没给 clientRequestId 时；给了就按它的幂等语义）
    const reuseKey = `${callerId}|${owner.toLowerCase()}|${parsed.outputAssetKey}|${parsed.amountInRaw}|${parsed.policyId}`;
    for (const [k, v] of recent) if (nowMs - v.at > A2MCP_REUSE_WINDOW_MS) recent.delete(k);
    const hit = !parsed.clientRequestId ? recent.get(reuseKey) : undefined;
    let created: { body: { jobId: string; evidenceMode: string } };
    let reused = false;
    if (hit) {
      const row = await d.service.requireJob(callerId, hit.jobId);
      created = { body: { jobId: row.id, evidenceMode: d.service["d"].evidence.mode } };
      reused = true;
    } else {
      try {
        created = (await d.service.createJob(callerId, normalized)) as { body: { jobId: string; evidenceMode: string } };
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) {
          res.setHeader("x-a2mcp-outcome", "input_invalid");
          const m = englishMessage(err.code, err.message);
          inputRequired(res, parsed, { code: err.code, ...m, fields: translateDetails(err.details ?? null) });
          return;
        }
        throw err;
      }
      recent.set(reuseKey, { jobId: created.body.jobId, at: nowMs });
    }
    const jobId = created.body.jobId;
    const order = await d.service.requireOrder(jobId);
    // 报告交付经同一付费闸门；免费直接 200
    await d.paywall.handleReport(req, res, order, async () => {
      const delivered = await d.service.deliverReport(jobId);
      res.setHeader("x-a2mcp-outcome", `delivered:${delivered.report.verdict}`);
      // V-39：平台建的 job 调用方没有 key，回查必须免 key —— 交付即自动公开一份只读战报（钱包隐藏、金额区间化；同一 job 幂等）
      let share: { shareId: string } | null = null;
      if (d.club) {
        try {
          share = await d.club.setShare(callerId, { kind: "job", refId: jobId, public: true, privacy: { amounts: "range" } });
        } catch (err) {
          log.warn("a2mcp 自动公开战报失败（响应不带 publicUrl）", { jobId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const publicUrl = share ? `${base}/pub/reports/${share.shareId}` : null;
      const r = delivered.report;
      const ref = r.reference;
      // URL 放句尾且后面不接标点（V-39：此前 URL 与句号粘在一起，Agent 会把句号当 URL 的一部分）
      const ownerPageUrl = `${base}/jobs/${jobId}`;
      // V-39：URL 放句尾且后面不接标点；FIX-178：先告诉钱包主人在网站哪里看（ownerPageUrl 字段给精确地址）
      const recheck = ` The owner sees this report on the website under My tasks & records with wallet ${owner.toLowerCase()} connected.${publicUrl ? ` Evidence is immutable and re-checkable without a key at ${publicUrl}` : ` Evidence is immutable; status (API key required): ${base}/v1/jobs/${jobId}`}`;
      const summary = `${r.verdict.toUpperCase()} under ${normalized.policyId}: ${r.executionEligible ? "this purchase is eligible for execution" : "not eligible"} (market ${r.marketSession}${ref ? `, reference ${ref.kind} $${ref.priceUsd}${ref.deviationBps !== null ? `, executable price ${ref.deviationBps > 0 ? "+" : ""}${(ref.deviationBps / 100).toFixed(2)}% vs reference` : ""}` : ""}${r.normalizedQuote?.adverseImpactBps !== null && r.normalizedQuote?.adverseImpactBps !== undefined ? `, price impact ${r.normalizedQuote.adverseImpactBps} bps` : ""}).${r.reasons.length ? " Reasons: " + r.reasons.map((x) => x.code).join(", ") + "." : ""} Report hash ${delivered.reportHash.slice(0, 10)}….${recheck}`;
      return {
        ok: true,
        status: "delivered",
        summary,
        resolvedInput: parsed.resolved,
        service: "Chaconne Verify / StockProof",
        jobId,
        statusUrl: `${base}/v1/jobs/${jobId}`,
        /** 钱包主人在网站看这份报告的位置（需连接 ownerAddress 那个钱包并登录；FIX-178） */
        ownerPageUrl,
        statusUrlAuth: "owner-scoped: the owner wallet sees it with x-verify-caller: <ownerAddress> (or on the website with that wallet connected); use publicUrl for key-less re-checks",
        publicUrl,
        publicBundleUrl: share ? `${base}/pub/reports/${share.shareId}/bundle` : null,
        publicPageUrl: share ? `${base}/r/${share.shareId}` : null,
        shareId: share?.shareId ?? null,
        discovery: discoveryLinks(d.cfg),
        verdict: delivered.report.verdict,
        executionEligible: delivered.report.executionEligible,
        comparisonStatus: delivered.report.comparisonStatus,
        marketSession: delivered.report.marketSession,
        reasons: delivered.report.reasons,
        reference: delivered.report.reference,
        normalizedQuote: delivered.report.normalizedQuote,
        evidenceMode: created.body.evidenceMode,
        reused,
        reuseNote: reused ? `Same owner, asset, amount and policy as a job created less than ${A2MCP_REUSE_WINDOW_MS / 1000} s ago: that job's latest report is returned instead of a new verification (pass clientRequestId to control idempotency yourself).` : null,
        report: delivered.report,
        reportHash: delivered.reportHash,
        disclaimer: "Verification of data comparability and execution constraints only. Not investment advice; no guarantee of fill or profit.",
      };
    });
  };
}
