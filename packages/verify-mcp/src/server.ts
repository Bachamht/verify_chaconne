/**
 * Chaconne Verify · MCP 服务器（技术设计 §6.2：7 个薄工具；不接收私钥、不代签、不代付）。
 *
 * 工具 → HTTP：
 *   list_supported_assets     GET  /v1/assets
 *   get_verification_policy   GET  /v1/policies
 *   prepare_verification      POST /v1/jobs                       （创建任务，不付款）
 *   purchase_verification     GET  /v1/jobs/:id/report            （可带 host 产生的 x402 凭证；未付返回挑战）
 *   get_verification          GET  /v1/jobs/:id (+ /report)
 *   prepare_guard_trade       POST /v1/jobs/:id/prepare-execution （返回 typed data / 证书 / Guard 调用参数，不签名）
 *   get_execution_status      GET  /v1/jobs/:id + 链上回执核实（可选 RPC）
 * 返回内容一律 structuredContent + 文本摘要；上游错误 isError=true 并保留状态码，不吞错。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicClient, decodeEventLog, http, type Hex } from "viem";
import { VerifyClient } from "./client";
import { GUARD_ABI } from "./guardAbi";
import { registerV2Tools, TOOL_NAMES_V2 } from "./toolsV2";
import type { AgentWallet } from "./wallet";

export interface ServerDeps {
  client: VerifyClient;
  rpcUrl?: string;
  chainId?: number;
  /** agent-wallet 模式（CV-D08）；null/undefined = 关闭 */
  wallet?: AgentWallet | null;
}

export const TOOL_NAMES = [
  "list_supported_assets",
  "get_verification_policy",
  "prepare_verification",
  "purchase_verification",
  "get_verification",
  "prepare_guard_trade",
  "get_execution_status",
  ...TOOL_NAMES_V2,
] as const;

export { ADDR, ASSET_KEY, fromHttp, ok, type ToolResult } from "./toolUtil";
import { ADDR, ASSET_KEY, fromHttp, ok } from "./toolUtil";

