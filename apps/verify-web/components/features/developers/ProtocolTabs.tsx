"use client";
import Link from "next/link";
import { CodeBlock } from "@/components/kit/CodeBlock";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { MCP_TOOLS } from "./devNav";
import { SDK_METHODS, SDK_METHODS_V6, SNIPPET_A2MCP, SNIPPET_MCP_CALLS, SNIPPET_MCP_INSTALL, SNIPPET_SDK } from "./snippets";

const NOTE = "mt-3 text-xs leading-5 text-fg-3";
const BODY = "text-sm leading-6 text-fg-2";
const LINK = "text-brand-400 underline underline-offset-2 hover:text-brand-300";

/** A2MCP tab：OKX AI 的 200 契约 */
export function A2mcpTab() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Panel id="a2mcp" className="scroll-mt-20">
      <Panel.Header title={zh ? "免 key：通过 OKX AI 使用（A2MCP）" : "No key needed: use through OKX AI (A2MCP)"} />
      <Panel.Body>
        <p className={BODY}>{zh ? "服务：Chaconne Verify · StockProof Trade Verification（ASP #13803）。A2MCP 传输约定只用两个状态码：任何缺参数/参数错误都是 HTTP 200 + status: input_required（正文带缺失项、提示、schema 和示例）；成功是 HTTP 200 + status: delivered（一句话结论 + 完整报告）；收费阶段是 402 + PAYMENT-REQUIRED（x402 v2）。参数可以直接写符号和人类金额。" : "Service: Chaconne Verify · StockProof Trade Verification (ASP #13803). The A2MCP transport uses only two status codes: any missing/invalid input is HTTP 200 with status: input_required (missing fields, hints, schema and an example in the body); success is HTTP 200 with status: delivered (a one-line summary plus the full report); the paid phase is 402 + PAYMENT-REQUIRED (x402 v2). Symbols and human amounts are accepted directly."}</p>
        <CodeBlock className="mt-3" language="bash" code={SNIPPET_A2MCP} />
        <p className={NOTE}>{zh ? "GET 也可用（参数放 query）。同参数重复调用返回同一任务，不重复计费。" : "GET works too (params in the query string). Repeating the same parameters returns the same task; nothing is charged twice."}</p>
      </Panel.Body>
    </Panel>
  );
}

/** MCP tab：46 个工具分组、示例调用、安装 */
export function McpTab() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Panel id="mcp" className="scroll-mt-20">
      <Panel.Header title={zh ? "MCP 工具（verify-mcp，46 个）" : "MCP tools (verify-mcp, 46)"} />
      <Panel.Body>
        <p className={BODY}>{zh ? <>VERIFY_API_KEY：在 <Link className={LINK} href="/agent/keys">Agent 接入 key</Link> 生成（钱包签名，绑定钱包）。不给 key 时只有只读工具（get_market_context / get_events / list_supported_assets / get_verification_policy / get_products）与三个免 key 工具 verify_once_free / plan_free / agent_tasks_free 可用；建任务、提交意图、授权、执行类工具需要 key。</> : <>VERIFY_API_KEY: issue it under <Link className={LINK} href="/agent/keys">Agent API keys</Link> (wallet signature, bound to the wallet). Without it only the read-only tools (get_market_context / get_events / list_supported_assets / get_verification_policy / get_products) and the three free tools verify_once_free / plan_free / agent_tasks_free work; task, intent, mandate and execution tools need the key.</>}</p>
        <dl className="mt-4 divide-y divide-line rounded-md border">
          {MCP_TOOLS.map(([group, names]) => (
            <div key={group} className="flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:flex-row sm:gap-4">
              <dt className="shrink-0 text-xs font-medium text-fg-3 sm:w-56" translate="no">{group}</dt>
              <dd className="min-w-0 font-mono text-xs leading-5 wrap-anywhere text-fg-1" translate="no">{names.join(" · ")}</dd>
            </div>
          ))}
        </dl>
        <CodeBlock className="mt-4" language="json" code={SNIPPET_MCP_CALLS} />
        <p className={NOTE}>{zh ? "stdio 传输；默认不持有任何私钥。可选 agent-wallet 模式（用户自己的 Agent 钱包，AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS 三者齐备才启用）：x402 自动付款带花费上限、代签 TradeMandate、执行步骤（发交易前读链上 stepIndex，预授权后再取证书）。" : "stdio transport; holds no private key by default. Optional agent-wallet mode (your own agent wallet; enabled only when AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS are all set): auto-pays x402 within a spend cap, signs TradeMandate, executes steps (reads the on-chain stepIndex before sending, pre-approves before fetching the certificate)."}</p>
        <CodeBlock className="mt-3" language="bash" code={SNIPPET_MCP_INSTALL} />
      </Panel.Body>
    </Panel>
  );
}

/** SDK tab */
export function SdkTab() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Panel id="sdk" className="scroll-mt-20">
      <Panel.Header title="SDK (@chaconne/verify-sdk)" />
      <Panel.Body>
        <CodeBlock language="ts" code={SNIPPET_SDK} />
        <p className={`${NOTE} wrap-anywhere`}>{zh ? `方法：${SDK_METHODS}：${SDK_METHODS_V6}。` : `Methods: ${SDK_METHODS}: ${SDK_METHODS_V6}.`}</p>
      </Panel.Body>
    </Panel>
  );
}
