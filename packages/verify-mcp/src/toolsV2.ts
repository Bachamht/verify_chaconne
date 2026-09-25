/**
 * v2 工具（升级执行计划 v5 §3.5）：规划 / 模拟 / 商品 / 授权计划 / 步骤执行 / 证据包 / 战报。
 * 只有 execute_next_step 与 register_mandate(signLocally) 会用到 agent-wallet；其它工具与 v1 一样不签名不付款。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import { EIP712_TYPES_V2, makePlanGuardDomain, mandateDigest, outputSetHash, parseAssetKey, stepDigest, type EvidenceBundle, type MandateStep, type StepCertificate, type TradeMandate } from "@chaconne/core/verify";
import type { VerifyClient } from "./client";
import { verifyBundle } from "./bundleVerify";
import { ADDR, ASSET_KEY, fail, fromHttp, HEX32, ok, UINT, type ToolResult } from "./toolUtil";
import { normalizeOutputSet } from "./planGuardAbi";
import { AgentWalletError, type AgentWallet } from "./wallet";
import type { ExecutorHeartbeat } from "./heartbeat";

export const TOOL_NAMES_V2 = [
  "plan_trade",
  "create_simulation",
  "get_products",
  "prepare_mandate",
  "register_mandate",
  "get_mandate",
  "pause_mandate",
  "resume_mandate",
  "cancel_mandate",
  "execute_next_step",
  "get_evidence_bundle",
  "verify_evidence_bundle",
  "create_share_card",
] as const;

export interface V2Deps {
  client: VerifyClient;
  wallet: AgentWallet | null;
  rpcUrl?: string;
  chainId: number;
  /** v6：执行成功后把 mandate 加入 60 s 心跳循环（agent-wallet 模式） */
  heartbeat?: ExecutorHeartbeat | null;
}

const POLICY = z.enum(["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"]);
const GOAL = {
  ownerAddress: ADDR,
  recipientAddress: ADDR.optional(),
  executionChainId: z.number().int().positive().default(196),
  legs: z.array(z.object({ outputAssetKey: ASSET_KEY, weightBps: z.number().int().min(1).max(10000) })).min(1).max(4),
  budget: z.object({ inputAssetKeys: z.array(ASSET_KEY).min(1), amountInRaw: UINT }),
  side: z.enum(["buy", "sell"]).default("buy"),
  policyId: POLICY,
  policyVersion: z.string().default("1.1.0"),
  maxSlippageBps: z.number().int().min(1).max(300),
  maxPriceImpactBps: z.number().int().min(1).max(1000).nullable().default(null),
  maxReferenceDeviationBps: z.number().int().min(1).max(2000).nullable().optional(),
  deadline: z.string().describe("ISO time after which the goal is void"),
  ladderBps: z.array(z.number().int().min(1).max(10000)).optional(),
};

const TYPED = z.object({ domain: z.record(z.string(), z.unknown()), types: z.record(z.string(), z.unknown()), primaryType: z.string(), message: z.record(z.string(), z.unknown()) });

function walletDisabled(): ToolResult {
  return fail("agent_wallet_disabled", "This tool needs agent-wallet mode: set AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS in the MCP server's own .env (your wallet, client side). The service never holds this key.");
}

const randomNonce = () => BigInt("0x" + randomBytes(16).toString("hex")).toString();

