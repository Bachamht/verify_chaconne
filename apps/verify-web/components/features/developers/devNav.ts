/**
 * 开发者页的目录 / tab / 地址 / MCP 工具清单（纯数据，便于单测；不引 React，不引钱包代码）。
 * 内容逐字迁自 app/developers/page.tsx（v7），只是按 tab 分组。
 */
export const SERVICE = process.env["NEXT_PUBLIC_PUBLIC_SERVICE_URL"] ?? "https://verify.chaconne.xyz";

export const DEV_TABS = ["rest", "a2mcp", "mcp", "sdk", "contracts"] as const;
export type DevTab = (typeof DEV_TABS)[number];

export const TAB_LABEL: Record<DevTab, { zh: string; en: string }> = {
  rest: { zh: "REST", en: "REST" },
  a2mcp: { zh: "A2MCP", en: "A2MCP" },
  mcp: { zh: "MCP", en: "MCP" },
  sdk: { zh: "SDK", en: "SDK" },
  contracts: { zh: "合约", en: "Contracts" },
};

export interface DevSection { id: string; zh: string; en: string; tab: DevTab }

/** 左目录：原来的 9 节，每节归到一个 tab */
export const SECTIONS: readonly DevSection[] = [
  { id: "free", zh: "免 key 接入", en: "No-key access", tab: "rest" },
  { id: "a2mcp", zh: "A2MCP（OKX AI）", en: "A2MCP (OKX AI)", tab: "a2mcp" },
  { id: "addresses", zh: "合约地址", en: "Addresses", tab: "contracts" },
  { id: "v1", zh: "REST · 核验 v1", en: "REST · verification v1", tab: "rest" },
  { id: "v5", zh: "REST · 规划 / 授权 v5", en: "REST · plans / mandates v5", tab: "rest" },
  { id: "v6", zh: "REST · Agent v6", en: "REST · agent v6", tab: "rest" },
  { id: "mcp", zh: "MCP 工具", en: "MCP tools", tab: "mcp" },
  { id: "sdk", zh: "SDK", en: "SDK", tab: "sdk" },
  { id: "trust", zh: "信任边界", en: "Trust boundary", tab: "contracts" },
];

export function isDevTab(v: string): v is DevTab {
  return (DEV_TABS as readonly string[]).includes(v);
}

/** URL 的 ?tab= 或 #锚点 → tab；认不出回 REST */
export function tabFor(value: string | null | undefined): DevTab {
  const v = (value ?? "").replace(/^#/, "");
  if (isDevTab(v)) return v;
  return SECTIONS.find((s) => s.id === v)?.tab ?? "rest";
}

export const ADDRESSES: ReadonlyArray<{ key: string; zh: string; en: string; value: string; contract: boolean }> = [
  { key: "planGuard", zh: "ChaconneVerifyPlanGuard（v2，委托多步）", en: "ChaconneVerifyPlanGuard (v2, mandates)", value: "0xE8517f296211F4b9175796bAAB47979FB14Fd2F0", contract: true },
  { key: "signer", zh: "证明签名者（attestation signer, epoch 1）", en: "Attestation signer (epoch 1)", value: "0x757fdc93fd8db505529680b2c6c5364263f5e615", contract: false },
];

export const sourcifyUrl = (addr: string) => `https://sourcify.dev/server/v2/contract/196/${addr}`;

export const MCP_TOOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["v1 · verification", ["list_supported_assets", "get_verification_policy", "prepare_verification", "purchase_verification", "get_verification"]],
  ["v2 · plan & simulate", ["plan_trade", "create_simulation", "get_products"]],
  ["v2 · mandate (one signature, many steps)", ["prepare_mandate", "register_mandate", "get_mandate", "pause_mandate", "resume_mandate", "cancel_mandate", "execute_next_step"]],
  ["v2 · evidence & share", ["get_evidence_bundle", "verify_evidence_bundle", "create_share_card"]],
  ["v6 · context & events", ["get_market_context", "get_events", "get_my_event_impacts"]],
  ["v6 · tasks (playbooks + conditions)", ["create_task", "get_task", "pause_task", "resume_task", "cancel_task", "authorize_task", "explain_task_wait", "compare_task_policies", "replay_policy"]],
  ["v6 · thesis, budget, portfolio, rebalance", ["watch_thesis", "add_thesis_review_item", "get_budget_group", "create_budget_group", "get_portfolio", "report_cost_override", "preview_rebalance", "create_rebalance_plan"]],
  ["v6 · notifications & executor", ["register_webhook", "link_telegram", "executor_heartbeat"]],
  ["free · no key (read-only)", ["verify_once_free", "plan_free", "agent_tasks_free"]],
];
