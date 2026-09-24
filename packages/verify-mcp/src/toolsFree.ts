/**
 * 免 key 工具（V-40）：只打 A2MCP 单端点（平台约定：不带 API key；200-only 传输，缺参 → status=input_required）。
 * 没有 VERIFY_API_KEY 的 MCP 进程也能完整用这三个 + get_market_context / get_events / list_supported_assets / get_verification_policy / get_products。
 * 不签名、不付款：收费档回 402 时把 x402 挑战原样交给 host（或 agent-wallet 模式自动付）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VerifyClient } from "./client";
import { fail, fromHttp, type ToolResult } from "./toolUtil";

export const TOOL_NAMES_FREE = ["verify_once_free", "plan_free", "agent_tasks_free"] as const;

const A2MCP_HINT = "No API key needed. The service answers HTTP 200 for both outcomes: structuredContent.status = delivered (result) or input_required (missingParams / problems / schema / example tell you what to add). Paid tiers answer 402 with an x402 challenge.";

function a2mcpSummary(b: Record<string, unknown>): string {
  if (b["status"] === "input_required") {
    const missing = (b["missingParams"] as string[] | undefined) ?? [];
    const problems = ((b["problems"] as Array<{ field: string; hint: string }> | undefined) ?? []).map((p) => `${p.field}: ${p.hint}`);
    return `input_required${missing.length ? `; missing ${missing.join(", ")}` : ""}${problems.length ? `; invalid ${problems.join("; ")}` : ""}${typeof b["summary"] === "string" ? `. ${b["summary"]}` : ""}`;
  }
  return typeof b["summary"] === "string" ? b["summary"] : `status ${String(b["status"])}`;
}

async function a2mcp(c: VerifyClient, path: string, body: Record<string, unknown>, summary: (b: Record<string, unknown>) => string = a2mcpSummary): Promise<ToolResult> {
  try {
    return fromHttp(await c.call("POST", path, body, {}, { auth: false }), summary);
  } catch (e) {
    return fail("service_unreachable", `${path}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}

export function registerFreeTools(server: McpServer, d: { client: VerifyClient }): void {
  const c = d.client;
  server.registerTool(
    "verify_once_free",
    {
      title: "Verify one purchase (free, no key; A2MCP)",
      description: `POST /a2mcp/verify. One-shot verification of a tokenized-stock purchase on X Layer under a policy (default REFERENCE_CONTEXT): reference vs executable price, price impact, market session. Symbols (AAPLx / NVDAx / AAPL), 0x addresses and eip155 keys are all accepted; amount is a human number ("100"). A delivered result includes publicUrl (key-less public report) and publicBundleUrl (evidence bundle). Identical (owner, asset, amount, policy) within 60 s reuses the same job. ${A2MCP_HINT}`,
      inputSchema: {
        ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address").optional().describe("Wallet that would fund the trade (required by the service; omit to get the input_required envelope)"),
        outputAssetKey: z.string().optional().describe("Stock token: symbol (AAPLx), ticker (AAPL), 0x address or eip155:196:<address> (required by the service)"),
        amount: z.string().optional().describe('Human stablecoin amount, e.g. "100" (use this or amountInRaw)'),
        amountInRaw: z.string().regex(/^(0|[1-9]\d*)$/).optional().describe("Amount in the stablecoin's smallest unit"),
        inputAssetKey: z.string().optional().describe("Stablecoin: USDG | USDC | USDT0 or eip155 key; default USDG"),
        policyId: z.enum(["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"]).optional(),
        maxSlippageBps: z.number().int().min(1).max(300).optional(),
        maxPriceImpactBps: z.number().int().min(1).max(1000).optional(),
        maxReferenceDeviationBps: z.number().int().min(1).max(2000).optional(),
        clientRequestId: z.string().max(128).optional(),
      },
    },
    async (a) => a2mcp(c, "/a2mcp/verify", a),
  );

  server.registerTool(
    "plan_free",
    {
      title: "Plan a trade (free, no key; A2MCP)",
      description: `POST /a2mcp/plan. Amount ladder × funding asset × three policies → evidence-checked candidates with completion ratio, blocking reasons and next step. Never executes. ${A2MCP_HINT}`,
      inputSchema: {
        ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address"),
        inputAssetKeys: z.array(z.string()).min(1).describe("Funding stablecoins as eip155 keys (first = budget unit); see list_supported_assets"),
        outputAssetKey: z.string().min(1).describe("Stock token as eip155 key"),
        amountInRaw: z.string().regex(/^(0|[1-9]\d*)$/).describe("Total budget in the first input asset's smallest unit"),
        policyId: z.enum(["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"]),
        maxSlippageBps: z.number().int().min(1).max(300),
        maxPriceImpactBps: z.number().int().min(1).max(1000).optional(),
        maxReferenceDeviationBps: z.number().int().min(1).max(2000).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        deadline: z.string().optional(),
        clientRequestId: z.string().max(128).optional(),
      },
    },
    async (a) => a2mcp(c, "/a2mcp/plan", a, (b) => (b["status"] === "input_required" ? a2mcpSummary(b) : `plan ${String(b["planId"])}: recommended ${String(b["recommended"] ?? "none")}, ${((b["candidates"] as unknown[] | undefined) ?? []).length} candidate(s)`)),
  );

  server.registerTool(
    "agent_tasks_free",
    {
      title: "Agent Tasks: event impacts + task drafts (free, no key; A2MCP)",
      description: `POST /a2mcp/agent-tasks. Give an owner wallet and/or stock tokens; returns event impacts (against holdings and tasks) and taskDrafts. Each taskDrafts[].draft is a complete SIMULATION body for create_task / POST /v1/tasks (a dated replay suggestion, when no event is in range, is in taskDrafts[].replay, not in the body). Nothing is executed. ${A2MCP_HINT}`,
      inputSchema: {
        owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address").optional(),
        assets: z.array(z.string()).optional().describe("Symbols (AAPLx, NVDA) or eip155 keys"),
        horizonHours: z.number().int().min(1).max(336).optional(),
      },
    },
    async (a) => a2mcp(c, "/a2mcp/agent-tasks", a, (b) => (b["status"] === "input_required" ? a2mcpSummary(b) : `${((b["taskDrafts"] as unknown[] | undefined) ?? []).length} draft(s); events ${String((b["events"] as { status?: string } | undefined)?.status)}; impacts ${String((b["eventImpacts"] as { status?: string } | undefined)?.status)}`)),
  );
}
