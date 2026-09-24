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
  ["v6 · context & events", ["get_market_context", "get_events", "get_my_event_impacts"]],
  ["v6 · tasks (playbooks + conditions)", ["create_task", "get_task", "pause_task", "resume_task", "cancel_task", "authorize_task", "explain_task_wait", "compare_task_policies", "replay_policy"]],
  ["v6 · thesis, budget, portfolio, rebalance", ["watch_thesis", "add_thesis_review_item", "get_budget_group", "create_budget_group", "get_portfolio", "report_cost_override", "preview_rebalance", "create_rebalance_plan"]],
  ["v6 · notifications & executor", ["register_webhook", "link_telegram", "executor_heartbeat"]],
  ["free · no key (read-only)", ["verify_once_free", "plan_free", "agent_tasks_free"]],
];

/** V-45：路径列可换行（此前 whitespace-nowrap 把长路径截断）、说明列必填、表格可横向滚动 */
function Tbl({ rows, zh }: { rows: Array<[string, string]>; zh: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead><tr className="text-xs text-fg-3"><th className="w-[42%] py-1 pr-4 font-medium">{zh ? "端点" : "Endpoint"}</th><th className="py-1 font-medium">{zh ? "说明" : "What it does"}</th></tr></thead>
        <tbody>
          {rows.map(([p, d]) => (
            <tr key={p} className="border-b border-line last:border-0 align-top">
              <td className="mono break-words py-2 pr-4 text-brand [overflow-wrap:anywhere]">{p}</td>
              <td className="py-2 text-neutral-300">{d || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTIONS: Array<{ id: string; zh: string; en: string }> = [
  { id: "free", zh: "免 key 接入", en: "No-key access" },
  { id: "a2mcp", zh: "A2MCP（OKX AI）", en: "A2MCP (OKX AI)" },
  { id: "addresses", zh: "合约地址", en: "Addresses" },
  { id: "v1", zh: "REST · 核验 v1", en: "REST · verification v1" },
  { id: "v5", zh: "REST · 规划 / 授权 v5", en: "REST · plans / mandates v5" },
  { id: "v6", zh: "REST · Agent v6", en: "REST · agent v6" },
  { id: "mcp", zh: "MCP 工具", en: "MCP tools" },
  { id: "sdk", zh: "SDK", en: "SDK" },
  { id: "trust", zh: "信任边界", en: "Trust boundary" },
];

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
    ["GET/PUT /v1/profiles/me · POST/GET /v1/templates", zh ? "角色（只影响文案）· 复用模板（只含结构，不含金额/钱包）" : "Persona (copy only) · remix templates (structure only, never amounts/wallets)"],
    ["POST /v1/shares · GET /pub/reports[/:shareId]", zh ? "战报公开设置 · 公开读取（无需 key，金额可区间化，钱包恒隐藏）" : "Share settings · public read (no key; amounts can be ranged; wallet always hidden)"],
    ["POST /a2mcp/plan · POST /a2mcp/monitor · GET /a2mcp/monitor/:id", zh ? "第二个 A2MCP 服务「Plan & Monitor」（同一 200 契约）" : "Second A2MCP service “Plan & Monitor” (same 200 contract)"],
  ];
  const v6: Array<[string, string]> = [
    ["GET /v1/context?tier=agent&assetKey&owner&taskId", zh ? "免费档市场上下文（crowsnest 签名导出）：时段、交易日/假日/提前收盘、宏观与联储事件、静默期、曲线形态、漂移判定。每个字段 {value, source, observedAt, fetchedAt, status}；数值 value 是十进制字符串；不在档位的字段整个标 unavailable/not_in_tier 而不省略；provenance.mode 非 live 时不得当实时。永远 200。" : "Free-tier market context (signed crowsnest export): session, trading day / holiday / early close, macro & Fed events, blackout, curve shape, drift verdict. Every field is {value, source, observedAt, fetchedAt, status}; numeric values are decimal strings; fields outside the tier are unavailable/not_in_tier, never omitted; provenance.mode other than live must not be treated as live. Always 200."],
    ["GET /v1/events · GET /v1/events/:id/revisions", zh ? "事件列表（稳定 id、日期精度、确认/估计/修订、修订号）与修订史；窗口由每个任务自己按条件算" : "Event list (stable id, date precision, confirmed/estimated/revised, revision) and revision history; each task computes its own window"],
    ["POST /v1/tasks · GET /v1/tasks/:id · GET /v1/tasks?owner", zh ? "从模板 + 条件建任务：返回任务（阻塞项全量、nextCheckAt、执行器三态）、待签 TradeMandate 草案、理由卡草案、资金组分配" : "Create a task from a playbook + conditions: task (all blockers, nextCheckAt, executor presence), TradeMandate draft, thesis draft, budget allocation"],
    ["POST /v1/tasks/:id/pause · resume · cancel", zh ? "服务侧停止：只阻止后续签发；已取走且未过期的证书仍可能可执行；彻底停止以链上 revokeMandate 确认为准（D-088）" : "Service-side stop: blocks new certificates only; a pulled, unexpired certificate may still execute; hard stop = on-chain revokeMandate confirmation (D-088)"],
    ["POST /v1/tasks/:id/authorize · prepare-step · GET explain-wait · POST compare-policies", zh ? "提交已签授权；条件前置链评估；等待诊断；同快照对照（SIMULATION）" : "Submit the signed mandate; condition-gated step preparation; wait diagnosis; same-snapshot comparison (SIMULATION)"],
    ["POST /v1/mandates/:id/executor/heartbeat", zh ? "agent-wallet 执行器心跳（60 s）→ executorPresence=online；不携带任何权限" : "Agent-wallet executor heartbeat (60 s) → executorPresence=online; carries no permission"],
    ["GET /v1/event-impacts?owner&horizonHours · POST /v1/theses · /v1/budget-groups · GET /v1/portfolio/:owner · /v1/notify/* · /v1/replays · /v1/rebalance/*", zh ? "影响清单、理由卡、资金组、组合与成本覆盖、通知（webhook HMAC / Telegram）、无前视回放、调仓编排" : "Impacts, thesis cards, budget groups, portfolio with cost coverage, notifications (HMAC webhooks / Telegram), no-look-ahead replays, rebalance orchestration"],
    ["GET /v1/recaps?owner&date · GET /v1/recaps/:id · POST /v1/recaps/:id/share · GET /pub/recaps/:shareId", zh ? "夜班日志：纽约实际收盘后 45 分钟生成；账目与时间线可复算；模拟/回放/真实标识；默认私密，公开可隐藏资产与金额" : "Night journal: generated 45 min after the actual NY close; ledger reconciles with the timeline; simulation/replay/live labels; private by default, public view can hide assets and amounts"],
    ["POST /a2mcp/agent-tasks", zh ? "第三个 A2MCP 服务「Agent Tasks」草稿：owner 或资产集合 → 事件影响 + 任务草案；审核期价格 0；等 #13803 结果后再提交上架" : "Third A2MCP service “Agent Tasks” (draft): owner and/or assets → event impacts + task drafts; price 0 during review; submitted only after #13803 concludes"],
  ];
  return (
    <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-6">
      <aside className="mb-4 lg:sticky lg:top-24 lg:mb-0 lg:self-start">
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "目录" : "Contents"}</p>
        <nav className="mt-2 flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5" aria-label={zh ? "开发者页目录" : "Developers page contents"}>
          {SECTIONS.map((x) => <a key={x.id} href={`#${x.id}`} className="rounded-md px-2 py-1 text-xs text-fg-2 ring-1 ring-line hover:bg-surface-2 hover:text-fg-1 lg:ring-0">{zh ? x.zh : x.en}</a>)}
        </nav>
        <p className="mt-3 hidden text-[11px] text-fg-3 lg:block">{zh ? "免 key：/v1/context · /v1/assets · /v1/policies · /a2mcp/* · /pub/* · /openapi.json · /llms.txt · /.well-known/agent-card.json。其它 REST 需要 x-api-key。" : "No key: /v1/context · /v1/assets · /v1/policies · /a2mcp/* · /pub/* · /openapi.json · /llms.txt · /.well-known/agent-card.json. Other REST calls need x-api-key."}</p>
      </aside>
    <div className="min-w-0 space-y-5">
      <h1 className="text-2xl font-bold">{t("dev_h")}</h1>
      <p className="text-sm text-fg-2">{zh ? "机器可读的入口：" : "Machine-readable entry points: "}<a className="mono underline" href="/openapi.json">/openapi.json</a> · <a className="mono underline" href="/llms.txt">/llms.txt</a> · <a className="mono underline" href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>{zh ? "（描述全部端点、哪些免 key、怎么调用）。" : " (every endpoint, which ones need no key, how to call)."}</p>

      <Card title={<span id="free" className="scroll-mt-24">{zh ? "免 key：GET /v1/context（agent 档）· /v1/assets · /v1/policies" : "No key needed: GET /v1/context (agent tier) · /v1/assets · /v1/policies"}</span>}>
        <p className="text-sm text-neutral-300">{zh ? "任何 Agent 都可以免费读市场上下文的 agent 档：只含派生字段（时段、事件、窗口、静默期、曲线形态、漂移判定）与官方公开源数值；私有研究不导出。字段不在档位时整个字段标 unavailable（note=not_in_tier），绝不省略键。响应带 crowsnest Ed25519 签名与 provenance.mode（live / backfill / sample）——只有 live 才能参与 LIVE 判定。" : "Any agent can read the agent tier of the market context for free: derived fields only (session, events, windows, blackout, curve shape, drift verdict) plus official public-source values; private research is never exported. Fields outside the tier are whole-field unavailable (note=not_in_tier), never omitted. Responses carry the crowsnest Ed25519 signature and provenance.mode (live / backfill / sample); only live may take part in a LIVE decision."}</p>
        <pre className="mono mt-3 overflow-auto rounded-lg bg-surface-0 p-3 text-xs">{`# no API key needed
curl "${SERVICE}/v1/assets"        # registry: assetKey, symbol, decimals, role, executionAllowed
curl "${SERVICE}/v1/policies"      # the three policies with definition hashes
curl "${SERVICE}/v1/context?tier=agent&assetKey=eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a"
# → 200 { "schemaVersion":"chaconne-context/1", "packagedAt":"…", "provenance":{"mode":"live"},
#         "session":{"label":{"value":"US_REGULAR","status":"ok","source":"…","observedAt":"…"}, …},
#         "events":[…], "fed":{…}, "rates":{"y10":{"value":"4.96","status":"ok"}, …},
#         "risk":{"vix":{"value":null,"status":"unavailable","note":"not_in_tier"}, …} }`}</pre>
        <p className="mt-2 text-xs text-fg-3">{zh ? "MCP：get_market_context；SDK：client.context.get({ tier: \"agent\" })。其它档位（display / paid）才需要 key。" : "MCP: get_market_context; SDK: client.context.get({ tier: \"agent\" }). Only the display / paid tiers need a key."}</p>
      </Card>

      <Card title={<span id="a2mcp" className="scroll-mt-24">{zh ? "免 key：通过 OKX AI 使用（A2MCP）" : "No key needed: use through OKX AI (A2MCP)"}</span>}>
        <p className="text-sm text-neutral-300">{zh ? "服务：Chaconne Verify · StockProof Trade Verification（ASP #13803）。A2MCP 传输约定只用两个状态码：任何缺参数/参数错误都是 HTTP 200 + status: input_required（正文带缺失项、提示、schema 和示例）；成功是 HTTP 200 + status: delivered（一句话结论 + 完整报告）；收费阶段是 402 + PAYMENT-REQUIRED（x402 v2）。参数可以直接写符号和人类金额。" : "Service: Chaconne Verify · StockProof Trade Verification (ASP #13803). The A2MCP transport uses only two status codes: any missing/invalid input is HTTP 200 with status: input_required (missing fields, hints, schema and an example in the body); success is HTTP 200 with status: delivered (a one-line summary plus the full report); the paid phase is 402 + PAYMENT-REQUIRED (x402 v2). Symbols and human amounts are accepted directly."}</p>
        <pre className="mono mt-3 overflow-auto rounded-lg bg-surface-0 p-3 text-xs">{`curl -X POST ${SERVICE}/a2mcp/verify -H "Content-Type: application/json" -d '{
  "ownerAddress": "0xYourWallet",
  "outputAssetKey": "AAPLx",      # or AAPL / NVDAx / NVDA / a 0x address
  "amount": "100",                # 100 USDG (human units); or amountInRaw
  "policyId": "REFERENCE_CONTEXT" # optional; STRICT_LIVE | REFERENCE_CONTEXT | QUOTE_ONLY
}'

# → 200 {"ok":true,"status":"delivered","summary":"ELIGIBLE under REFERENCE_CONTEXT: …","verdict":"eligible","jobId":"job_…","report":{…}}
# → 200 {"ok":false,"status":"input_required","missingParams":[…],"schema":{…},"example":{…}}   (never 4xx)
# → 402 + PAYMENT-REQUIRED header                                                       (paid phase)`}</pre>
        <p className="mt-2 text-xs text-fg-3">{zh ? "GET 也可用（参数放 query）。同参数重复调用返回同一任务，不重复计费。" : "GET works too (params in the query string). Repeating the same parameters returns the same task; nothing is charged twice."}</p>
      </Card>

      <Card title={<span id="addresses" className="scroll-mt-24">{zh ? "地址（X Layer 主网 · chainId 196）" : "Addresses (X Layer mainnet · chainId 196)"}</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <tbody>
              {[
                ["ChaconneVerifyGuard (v1, single trade)", ADDR.guard, true],
                ["ChaconneVerifyPlanGuard (v2, mandates)", ADDR.planGuard, true],
                [zh ? "证明签名者（attestation signer, epoch 1）" : "Attestation signer (epoch 1)", ADDR.signer, false],
              ].map(([label, addr, isContract]) => (
                <tr key={String(addr)} className="border-b border-line last:border-0">
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
        <p className="mt-2 text-xs text-fg-3">{zh ? "两个合约均 Sourcify 精确匹配；EIP-712 domain：ChaconneVerifyGuard v1 / ChaconneVerifyPlanGuard v1。当前 signer 与 epoch 也可从 GET /healthz 读取。" : "Both contracts are Sourcify exact matches; EIP-712 domains: ChaconneVerifyGuard v1 / ChaconneVerifyPlanGuard v1. The current signer and epoch are also exposed by GET /healthz."}</p>
      </Card>

      <Card title={<span id="v1" className="scroll-mt-24">{zh ? "HTTP API · 核验（v1）· 需 key" : "HTTP API · verification (v1) · key required"}</span>}>
        <Tbl rows={v1} zh={zh} />
        <pre className="mono mt-3 overflow-auto rounded-lg bg-surface-0 p-3 text-xs">{`# key required (x-api-key or Authorization: Bearer)
curl -X POST ${SERVICE}/v1/jobs -H "x-api-key: <your key>" -H "Content-Type: application/json" -d '{
  "clientRequestId": "my-1", "ownerAddress": "0xYourWallet",
  "inputAssetKey": "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "outputAssetKey": "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a",
  "amountInRaw": "5000000", "policyId": "REFERENCE_CONTEXT", "maxSlippageBps": 50, "maxPriceImpactBps": 100, "maxReferenceDeviationBps": 300 }'`}</pre>
      </Card>
      <Card title={<span id="v5" className="scroll-mt-24">{zh ? "HTTP API · 规划、授权计划、模拟、战报（v5）· 需 key" : "HTTP API · plans, mandates, simulations, reports (v5) · key required"}</span>}>
        <Tbl rows={v2} zh={zh} />
        <p className="mt-2 text-xs text-fg-3">{zh ? "鉴权：x-api-key 或 Authorization: Bearer；A2MCP 端点、/pub/*、/v1/assets、/v1/policies 与 /v1/context?tier=agent 不需要 key。响应 private/no-store。API key 在 Dev Day 期间联系运营者获取。" : "Auth: x-api-key or Authorization: Bearer; A2MCP endpoints, /pub/*, /v1/assets, /v1/policies and /v1/context?tier=agent need no key. Responses are private/no-store. During Dev Day, ask the operator for an API key."}</p>
      </Card>

      <Card title={<span id="v6" className="scroll-mt-24">{zh ? "HTTP API · Agent（v6）· 需 key" : "HTTP API · agent (v6) · key required"}</span>}>
        <Tbl rows={v6} zh={zh} />
        <pre className="mono mt-3 overflow-auto rounded-lg bg-surface-0 p-3 text-xs">{`# create a simulation task: inputAssetKey + perStepAmountRaw are required by the playbook
curl -X POST ${SERVICE}/v1/tasks -H "x-api-key: <your key>" -H "Content-Type: application/json" -d '{
  "clientRequestId": "my-task-1", "ownerAddress": "0xYourWallet", "playbookId": "session_dca", "mode": "SIMULATION",
  "params": { "inputAssetKey": "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "outputAssetKey": "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", "steps": 3, "perStepAmountRaw": "1000000" },
  "conditions": { "version": "conditions/1", "items": [ { "type": "session", "allow": ["US_REGULAR"] }, { "type": "min_gap_trading_days", "days": 1 } ] } }'
# → 201 { "task": { "id": "tsk_…", "status": "WAITING", "blockers": [...], "nextCheckAt": "…" }, "mode": "SIMULATION", ... }
# 400 invalid_playbook_params → details[] = [{ "field": "perStepAmountRaw", "code": "required" }, ...]
# GET  /v1/tasks/:id/explain-wait   (GET only; a POST is not the same resource)`}</pre>
        <p className="mt-2 text-xs text-fg-3">{zh ? "尚未部署到这台服务器的端点返回 404；页面与 MCP 工具据此显示「尚未就绪」，不用假数据。" : "Endpoints not yet deployed on this server return 404; pages and MCP tools then show “not ready” instead of sample data."}</p>
      </Card>

      <Card title={<span id="mcp" className="scroll-mt-24">{zh ? "MCP 工具（verify-mcp，46 个）" : "MCP tools (verify-mcp, 46)"}</span>}>
        <p className="text-sm text-neutral-300">{zh ? "VERIFY_API_KEY 可选：不给 key 时服务器以免 key 只读模式运行——只读工具（get_market_context / get_events / list_supported_assets / get_verification_policy / get_products）与三个免 key 工具 verify_once_free / plan_free / agent_tasks_free 都可用；建任务、授权、执行类工具需要 key。" : "VERIFY_API_KEY is optional: without it the server runs in free read-only mode — the read-only tools (get_market_context / get_events / list_supported_assets / get_verification_policy / get_products) and the three free tools verify_once_free / plan_free / agent_tasks_free all work; task, mandate and execution tools need a key."}</p>
        <div className="mt-3 space-y-2 text-sm">
          {MCP_TOOLS.map(([group, names]) => (
            <div key={group}>
              <p className="text-xs uppercase tracking-wide text-fg-3">{group}</p>
              <p className="mono break-words text-neutral-300 [overflow-wrap:anywhere]">{names.join(" · ")}</p>
            </div>
          ))}
        </div>
        <pre className="mono mt-3 overflow-auto rounded-lg bg-surface-0 p-3 text-xs">{`// example tool calls (arguments are plain JSON)
get_market_context      { "tier": "agent", "assetKey": "AAPLx" }
get_my_event_impacts    { "owner": "0xYourWallet", "horizonHours": 48 }
create_task             { "ownerAddress": "0xYourWallet", "playbookId": "session_dca", "mode": "SIMULATION",
                          "params": { "inputAssetKey": "USDG", "outputAssetKey": "AAPLx", "steps": 3, "perStepAmountRaw": "1000000" },
                          "conditions": { "version": "conditions/1", "items": [ { "type": "session", "allow": ["US_REGULAR"] } ] } }
explain_task_wait       { "taskId": "tsk_…" }`}</pre>
        <p className="mt-2 text-xs text-fg-3">{zh ? "stdio 传输；默认不持有任何私钥。可选 agent-wallet 模式（用户自己的 Agent 钱包，AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS 三者齐备才启用）：x402 自动付款带花费上限、代签 TradeMandate、执行步骤（发交易前读链上 stepIndex，预授权后再取证书）。" : "stdio transport; holds no private key by default. Optional agent-wallet mode (your own agent wallet; enabled only when AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS are all set): auto-pays x402 within a spend cap, signs TradeMandate, executes steps (reads the on-chain stepIndex before sending, pre-approves before fetching the certificate)."}</p>
        <pre className="mono mt-3 overflow-auto rounded-lg bg-surface-0 p-3 text-xs">{`# the package is not published on npm yet — run it from the repo:
git clone https://github.com/Bachamht/verify_chaconne && cd verify_chaconne && pnpm install && node packages/verify-mcp/bin/chaconne-verify-mcp.mjs

{ "mcpServers": { "chaconne-verify": {
    "command": "node", "args": ["<path-to>/verify_chaconne/packages/verify-mcp/bin/chaconne-verify-mcp.mjs"],
    "env": { "VERIFY_SERVICE_URL": "${SERVICE}" }                                   // free read-only mode
    // "env": { "VERIFY_SERVICE_URL": "${SERVICE}", "VERIFY_API_KEY": "<your key>" }   // full tool set (optional)
} } }`}</pre>
      </Card>

      <Card title={<span id="sdk" className="scroll-mt-24">SDK (@chaconne/verify-sdk)</span>}>
        <pre className="mono overflow-auto rounded-lg bg-surface-0 p-3 text-xs">{`import { createClient } from "@chaconne/verify-sdk";
const c = createClient({ baseUrl: "${SERVICE}", apiKey: process.env.VERIFY_API_KEY /*, x402Signer: account */ });

const job  = await c.jobs.create({ ownerAddress, inputAssetKey, outputAssetKey, amountInRaw: "5000000", policyId: "REFERENCE_CONTEXT", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, clientRequestId: "my-1" });
const rep  = await c.jobs.report(job.body.jobId);          // pays via x402 automatically when x402Signer is set
const plan = await c.plans.create({ /* PlanGoal + clientRequestId */ });
const m    = await c.mandates.create({ /* typedData + signature + legs … */ });
const step = await c.mandates.prepareStep(m.body.mandateId); // → executeStep on PlanGuard from your wallet
const bundle = await c.jobs.bundle(job.body.jobId);         // re-check offline with verify_evidence_bundle / npx verify-bundle`}</pre>
        <p className="mt-2 break-words text-xs text-fg-3 [overflow-wrap:anywhere]">{zh ? "方法：assets · policies · products · healthz · jobs.{create,get,report,prepareExecution,submit,bundle,bill} · plans.{create,get,toJob} · mandates.{create,get,pause,resume,cancel,prepareStep,submitStep,bundle,bill} · simulations · profiles · templates · shares.{create,getPublic} · a2mcp.{verify,plan,agentTasks} · v6：context.get · events.{list,revisions,impacts} · tasks.{create,get,list,pause,resume,cancel,authorize,prepareStep,explainWait,comparePolicies} · executor.heartbeat · theses · budgetGroups · portfolio · notify · replays · rebalance · recaps.{list,get,share,getPublic} · missions.list · isNotAvailable()。" : "Methods: assets · policies · products · healthz · jobs.{create,get,report,prepareExecution,submit,bundle,bill} · plans.{create,get,toJob} · mandates.{create,get,pause,resume,cancel,prepareStep,submitStep,bundle,bill} · simulations · profiles · templates · shares.{create,getPublic} · a2mcp.{verify,plan,agentTasks} · v6: context.get · events.{list,revisions,impacts} · tasks.{create,get,list,pause,resume,cancel,authorize,prepareStep,explainWait,comparePolicies} · executor.heartbeat · theses · budgetGroups · portfolio · notify · replays · rebalance · recaps.{list,get,share,getPublic} · missions.list · isNotAvailable()."}</p>
      </Card>

      <Card title={<span id="trust" className="scroll-mt-24">{zh ? "信任边界（如实）" : "Trust boundary (stated plainly)"}</span>}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-300">
          <li>{zh ? "服务持有一把只签证明（VerificationCertificate / StepCertificate / bundleHash）的私钥；不持有用户资金私钥，不代签付款或交易，不做 relayer。" : "The service holds one attestation key that signs only certificates (VerificationCertificate / StepCertificate / bundleHash); it never holds user fund keys, never signs payments or trades, and runs no relayer."}</li>
          <li>{zh ? "Guard / PlanGuard 强制金额、最小到账、收款人、路由/选择器白名单、期限、nonce 与步序；它们不知道链下股票参考是否正确——这是证明服务的判断，通过 evidenceHash 绑定，任何人可用证据包离线复核。" : "Guard / PlanGuard enforce amount, minimum output, recipient, route/selector allowlists, deadline, nonce and step order; they cannot know whether off-chain stock data was correct — that judgement is the attestation service's, bound by evidenceHash and re-checkable offline from the evidence bundle."}</li>
          <li>{zh ? "证明最长 60 秒，且不得比它依据的报价更久（通常约 30 秒）。管理员可暂停、轮换签名身份、改白名单；不能动用户资金。" : "A certificate lives at most 60 s and never longer than the quote it rests on (usually about 30 s). Admin can pause, rotate the signer and edit allowlists; it cannot move user funds."}</li>
          <li>{zh ? "证据里 kind=pyth_reference 是历史命名（CV-D01 泛化为「实时参考 tick」），provider 字段标明真实来源（finnhub）。" : "The evidence kind pyth_reference is a legacy name (generalized to “live reference tick” under CV-D01); the provider field states the real source (finnhub)."}</li>
        </ul>
        <p className="mt-3 text-sm"><Link className="underline" href="/replay/AAPLx">{t("replay_h")} →</Link> · <Link className="underline" href="/verify-bundle">{t("nav_verify_bundle")} →</Link></p>
      </Card>
    </div>
    </div>
  );
}
