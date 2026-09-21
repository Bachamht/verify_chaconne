"use client";
/** 开发者页（V-11，按 v5 重写）：A2MCP 200 契约、地址表、v1+v5 端点、MCP 工具、SDK、API key 说明、信任边界、回放入口。 */
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { Card } from "@/components/ui";

const SERVICE = process.env["NEXT_PUBLIC_PUBLIC_SERVICE_URL"] ?? "https://verify.chaconne.xyz";
const EXPLORER = process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "https://www.okx.com/web3/explorer/xlayer";
const ADDR = {
  guard: "0x02834e26bbd851eedb888bafba666bc0af72770c",
  planGuard: "0xE8517f296211F4b9175796bAAB47979FB14Fd2F0",
  signer: "0x757fdc93fd8db505529680b2c6c5364263f5e615",
};

const MCP_TOOLS: Array<[string, string[]]> = [
  ["v1 · verification", ["list_supported_assets", "get_verification_policy", "prepare_verification", "purchase_verification", "get_verification", "prepare_guard_trade", "get_execution_status"]],
  ["v2 · plan & simulate", ["plan_trade", "create_simulation", "get_products"]],
  ["v2 · mandate (one signature, many steps)", ["prepare_mandate", "register_mandate", "get_mandate", "pause_mandate", "resume_mandate", "cancel_mandate", "execute_next_step"]],
  ["v2 · evidence & share", ["get_evidence_bundle", "verify_evidence_bundle", "create_share_card"]],
];