export function registerV2Tools(server: McpServer, d: V2Deps): void {
  const c = d.client;

  server.registerTool(
    "plan_trade",
    {
      title: "Plan a trade (candidates, not a promise)",
      description: "Creates a planning task: for the goal (asset legs, budget in one or more stablecoins, side, policy, limits) the service quotes an amount ladder and scores each candidate under all three policies. Returns candidates with completion ratio, blocking reasons and a next step; `recommended` is only ever an eligible candidate. Never executes. Paid SKU `plan` (free during listing review).",
      inputSchema: { clientRequestId: z.string().min(1).max(128), ...GOAL },
    },
    async (a) => fromHttp(await c.call("POST", "/v1/plans", { ...a, recipientAddress: a.recipientAddress ?? a.ownerAddress }), (b) => {
      const plan = (b["plan"] ?? b) as Record<string, unknown>;
      const cands = (plan["candidates"] as unknown[] | undefined)?.length ?? 0;
      return `plan ${String(b["planId"] ?? plan["planId"])}: ${cands} candidate(s); recommended ${String(plan["recommended"] ?? "none")}`;
    }),
  );

  server.registerTool(
    "create_simulation",
    {
      title: "Run a simulation (no money, no signatures)",
      description: "Runs planning + rules on LIVE evidence without issuing any certificate or execution. Free. Output is labelled SIMULATION. Use it to try a goal before spending anything.",
      inputSchema: { clientRequestId: z.string().min(1).max(128), ...GOAL, personaId: z.enum(["turtle_drummer", "cat_conductor", "ox_bassist"]).optional() },
    },
    async (a) => fromHttp(await c.call("POST", "/v1/simulations", { ...a, recipientAddress: a.recipientAddress ?? a.ownerAddress }), (b) => `simulation ${String(b["simulationId"])}: verdict ${String(b["verdict"] ?? "n/a")} (SIMULATION, nothing signed or executed)`),
  );

  server.registerTool(
    "get_products",
    { title: "Product catalogue", description: "SKUs (verify_once / plan / monitor_window / task_bundle), prices, validity, what is delivered and what 'no viable candidate' means for each.", inputSchema: {} },
    async () => fromHttp(await c.call("GET", "/v1/products"), (b) => `${(b["products"] as unknown[] | undefined)?.length ?? 0} product(s)`),
  );

  server.registerTool(
    "prepare_mandate",
    {
      title: "Prepare a TradeMandate to sign",
      description: "Builds the EIP-712 TradeMandate typed data (PlanGuard domain) from the goal: budget cap, per-step cap, max steps, allowed output set, policy/registry hashes, validity window, a fresh nonce. Returns typedData for the OWNER to sign (wallet or agent-wallet). Nothing is sent to the service.",
      inputSchema: {
        ownerAddress: ADDR,
        recipientAddress: ADDR.optional(),
        chainId: z.number().int().positive().default(196),
        planGuard: ADDR.describe("PlanGuard contract address (from deployments.json / GET /v1/policies)"),
        inputAssetKey: ASSET_KEY.describe("buy: stablecoin; sell: stock token"),
        outputAssetKeys: z.array(ASSET_KEY).min(1).max(8),
        budgetCap: UINT,
        perStepCap: UINT,
        maxSteps: z.number().int().min(1).max(1000),
        policyDefinitionHash: HEX32,
        effectivePolicyHash: HEX32,
        registryHash: HEX32,
        validFrom: z.number().int().nonnegative().optional().describe("unix seconds; default now"),
        deadline: z.number().int().positive().describe("unix seconds"),
        nonce: UINT.optional().describe("default: random 128-bit"),
      },
    },
    async (a) => {
      const inTok = parseAssetKey(a.inputAssetKey);
      const outs = a.outputAssetKeys.map((k) => parseAssetKey(k));
      if (!inTok || outs.some((o) => !o)) return fail("bad_asset_key", "asset keys must be eip155:<chainId>:<address>");
      if (BigInt(a.perStepCap) > BigInt(a.budgetCap)) return fail("per_step_exceeds_budget", "perStepCap must be ≤ budgetCap");
      const outputSet = normalizeOutputSet(outs.map((o) => o!.address));
      const message: TradeMandate = {
        owner: a.ownerAddress.toLowerCase() as Hex,
        recipient: (a.recipientAddress ?? a.ownerAddress).toLowerCase() as Hex,
        inputToken: inTok.address,
        outputSetHash: outputSetHash(outputSet),
        budgetCap: a.budgetCap,
        perStepCap: a.perStepCap,
        maxSteps: String(a.maxSteps),
        policyDefinitionHash: a.policyDefinitionHash as Hex,
        effectivePolicyHash: a.effectivePolicyHash as Hex,
        registryHash: a.registryHash as Hex,
        validFrom: String(a.validFrom ?? Math.floor(Date.now() / 1000)),
        deadline: String(a.deadline),
        nonce: a.nonce ?? randomNonce(),
      };
      const domain = makePlanGuardDomain(a.chainId, a.planGuard as Hex);
      const digest = mandateDigest(domain, message);
      return ok(`TradeMandate ready to sign: budget ${a.budgetCap}, per step ${a.perStepCap}, ${a.maxSteps} step(s), ${outputSet.length} output token(s); digest ${digest.slice(0, 18)}…`, {
        typedData: { domain, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message },
        outputSet,
        mandateDigest: digest,
        agentWalletCanSign: !!d.wallet && d.wallet.address.toLowerCase() === message.owner,
      });
    },
  );

  server.registerTool(
    "register_mandate",
    {
      title: "Register a signed TradeMandate",
      description: "Submits the signed TradeMandate to the service (POST /v1/mandates), which verifies the signature, registry and policy hashes and starts monitoring. Provide `signature`, or set `signLocally=true` in agent-wallet mode when the agent wallet IS the owner. Paid SKU task_bundle / monitor_window.",
      inputSchema: { typedData: TYPED, signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(), signLocally: z.boolean().default(false), planId: z.string().optional(), jobId: z.string().optional(), clientRequestId: z.string().optional(), sku: z.enum(["task_bundle", "monitor_window"]).optional() },
    },
    async (a) => {
      let signature = a.signature as Hex | undefined;
      if (!signature && a.signLocally) {
        if (!d.wallet) return walletDisabled();
        const owner = String(a.typedData.message["owner"] ?? "").toLowerCase();
        if (owner !== d.wallet.address.toLowerCase()) return fail("owner_mismatch", `agent wallet ${d.wallet.address} is not the mandate owner ${owner}`);
        signature = await d.wallet.signTypedData(a.typedData);
      }
      if (!signature) return fail("signature_required", "provide `signature` or `signLocally=true` (agent-wallet mode, owner = agent wallet)");
      return fromHttp(await c.call("POST", "/v1/mandates", { typedData: a.typedData, signature, planId: a.planId, jobId: a.jobId, clientRequestId: a.clientRequestId, sku: a.sku }), (b) => `mandate ${String(b["mandateId"])} ${String(b["state"])}`);
    },
  );

  server.registerTool("get_mandate", { title: "Get mandate status", description: "State, budget spent/remaining, steps done/max, latest evaluation and what changed (delta).", inputSchema: { mandateId: z.string().min(1) } }, async (a) => fromHttp(await c.call("GET", `/v1/mandates/${a.mandateId}`), (b) => `mandate ${a.mandateId}: ${String(b["state"])}, spent ${String(b["spent"])}, steps ${String(b["stepsDone"])}/${String(b["maxSteps"])}`));
  for (const action of ["pause", "resume", "cancel"] as const) {
    server.registerTool(`${action}_mandate`, { title: `${action[0]!.toUpperCase()}${action.slice(1)} mandate`, description: action === "cancel" ? "Cancels off-chain monitoring (no more step certificates). For a hard stop also call revokeMandate on PlanGuard from the owner wallet." : `${action}s off-chain monitoring; ${action === "pause" ? "no step certificates are issued while paused" : "monitoring continues"}.`, inputSchema: { mandateId: z.string().min(1) } }, async (a) => fromHttp(await c.call("POST", `/v1/mandates/${a.mandateId}/${action}`), (b) => `mandate ${a.mandateId} → ${String(b["state"] ?? action)}`));
  }

  server.registerTool(
    "execute_next_step",
    {
      title: "Execute the next mandate step (agent-wallet mode)",
      description: "Asks the service to prepare the next step (fresh re-verification + step certificate). If READY, checks the step against the registered mandate and local limits (mandate digest, step index, per-step cap, validity, output set, chain allowlist), reads PlanGuard.mandateState and refuses unless the on-chain step counter equals the step index, pre-approves perStepCap of the input token to PlanGuard BEFORE prepare-step (agent wallet = owner; the step certificate lives ~30 s) or verifies the owner's allowance (third-party executor), sends executeStep with estimateGas×1.3, waits for the receipt (MandateStep event, allowance back to 0) and reports the tx hash to the service. Anyone may execute a valid step; output always goes to the mandate recipient. Refuses without agent-wallet mode.",
      inputSchema: { mandateId: z.string().min(1), mandate: TYPED.describe("the registered TradeMandate typedData (as signed)"), mandateSignature: z.string().regex(/^0x[0-9a-fA-F]+$/), outputSet: z.array(ADDR).min(1).describe("sorted unique output tokens the mandate allows"), expectedStepIndex: z.number().int().nonnegative().optional(), dryRun: z.boolean().default(false) },
    },
    async (a) => {
      if (!d.wallet) return walletDisabled();
      // 预授权在 prepare-step 之前：步骤证书只有 ~30 s（受报价时效约束），prepare 之后再 approve 会把证书耗到过期（I2 2026-09-21）
      // 尽力而为：失败不在此中止（后续本地核对/sendStep 仍会检查并给出准确错误），只记录到 preApprove
      let preApprove: { approveTxHash: Hex | null; allowance: string; error?: string } | null = null;
      {
        const mm = a.mandate.message as Record<string, string>;
        const chainIdPre = Number((a.mandate.domain as { chainId?: number })["chainId"] ?? d.chainId);
        const planGuardPre = (a.mandate.domain as { verifyingContract?: string })["verifyingContract"] as Hex | undefined;
        if (!a.dryRun && planGuardPre && mm["inputToken"] && mm["owner"] && mm["perStepCap"] && d.wallet.allowsChain(chainIdPre) && mm["owner"].toLowerCase() === d.wallet.address.toLowerCase()) {
          try {
            const r = await d.wallet.ensureAllowance({ chainId: chainIdPre, token: mm["inputToken"] as Hex, owner: mm["owner"] as Hex, spender: planGuardPre, minAmount: BigInt(mm["perStepCap"]) });
            preApprove = { approveTxHash: r.approveTxHash, allowance: r.allowance.toString() };
          } catch (e) {
            preApprove = { approveTxHash: null, allowance: "unknown", error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
          }
        }
      }
      const prep = await c.call<Record<string, unknown>>("POST", `/v1/mandates/${a.mandateId}/prepare-step`);
      if (prep.status !== 200) return fromHttp(prep, () => "");
      return executePreparedStep(d, c, prep.body, { mandateId: a.mandateId, mandate: a.mandate, mandateSignature: a.mandateSignature, outputSet: a.outputSet, expectedStepIndex: a.expectedStepIndex, dryRun: a.dryRun }, preApprove);
    },
  );

  server.registerTool(
    "get_evidence_bundle",
    { title: "Export the evidence bundle", description: "Downloads the portable evidence bundle (evidence, reports, plans, certificates, mandate/steps, executions, bill, bundleHash + attestation signature) for a job or a mandate. Verify it offline with verify_evidence_bundle or the `verify-bundle` CLI.", inputSchema: { kind: z.enum(["job", "mandate"]), id: z.string().min(1) } },
    async (a) => fromHttp(await c.call("GET", `/v1/${a.kind === "job" ? "jobs" : "mandates"}/${a.id}/bundle`), (b) => `bundle ${String(b["kind"])} ${String(b["id"])}: ${(b["evidence"] as unknown[] | undefined)?.length ?? 0} evidence, ${(b["reports"] as unknown[] | undefined)?.length ?? 0} report(s), bundleHash ${String(b["bundleHash"]).slice(0, 18)}…`),
  );

  server.registerTool(
    "verify_evidence_bundle",
    { title: "Verify an evidence bundle offline", description: "Recomputes bundleHash, registry/policy/evidence/plan hashes and every EIP-712 digest, verifies certificate/intent/mandate/step signatures, re-runs the rule engine on the bundled evidence (bundle.job) and, if `online=true`, compares on-chain receipts with the bundled summaries. Works without the service. Returns a checklist; any failed item names the tampered layer.", inputSchema: { bundle: z.record(z.string(), z.unknown()), expectedSigner: ADDR.optional(), online: z.boolean().default(false) } },
    async (a) => {
      const r = await verifyBundle(a.bundle as unknown as EvidenceBundle, { ...(a.expectedSigner ? { expectedSigner: a.expectedSigner as Hex } : {}), ...(a.online && d.rpcUrl ? { rpcUrl: d.rpcUrl } : {}) });
      return { content: [{ type: "text", text: `${r.ok ? "VALID" : "INVALID"}: ${r.summary.passed}/${r.summary.total} checks passed${r.ok ? "" : `; failed: ${r.checks.filter((x) => !x.ok).map((x) => x.id).join(", ")} (layers: ${r.failedLayers.join(", ")})`}` }], structuredContent: { ...r }, isError: false };
    },
  );

  server.registerTool(
    "create_share_card",
    { title: "Create a share card (battle report)", description: "Creates a shareable report page for a job/mandate/simulation. Private by default; when public, amounts can be shown exact, as a range, or hidden; wallet is always hidden.", inputSchema: { kind: z.enum(["job", "mandate", "simulation"]), id: z.string().min(1), public: z.boolean().default(false), amounts: z.enum(["exact", "range", "hidden"]).default("range"), title: z.string().max(120).optional() } },
    async (a) => fromHttp(await c.call("POST", "/v1/shares", { kind: a.kind, refId: a.id, public: a.public, privacy: { amounts: a.amounts, wallet: "hidden" }, title: a.title }), (b) => `share ${String(b["shareId"])} (${a.public ? "public" : "private"}) ${String(b["url"] ?? "")}`),
  );
}

/** 已签发的 READY 步骤（prepare-step 或 CV-D16 交易意图的 READY 体）→ 本地核对 → 链上步序 → 发送 → 回报（execute_next_step 与 execute_trade_intent 共用） */
export async function executePreparedStep(d: { wallet: AgentWallet | null | undefined; chainId: number; heartbeat?: ExecutorHeartbeat | null }, c: VerifyClient, p: Record<string, unknown>, a: { mandateId: string; mandate: { domain: Record<string, unknown>; message: Record<string, unknown> }; mandateSignature: string; outputSet: string[]; expectedStepIndex?: number; dryRun: boolean }, preApprove: { approveTxHash: Hex | null; allowance: string; error?: string } | null): Promise<ToolResult> {
  if (!d.wallet) return walletDisabled();
    if (p["status"] !== "READY") return ok(`not ready: ${String(p["status"])}${p["reasons"] ? ` (${JSON.stringify(p["reasons"]).slice(0, 300)})` : ""}`, { status: 200, ...p, executed: false });
    const step = (p["step"] ?? (p["typedData"] as { message?: unknown } | undefined)?.message) as MandateStep | undefined;
    const cert = p["certificate"] as StepCertificate | undefined;
    const certSig = p["certificateSignature"] as Hex | undefined;
    const calldata = p["routerCalldata"] as Hex | undefined;
    const planGuard = (p["planGuard"] ?? (a.mandate.domain as { verifyingContract?: string })["verifyingContract"]) as Hex | undefined;
    let outputSet: Hex[];
    try {
      outputSet = normalizeOutputSet((p["outputSet"] as string[] | undefined) ?? a.outputSet);
    } catch (e) {
      return fail("bad_output_set", e instanceof Error ? e.message : String(e));
    }
    if (!step || !cert || !certSig || !calldata || !planGuard) return fail("prepare_step_incomplete", "service response lacks step/certificate/calldata/planGuard", { response: p });
    const chainId = Number((a.mandate.domain as { chainId?: number })["chainId"] ?? d.chainId);
    const domain = makePlanGuardDomain(chainId, planGuard);
    const md = mandateDigest(domain, a.mandate.message as unknown as TradeMandate);
    const problems: string[] = [];
    if (step.mandateDigest.toLowerCase() !== md.toLowerCase()) problems.push("step.mandateDigest ≠ local mandate digest");
    if (a.expectedStepIndex !== undefined && Number(step.stepIndex) !== a.expectedStepIndex) problems.push(`stepIndex ${step.stepIndex} ≠ expected ${a.expectedStepIndex}`);
    const m = a.mandate.message as Record<string, string>;
    if (BigInt(step.amountIn) > BigInt(m["perStepCap"]!)) problems.push("amountIn > perStepCap");
    if (BigInt(step.minAmountOut) <= 0n) problems.push("minAmountOut must be > 0");
    const now = Math.floor(Date.now() / 1000);
    if (Number(cert.validUntil) <= now) problems.push("certificate already expired");
    if (Number(step.deadline) <= now) problems.push("step deadline already passed");
    if (outputSetHash(outputSet) !== m["outputSetHash"]) problems.push("outputSet hash ≠ mandate.outputSetHash");
    if (!outputSet.includes(step.outputToken.toLowerCase() as Hex)) problems.push("step.outputToken not in outputSet");
    const sd = stepDigest(domain, step);
    if (sd.toLowerCase() !== cert.stepDigest.toLowerCase()) problems.push("certificate.stepDigest ≠ recomputed step digest");
    if (!d.wallet.allowsChain(chainId)) problems.push(`chain ${chainId} not allowed by AGENT_WALLET_CHAIN_IDS`);
    if (problems.length) return fail("step_rejected_locally", problems.join("; "), { step, certificate: cert, executed: false });
    // 链上步序：s.stepIndex 必须等于 mandateState(digest).steps（防止服务端与链上不同步导致 StepOutOfOrder / 重复执行）
    let onchain: { steps: number; spent: string; revoked: boolean } | null = null;
    try {
      onchain = await d.wallet.reader.mandateSteps(chainId, planGuard, md);
    } catch (e) {
      return fail("chain_read_failed", `cannot read mandateState from PlanGuard ${planGuard}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, { executed: false });
    }
    if (onchain.revoked) return fail("mandate_revoked_onchain", "mandate is revoked on PlanGuard", { onchain, executed: false });
    if (onchain.steps !== Number(step.stepIndex)) return fail("step_index_onchain_mismatch", `service step ${step.stepIndex} but PlanGuard expects ${onchain.steps} (spent ${onchain.spent}); refusing to send`, { onchain, executed: false });
    if (a.dryRun) return ok(`dry run: step ${step.stepIndex} passes local + on-chain checks (amountIn ${step.amountIn}, minOut ${step.minAmountOut}); not sent`, { status: 200, executed: false, step, stepDigest: sd, certificate: cert, planGuard, chainId, onchain });
    try {
      const sent = await d.wallet.sendStep({ chainId, planGuard, mandate: m, mandateSignature: a.mandateSignature as Hex, outputSet, step: step as unknown as Record<string, string>, certificate: cert as unknown as Record<string, string>, certificateSignature: certSig, routerCalldata: calldata });
      const sub = await c.call("POST", `/v1/mandates/${a.mandateId}/steps/${step.stepIndex}/submissions`, { txHash: sent.txHash });
      d.heartbeat?.watch(a.mandateId);
      const ev = sent.receipt?.event ?? null;
      return ok(`step ${step.stepIndex} sent: ${sent.txHash}${sent.receipt ? ` → ${sent.receipt.status}${ev ? ` spent ${String(ev["spent"])} received ${String(ev["received"])} refunded ${String(ev["refunded"])}` : ""}; allowance after ${sent.receipt.allowanceAfter}` : " (receipt pending; service verifier will confirm)"} (submission ${sub.status}); executor ${d.wallet.address}`, { status: 200, executed: true, txHash: sent.txHash, approveTxHash: sent.approveTxHash ?? preApprove?.approveTxHash ?? null, preApprove, gas: sent.gas ?? null, receipt: sent.receipt ?? null, stepIndex: step.stepIndex, stepDigest: sd, submission: sub.body as Record<string, unknown>, executor: d.wallet.address, onchainBefore: onchain });
    } catch (e) {
      if (e instanceof AgentWalletError) return fail(e.code, e.message, { executed: false });
      return fail("send_failed", e instanceof Error ? e.message : String(e), { executed: false });
    }
}
