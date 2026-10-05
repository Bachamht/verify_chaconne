"use client";
import Link from "next/link";
import { CodeBlock } from "@/components/kit/CodeBlock";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { EndpointTable } from "./EndpointTable";
import { V1_ROWS, V5_ROWS, V6_ROWS } from "./restEndpoints";
import { SNIPPET_FREE, SNIPPET_V1, SNIPPET_V6 } from "./snippets";

const NOTE = "mt-3 text-xs leading-5 text-fg-3";
const LINK = "text-brand-400 underline underline-offset-2 hover:text-brand-300";

/** REST tab：免 key 接入 · v1 核验 · v5 规划/授权 · v6 Agent */
export function RestTab() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel id="free" className="scroll-mt-20">
        <Panel.Header title={zh ? "免 key：GET /v1/context（agent 档）· /v1/assets · /v1/policies" : "No key needed: GET /v1/context (agent tier) · /v1/assets · /v1/policies"} />
        <Panel.Body>
          <p className="text-sm leading-6 text-fg-2">{zh ? "任何 Agent 都可以免费读市场上下文的 agent 档：只含派生字段（时段、事件、窗口、静默期、曲线形态、漂移判定）与官方公开源数值；私有研究不导出。字段不在档位时整个字段标 unavailable（note=not_in_tier），绝不省略键。响应带 crowsnest Ed25519 签名与 provenance.mode（live / backfill / sample），只有 live 才能参与 LIVE 判定。" : "Any agent can read the agent tier of the market context for free: derived fields only (session, events, windows, blackout, curve shape, drift verdict) plus official public-source values; private research is never exported. Fields outside the tier are whole-field unavailable (note=not_in_tier), never omitted. Responses carry the crowsnest Ed25519 signature and provenance.mode (live / backfill / sample); only live may take part in a LIVE decision."}</p>
          <CodeBlock className="mt-3" language="bash" code={SNIPPET_FREE} />
          <p className={NOTE}>{zh ? "MCP：get_market_context；SDK：client.context.get({ tier: \"agent\" })。其它档位（display / paid）才需要 key。" : "MCP: get_market_context; SDK: client.context.get({ tier: \"agent\" }). Only the display / paid tiers need a key."}</p>
        </Panel.Body>
      </Panel>

      <Panel id="v1" className="scroll-mt-20">
        <Panel.Header title={zh ? "HTTP API · 核验（v1）" : "HTTP API · verification (v1)"} />
        <Panel.Body>
          <EndpointTable rows={V1_ROWS} caption={zh ? "核验 v1 端点" : "Verification v1 endpoints"} />
          <CodeBlock className="mt-3" language="bash" code={SNIPPET_V1} />
        </Panel.Body>
      </Panel>

      <Panel id="v5" className="scroll-mt-20">
        <Panel.Header title={zh ? "HTTP API · 规划、授权计划、模拟、战报（v5）" : "HTTP API · plans, mandates, simulations, reports (v5)"} />
        <Panel.Body>
          <EndpointTable rows={V5_ROWS} caption={zh ? "规划与授权 v5 端点" : "Plans and mandates v5 endpoints"} />
          <p className={NOTE}>{zh ? <>鉴权：请求头 x-api-key。key 在 <Link className={LINK} href="/agent/keys">Agent 接入 key</Link> 用钱包签一条消息自助生成，绑定那个钱包：用它建的任务与网站上同一钱包看到的是同一批；随时可吊销。免 key 端点：/v1/assets、/v1/policies、/v1/context（agent 档）、/v1/events、/a2mcp/*、/pub/*。响应 private/no-store。</> : <>Auth: send x-api-key. Issue a key with one wallet signature under <Link className={LINK} href="/agent/keys">Agent API keys</Link>; it is bound to that wallet, so tasks it creates are the same set the site shows for that wallet; revoke any time. Key-free endpoints: /v1/assets, /v1/policies, /v1/context (agent tier), /v1/events, /a2mcp/*, /pub/*. Responses are private/no-store.</>}</p>
        </Panel.Body>
      </Panel>

      <Panel id="v6" className="scroll-mt-20">
        <Panel.Header title={zh ? "HTTP API · Agent（v6）· 需 key" : "HTTP API · agent (v6) · key required"} />
        <Panel.Body>
          <EndpointTable rows={V6_ROWS} caption={zh ? "Agent v6 端点" : "Agent v6 endpoints"} />
          <CodeBlock className="mt-3" language="bash" code={SNIPPET_V6} />
          <p className={NOTE}>{zh ? "尚未部署到这台服务器的端点返回 404；页面与 MCP 工具据此显示「尚未就绪」，不用假数据。" : "Endpoints not yet deployed on this server return 404; pages and MCP tools then show “not ready” instead of sample data."}</p>
        </Panel.Body>
      </Panel>
    </div>
  );
}