function Tbl({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <tbody>
          {rows.map(([p, d]) => (
            <tr key={p} className="border-b border-neutral-800 last:border-0">
              <td className="mono whitespace-nowrap py-2 pr-4 align-top text-brand">{p}</td>
              <td className="py-2 text-neutral-300">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DevelopersPage() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const v1: Array<[string, string]> = [
    ["GET /v1/assets", zh ? "支持资产（链+合约主键、登记版本与哈希、是否可执行）" : "Supported assets (chain+contract key, registry version/hash, executionAllowed)"],
    ["GET /v1/policies", zh ? "三策略完整定义与哈希（v1.0.0 与 v1.1.0）" : "The three policies with definition hashes (v1.0.0 and v1.1.0)"],
    ["GET /v1/products", zh ? "商品目录：verify_once / plan / monitor_window / task_bundle，价格与交付定义" : "Products: verify_once / plan / monitor_window / task_bundle with price and delivery definition"],
    ["POST /v1/jobs", zh ? "创建固定意图任务，立即算出报告 v1；幂等键 clientRequestId" : "Create a fixed-intent task; report v1 computed immediately; idempotent by clientRequestId"],
    ["GET /v1/jobs/:id", zh ? "任务状态：付款 / 报告版本 / 额度 / 执行与链上回执" : "Task state: payment / report versions / entitlement / executions with server-verified receipts"],
    ["GET /v1/jobs/:id/report", zh ? "报告 + 证据（收费时未付款 402）" : "Report + evidence (402 when paid and unpaid)"],
    ["POST /v1/jobs/:id/prepare-execution", zh ? "再核验 → 新版本 + TradeIntent typed data + 证书签名 + Guard 调用参数（2 次 / 5 分钟）" : "Re-verify → new version + TradeIntent typed data + certificate + Guard call params (2 per 5 min)"],
    ["POST /v1/jobs/:id/submissions", zh ? "记录 tx hash（可附 intentSignature）；成交由链上回执核实" : "Record the tx hash (optional intentSignature); fill confirmed from the on-chain receipt"],
    ["GET /v1/jobs/:id/bundle · /bill", zh ? "证据包（含 bundleHash 与证明签名）· 账单（服务费 / 本金 / gas 分列）" : "Evidence bundle (bundleHash + attestation signature) · bill (fees / principal / gas)"],
  ];
  const v2: Array<[string, string]> = [
    ["POST /v1/plans · GET /v1/plans/:id", zh ? "规划：金额阶梯 × 资金币种 × 三策略对照，≤12 候选，给出推荐与下一步" : "Plan: amount ladder × funding currencies × three policies, ≤12 candidates, recommendation and next step"],
    ["POST /v1/plans/:id/jobs", zh ? "把某个候选转成核验任务（同一 requestHash 链）" : "Turn a candidate into a verification task (same requestHash chain)"],
    ["POST /v1/mandates", zh ? "登记已签名的 TradeMandate（一次签名：预算/单步/步数/资产集合/期限/策略哈希）" : "Register a signed TradeMandate (one signature: budget, per-step cap, steps, asset set, deadline, policy hashes)"],
    ["GET /v1/mandates/:id", zh ? "授权状态、已用预算、步数、评估时间线与变化说明" : "Authorization state, spent budget, steps, evaluation timeline and deltas"],
    ["POST /v1/mandates/:id/pause · resume · cancel", zh ? "链下暂停 / 继续 / 取消（取消建议同时链上 revokeMandate）" : "Off-chain pause / resume / cancel (cancel should be paired with on-chain revokeMandate)"],
    ["POST /v1/mandates/:id/prepare-step", zh ? "就绪时返回 MandateStep typed data + 步骤证书 + 路由 calldata；否则返回等待原因" : "When READY returns MandateStep typed data + step certificate + router calldata; otherwise the wait reason"],
    ["POST /v1/mandates/:id/steps/:n/submissions", zh ? "记录步骤 tx hash；核实器按 MandateStep 事件确认" : "Record the step tx hash; the verifier confirms via the MandateStep event"],
    ["GET /v1/mandates/:id/bundle · /bill", zh ? "授权计划的证据包与账单" : "Evidence bundle and bill of an authorized task"],
    ["POST /v1/simulations · GET /v1/simulations/:id", zh ? "模拟：真实数据跑规划与规则，不签证书不执行（免费）" : "Simulation: real data through planner and rules, no certificate, no execution (free)"],
    ["GET/PUT /v1/profiles/me · POST/GET /v1/templates", zh ? "角色（只影响文案）· 翻创模板（只含结构，不含金额/钱包）" : "Persona (copy only) · remix templates (structure only, never amounts/wallets)"],
    ["POST /v1/shares · GET /pub/reports[/:shareId]", zh ? "战报公开设置 · 公开读取（无需 key，金额可区间化，钱包恒隐藏）" : "Share settings · public read (no key; amounts can be ranged; wallet always hidden)"],
    ["POST /a2mcp/plan · POST /a2mcp/monitor · GET /a2mcp/monitor/:id", zh ? "第二个 A2MCP 服务「Plan & Monitor」（同一 200 契约）" : "Second A2MCP service “Plan & Monitor” (same 200 contract)"],
  ];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">{t("dev_h")}</h1>

      <Card title={zh ? "通过 OKX AI 使用（A2MCP）" : "Use through OKX AI (A2MCP)"}>
        <p className="text-sm text-neutral-300">{zh ? "服务：Chaconne Verify · StockProof Trade Verification（ASP #13803）。A2MCP 传输约定只用两个状态码：任何缺参数/参数错误都是 HTTP 200 + status: input_required（正文带缺失项、提示、schema 和示例）；成功是 HTTP 200 + status: delivered（一句话结论 + 完整报告）；收费阶段是 402 + PAYMENT-REQUIRED（x402 v2）。参数可以直接写符号和人类金额。" : "Service: Chaconne Verify · StockProof Trade Verification (ASP #13803). The A2MCP transport uses only two status codes: any missing/invalid input is HTTP 200 with status: input_required (missing fields, hints, schema and an example in the body); success is HTTP 200 with status: delivered (a one-line summary plus the full report); the paid phase is 402 + PAYMENT-REQUIRED (x402 v2). Symbols and human amounts are accepted directly."}</p>
        <pre className="mono mt-3 overflow-auto rounded-lg bg-neutral-950 p-3 text-xs">{`curl -X POST ${SERVICE}/a2mcp/verify -H "Content-Type: application/json" -d '{
  "ownerAddress": "0xYourWallet",
  "outputAssetKey": "AAPLx",      # or AAPL / NVDAx / NVDA / a 0x address
  "amount": "100",                # 100 USDG (human units); or amountInRaw
  "policyId": "REFERENCE_CONTEXT" # optional; STRICT_LIVE | REFERENCE_CONTEXT | QUOTE_ONLY
}'

# → 200 {"ok":true,"status":"delivered","summary":"ELIGIBLE under REFERENCE_CONTEXT: …","verdict":"eligible","jobId":"job_…","report":{…}}
# → 200 {"ok":false,"status":"input_required","missingParams":[…],"schema":{…},"example":{…}}   (never 4xx)
# → 402 + PAYMENT-REQUIRED header                                                       (paid phase)`}</pre>
        <p className="mt-2 text-xs text-neutral-500">{zh ? "GET 也可用（参数放 query）。同参数重复调用返回同一任务，不重复计费。" : "GET works too (params in the query string). Repeating the same parameters returns the same task; nothing is charged twice."}</p>
      </Card>

      <Card title={zh ? "地址（X Layer 主网 · chainId 196）" : "Addresses (X Layer mainnet · chainId 196)"}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <tbody>
              {[
                ["ChaconneVerifyGuard (v1, single trade)", ADDR.guard, true],
                ["ChaconneVerifyPlanGuard (v2, mandates)", ADDR.planGuard, true],
                [zh ? "证明签名者（attestation signer, epoch 1）" : "Attestation signer (epoch 1)", ADDR.signer, false],
              ].map(([label, addr, isContract]) => (
                <tr key={String(addr)} className="border-b border-neutral-800 last:border-0">
                  <td className="py-2 pr-4 align-top text-neutral-300">{label}</td>
                  <td className="mono py-2 align-top break-all">
                    {String(addr)}
                    <div className="mt-1 space-x-3 text-xs">
                      <a className="underline" href={`${EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer">OKX Explorer ↗</a>
                      {isContract ? <a className="underline" href={`https://sourcify.dev/server/v2/contract/196/${addr}`} target="_blank" rel="noreferrer">Sourcify ↗</a> : null}
                      <button className="underline" onClick={() => navigator.clipboard?.writeText(String(addr))}>{zh ? "复制" : "copy"}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-neutral-500">{zh ? "两个合约均 Sourcify 精确匹配；EIP-712 domain：ChaconneVerifyGuard v1 / ChaconneVerifyPlanGuard v1。当前 signer 与 epoch 也可从 GET /healthz 读取。" : "Both contracts are Sourcify exact matches; EIP-712 domains: ChaconneVerifyGuard v1 / ChaconneVerifyPlanGuard v1. The current signer and epoch are also exposed by GET /healthz."}</p>
      </Card>

      <Card title={zh ? "HTTP API · 核验（v1）" : "HTTP API · verification (v1)"}>
        <Tbl rows={v1} />
      </Card>
      <Card title={zh ? "HTTP API · 规划、授权计划、模拟、战报（v5）" : "HTTP API · plans, mandates, simulations, reports (v5)"}>
        <Tbl rows={v2} />
        <p className="mt-2 text-xs text-neutral-500">{zh ? "鉴权：x-api-key 或 Authorization: Bearer；A2MCP 端点与 /pub/* 不需要 key。响应 private/no-store。API key 在 Dev Day 期间联系运营者获取。" : "Auth: x-api-key or Authorization: Bearer; A2MCP endpoints and /pub/* need no key. Responses are private/no-store. During Dev Day, ask the operator for an API key."}</p>
      </Card>

      <Card title={zh ? "MCP 工具（verify-mcp，20 个）" : "MCP tools (verify-mcp, 20)"}>
        <div className="space-y-2 text-sm">
          {MCP_TOOLS.map(([group, names]) => (
            <div key={group}>
              <p className="text-xs uppercase tracking-wide text-neutral-500">{group}</p>
              <p className="mono break-words text-neutral-300 [overflow-wrap:anywhere]">{names.join(" · ")}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-500">{zh ? "stdio 传输；默认不持有任何私钥。可选 agent-wallet 模式（用户自己的 Agent 钱包，AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS 三者齐备才启用）：x402 自动付款带花费上限、代签 TradeMandate、执行步骤（发交易前读链上 stepIndex，预授权后再取证书）。" : "stdio transport; holds no private key by default. Optional agent-wallet mode (your own agent wallet; enabled only when AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS are all set): auto-pays x402 within a spend cap, signs TradeMandate, executes steps (reads the on-chain stepIndex before sending, pre-approves before fetching the certificate)."}</p>
        <pre className="mono mt-3 overflow-auto rounded-lg bg-neutral-950 p-3 text-xs">{`{ "mcpServers": { "chaconne-verify": {
    "command": "npx", "args": ["-y", "@chaconne/verify-mcp"],
    "env": { "VERIFY_SERVICE_URL": "${SERVICE}", "VERIFY_API_KEY": "<your key>" }
} } }`}</pre>
      </Card>

      <Card title="SDK (@chaconne/verify-sdk)">
        <pre className="mono overflow-auto rounded-lg bg-neutral-950 p-3 text-xs">{`import { createClient } from "@chaconne/verify-sdk";
const c = createClient({ baseUrl: "${SERVICE}", apiKey: process.env.VERIFY_API_KEY /*, x402Signer: account */ });

const job  = await c.jobs.create({ ownerAddress, inputAssetKey, outputAssetKey, amountInRaw: "5000000", policyId: "REFERENCE_CONTEXT", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, clientRequestId: "my-1" });
const rep  = await c.jobs.report(job.body.jobId);          // pays via x402 automatically when x402Signer is set
const plan = await c.plans.create({ /* PlanGoal + clientRequestId */ });
const m    = await c.mandates.create({ /* typedData + signature + legs … */ });
const step = await c.mandates.prepareStep(m.body.mandateId); // → executeStep on PlanGuard from your wallet
const bundle = await c.jobs.bundle(job.body.jobId);         // re-check offline with verify_evidence_bundle / npx verify-bundle`}</pre>
        <p className="mt-2 break-words text-xs text-neutral-500 [overflow-wrap:anywhere]">{zh ? "方法：assets · policies · products · healthz · jobs.{create,get,report,prepareExecution,submit,bundle,bill} · plans.{create,get,toJob} · mandates.{create,get,pause,resume,cancel,prepareStep,submitStep,bundle,bill} · simulations · profiles · templates · shares.{create,getPublic} · a2mcp.{verify,plan}。" : "Methods: assets · policies · products · healthz · jobs.{create,get,report,prepareExecution,submit,bundle,bill} · plans.{create,get,toJob} · mandates.{create,get,pause,resume,cancel,prepareStep,submitStep,bundle,bill} · simulations · profiles · templates · shares.{create,getPublic} · a2mcp.{verify,plan}."}</p>
      </Card>

      <Card title={zh ? "信任边界（如实）" : "Trust boundary (stated plainly)"}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-300">
          <li>{zh ? "服务持有一把只签证明（VerificationCertificate / StepCertificate / bundleHash）的私钥；不持有用户资金私钥，不代签付款或交易，不做 relayer。" : "The service holds one attestation key that signs only certificates (VerificationCertificate / StepCertificate / bundleHash); it never holds user fund keys, never signs payments or trades, and runs no relayer."}</li>
          <li>{zh ? "Guard / PlanGuard 强制金额、最小到账、收款人、路由/选择器白名单、期限、nonce 与步序；它们不知道链下股票参考是否正确——这是证明服务的判断，通过 evidenceHash 绑定，任何人可用证据包离线复核。" : "Guard / PlanGuard enforce amount, minimum output, recipient, route/selector allowlists, deadline, nonce and step order; they cannot know whether off-chain stock data was correct — that judgement is the attestation service's, bound by evidenceHash and re-checkable offline from the evidence bundle."}</li>
          <li>{zh ? "证明最长 60 秒，且不得比它依据的报价更久（通常约 30 秒）。管理员可暂停、轮换签名身份、改白名单；不能动用户资金。" : "A certificate lives at most 60 s and never longer than the quote it rests on (usually about 30 s). Admin can pause, rotate the signer and edit allowlists; it cannot move user funds."}</li>
          <li>{zh ? "证据里 kind=pyth_reference 是历史命名（CV-D01 泛化为「实时参考 tick」），provider 字段标明真实来源（finnhub）。" : "The evidence kind pyth_reference is a legacy name (generalized to “live reference tick” under CV-D01); the provider field states the real source (finnhub)."}</li>
        </ul>
        <p className="mt-3 text-sm"><Link className="underline" href="/replay/AAPLx">{t("replay_h")} →</Link> · <Link className="underline" href="/verify-bundle">{t("nav_verify_bundle")} →</Link></p>
      </Card>
    </div>
  );
}