export function createVerifyMcpServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "chaconne-verify", version: "0.1.0" });
  const c = deps.client;

  server.registerTool(
    "list_supported_assets",
    {
      title: "List supported assets",
      description: "Verified asset registry (chain + contract are the identity; symbols are display only). Returns registry version/hash and evidence mode (LIVE/FIXTURE).",
      inputSchema: {},
    },
    async () => fromHttp(await c.call("GET", "/v1/assets"), (b) => `${(b["assets"] as unknown[] | undefined)?.length ?? 0} assets, registry ${String(b["registryVersion"])}, evidence mode ${String(b["evidenceMode"])}`),
  );

  server.registerTool(
    "get_verification_policy",
    {
      title: "Get verification policies",
      description: "Full definitions and hashes of STRICT_LIVE / REFERENCE_CONTEXT / QUOTE_ONLY, service pricing and the re-verification entitlement. No policy is ever downgraded automatically.",
      inputSchema: {},
    },
    async () => fromHttp(await c.call("GET", "/v1/policies"), (b) => `${(b["policies"] as unknown[] | undefined)?.length ?? 0} policies; report price $${String((b["pricing"] as Record<string, unknown> | undefined)?.["reportPriceUsd"])}`),
  );

  server.registerTool(
    "prepare_verification",
    {
      title: "Create a verification task",
      description: "Creates a fixed-intent task and computes report v1 immediately. Does NOT pay and does NOT grant any trade permission. Idempotent per clientRequestId. Returns jobId, order state/price and the latest verdict.",
      inputSchema: {
        clientRequestId: z.string().min(1).max(128).describe("Idempotency key in your own namespace"),
        ownerAddress: ADDR.describe("Wallet that would fund the trade"),
        recipientAddress: ADDR.optional().describe("Defaults to ownerAddress"),
        executionChainId: z.number().int().positive().default(196),
        inputAssetKey: ASSET_KEY.describe("Stablecoin to spend"),
        outputAssetKey: ASSET_KEY.describe("Stock token to buy"),
        amountInRaw: z.string().regex(/^(0|[1-9]\d*)$/).describe("Input amount in smallest units"),
        policyId: z.enum(["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"]),
        policyVersion: z.string().default("1.1.0"),
        maxSlippageBps: z.number().int().min(1).max(300),
        maxPriceImpactBps: z.number().int().min(1).max(1000).nullable().default(null),
        maxReferenceDeviationBps: z.number().int().min(1).max(2000).nullable().default(null),
      },
    },
    async (a) => {
      const body = { ...a, recipientAddress: a.recipientAddress ?? a.ownerAddress, mode: "exactIn" };
      return fromHttp(await c.call("POST", "/v1/jobs", body), (b) => {
        const lr = b["latestReport"] as Record<string, unknown> | null;
        const order = b["order"] as Record<string, unknown>;
        return `job ${String(b["jobId"])} created; verdict ${String(lr?.["verdict"])}; order ${String(order?.["state"])} price $${String(order?.["priceUsd"])}`;
      });
    },
  );

  server.registerTool(
    "purchase_verification",
    {
      title: "Fetch (purchase) the report",
      description: "Fetches the paid report. Without `paymentSignature` an unpaid task returns the x402 challenge (status 402 + paymentRequired header) — the host wallet must produce the payment and call again. In agent-wallet mode the challenge is paid automatically from the user's agent wallet within AGENT_WALLET_MAX_SPEND_USD (see `autoPaid`). A paid or free report is returned directly; reading an already-paid report never charges again.",
      inputSchema: {
        jobId: z.string().min(1),
        paymentSignature: z.string().optional().describe("Base64 PAYMENT-SIGNATURE produced by the host's x402 client"),
        version: z.number().int().positive().optional(),
      },
    },
    async (a) => {
      const headers: Record<string, string> = {};
      if (a.paymentSignature) headers["payment-signature"] = a.paymentSignature;
      const q = a.version ? `?version=${a.version}` : "";
      return fromHttp(await c.call("GET", `/v1/jobs/${a.jobId}/report${q}`, undefined, headers), (b) => {
        const rep = b["report"] as Record<string, unknown> | undefined;
        return `report v${String(rep?.["reportVersion"])}: verdict ${String(rep?.["verdict"])}, comparison ${String(rep?.["comparisonStatus"])}, session ${String(rep?.["marketSession"])}, ${(b["evidence"] as unknown[] | undefined)?.length ?? 0} evidence records`;
      });
    },
  );

  server.registerTool(
    "get_verification",
    {
      title: "Get task status and report",
      description: "Task state (payment, report versions, entitlement, executions) plus the latest report if it is deliverable. Never initiates a payment.",
      inputSchema: { jobId: z.string().min(1) },
    },
    async (a) => {
      const job = await c.call("GET", `/v1/jobs/${a.jobId}`);
      if (job.status !== 200) return fromHttp(job, () => "");
      const rep = await c.call("GET", `/v1/jobs/${a.jobId}/report`);
      const jb = job.body as Record<string, unknown>;
      const data: Record<string, unknown> = { status: 200, job: jb, reportStatus: rep.status, report: rep.status === 200 ? rep.body : null, paymentRequired: rep.paymentRequired };
      const lr = jb["latestReport"] as Record<string, unknown> | null;
      return ok(`job ${a.jobId}: order ${String((jb["order"] as Record<string, unknown>)?.["state"])}, latest v${String(lr?.["version"])} ${String(lr?.["verdict"])}, executions ${(jb["executions"] as unknown[]).length}`, data);
    },
  );

  server.registerTool(
    "prepare_guard_trade",
    {
      title: "Prepare a Guard execution",
      description: "Re-verifies with fresh evidence (consumes one of the paid re-verification credits), and if eligible returns the EIP-712 TradeIntent typed data for the OWNER to sign, the service-signed VerificationCertificate, the exact approval (token, spender=Guard, amount) and the Guard call parameters. This tool never signs and never holds keys. A rejected re-verification is a delivered result and also consumes a credit.",
      inputSchema: { jobId: z.string().min(1), refreshKey: z.string().min(1).max(128).describe("Idempotency key: retrying with the same key returns the same attempt without consuming credit") },
    },
    async (a) =>
      fromHttp(await c.call("POST", `/v1/jobs/${a.jobId}/prepare-execution`, { refreshKey: a.refreshKey }), (b) => {
        const ex = b["execution"] as Record<string, unknown> | null;
        return ex
          ? `attempt ${String(b["attemptId"])} PREPARED (report v${String(b["reportVersion"])}); certificate valid until ${String(ex["validUntil"])}; ${String(b["refreshesRemaining"])} re-verification(s) left. Next: owner signs typedData, approves exact amount to Guard, sends execute().`
          : `attempt ${String(b["attemptId"])} ${String(b["state"])}: verdict ${String(b["verdict"])}; no certificate issued; ${String(b["refreshesRemaining"])} re-verification(s) left`;
      }),
  );

  const rpc = deps.rpcUrl ? createPublicClient({ transport: http(deps.rpcUrl) }) : null;
  server.registerTool(
    "get_execution_status",
    {
      title: "Get execution status",
      description: "Lists execution attempts for a task. If an attempt has a txHash and an RPC is configured, fetches the on-chain receipt and decodes the GuardedExecution event (spent / received / refunded). Submission ≠ fill: only a successful receipt with the event counts.",
      inputSchema: { jobId: z.string().min(1), attemptId: z.string().optional() },
    },
    async (a) => {
      const job = await c.call("GET", `/v1/jobs/${a.jobId}`);
      if (job.status !== 200) return fromHttp(job, () => "");
      const jb = job.body as Record<string, unknown>;
      const execs = (jb["executions"] as Array<{ attemptId: string; state: string; txHash: string | null; validUntil: string | null; reportVersion: number }>).filter((e) => !a.attemptId || e.attemptId === a.attemptId);
      const enriched = [];
      for (const e of execs) {
        let onchain: Record<string, unknown> | null = null;
        if (e.txHash && rpc) {
          try {
            const rcpt = await rpc.getTransactionReceipt({ hash: e.txHash as Hex });
            let event: Record<string, unknown> | null = null;
            for (const l of rcpt.logs) {
              try {
                const d = decodeEventLog({ abi: GUARD_ABI, data: l.data, topics: l.topics });
                if (d.eventName === "GuardedExecution") event = Object.fromEntries(Object.entries(d.args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
              } catch {
                /* other logs */
              }
            }
            onchain = { status: rcpt.status, blockNumber: rcpt.blockNumber.toString(), blockHash: rcpt.blockHash, gasUsed: rcpt.gasUsed.toString(), guardedExecution: event };
          } catch (err) {
            onchain = { status: "unknown", error: err instanceof Error ? err.message : String(err) };
          }
        }
        enriched.push({ ...e, onchain });
      }
      return ok(`${enriched.length} attempt(s): ${enriched.map((e) => `${e.attemptId}=${e.state}${e.onchain ? `/${String((e.onchain as Record<string, unknown>)["status"])}` : ""}`).join(", ")}`, { status: 200, jobId: a.jobId, executions: enriched });
    },
  );

  registerV2Tools(server, { client: c, wallet: deps.wallet ?? null, rpcUrl: deps.rpcUrl, chainId: deps.chainId ?? 196 });
  return server;
}
