/**
 * v7 界面的本地 fixture（只在 NEXT_PUBLIC_V7_UI=1 且地址栏带 ?v7fixture=1 时使用；页面一律挂 FIXTURE 角标）。
 * 形状严格按 contracts.ts「v7 增补」；用来在后端各 lane 还没合并时搭界面、截图、做视口检查。
 * 地址只用占位地址与登记表里的代币地址；没有任何签名、私钥或真实交易哈希。
 */
import type { AgentRunStep, AgentRunSummary, DelegationChecklist, TaskRuntime } from "@chaconne/core/verify";
import type { ActivityItem, OwnerAllowancesView, PublicActivityView, TaskCreated, TaskPosition } from "./api-v2";

export const FX_OWNER = "0x0000000000000000000000000000000000000001" as const;
export const FX_PLANGUARD = "0xE8517f296211F4b9175796bAAB47979FB14Fd2F0" as const;
export const FX_USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
export const FX_AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
export const FX_NVDAX = "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const tok = (k: string) => k.split(":")[2] as `0x${string}`;
const H = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

const permitTd = (token: string, value: string) => ({
  domain: { name: "Fixture Token", version: "1", chainId: 196, verifyingContract: tok(token) },
  types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  primaryType: "Permit",
  message: { owner: FX_OWNER, spender: FX_PLANGUARD, value, nonce: "0", deadline: "1790000000" },
});

/** 含 2 只可减仓股票的委托：6 次签名，已签 2 次（买入授权 + USDG 额度） */
export function fxChecklist(stage: "fresh" | "partial" | "done" = "partial"): DelegationChecklist {
  const s = (i: number) => (stage === "done" ? "confirmed" : stage === "partial" && i < 2 ? (i === 1 ? "submitted" : "confirmed") : "todo") as DelegationChecklist["items"][number]["status"];
  const items: DelegationChecklist["items"] = [
    { id: "buy", kind: "mandate_buy", assetKey: FX_USDG, title: { zh: "买入授权", en: "Buy authorization" }, explain: { zh: "允许在 10/12 前用最多 10 USDG、每笔最多 2 USDG、最多 5 笔买入 AAPLx / NVDAx；只经 PlanGuard 合约 0xE851…F2F0；买到的股票只进你的钱包；可随时链上撤销。", en: "Allows buying AAPLx / NVDAx before 10/12 with at most 10 USDG, at most 2 USDG per step, at most 5 steps; only through the PlanGuard contract 0xE851…F2F0; bought stock goes only to your wallet; revocable on-chain at any time." }, typedData: stage === "fresh" ? permitTd(FX_USDG, "0") : null, status: s(0), ref: stage === "fresh" ? null : "mdt_fx_buy" },
    { id: `sell:${FX_AAPLX}`, kind: "mandate_sell", assetKey: FX_AAPLX, title: { zh: "卖出授权 · AAPLx", en: "Sell authorization · AAPLx" }, explain: { zh: "允许在到期前按策略把 AAPLx 换回 USDG，最多可卖出你的全部持仓；换回的 USDG 只进你的钱包。到期 10/12；合约上限 0.087 股（你签的）。", en: "Allows converting AAPLx back to USDG before the deadline as the strategy says, up to your full holdings; the USDG goes to your wallet only. Deadline 10/12; contract cap 0.087 shares (what you sign)." }, typedData: stage === "done" ? null : permitTd(FX_AAPLX, "0"), status: s(2), ref: null },
    { id: `sell:${FX_NVDAX}`, kind: "mandate_sell", assetKey: FX_NVDAX, title: { zh: "卖出授权 · NVDAx", en: "Sell authorization · NVDAx" }, explain: { zh: "允许在到期前按策略把 NVDAx 换回 USDG，最多可卖出你的全部持仓；换回的 USDG 只进你的钱包。到期 10/12；合约上限 0.11 股（你签的）。", en: "Allows converting NVDAx back to USDG before the deadline as the strategy says, up to your full holdings; the USDG goes to your wallet only. Deadline 10/12; contract cap 0.11 shares (what you sign)." }, typedData: stage === "done" ? null : permitTd(FX_NVDAX, "0"), status: s(3), ref: null },
    { id: `permit:${tok(FX_USDG)}`, kind: "permit", assetKey: FX_USDG, title: { zh: "额度签名 · USDG", en: "Allowance signature · USDG" }, explain: { zh: "允许 PlanGuard 最多动用 10.05 USDG（含 0.5% 舍入余量）。这是签名，不是交易，不花 gas。", en: "Allows PlanGuard to use at most 10.05 USDG (including a 0.5% rounding margin). This is a signature, not a transaction; no gas." }, typedData: stage === "fresh" ? permitTd(FX_USDG, "10050000") : null, permitRequestId: "prm_fx_usdg", status: s(1), ref: "prm_fx_usdg", txHash: stage === "fresh" ? null : H("a") },
    { id: `permit:${tok(FX_AAPLX)}`, kind: "permit", assetKey: FX_AAPLX, title: { zh: "额度签名 · AAPLx", en: "Allowance signature · AAPLx" }, explain: { zh: "允许 PlanGuard 最多动用 0.0874 AAPLx（含 0.5% 舍入余量），只用于本任务的减仓。这是签名，不是交易，不花 gas。", en: "Allows PlanGuard to use at most 0.0874 AAPLx (including a 0.5% rounding margin), only for this task's trims. This is a signature, not a transaction; no gas." }, typedData: stage === "done" ? null : permitTd(FX_AAPLX, "87435000000000000"), permitRequestId: "prm_fx_aaplx", status: s(4), ref: null },
    { id: `permit:${tok(FX_NVDAX)}`, kind: "permit", assetKey: FX_NVDAX, title: { zh: "额度签名 · NVDAx", en: "Allowance signature · NVDAx" }, explain: { zh: "允许 PlanGuard 最多动用 0.1106 NVDAx（含 0.5% 舍入余量），只用于本任务的减仓。这是签名，不是交易，不花 gas。", en: "Allows PlanGuard to use at most 0.1106 NVDAx (including a 0.5% rounding margin), only for this task's trims. This is a signature, not a transaction; no gas." }, typedData: stage === "done" ? null : permitTd(FX_NVDAX, "110550000000000000"), permitRequestId: "prm_fx_nvdax", status: s(5), ref: null },
  ];
  const done = items.filter((x) => x.status === "confirmed" || x.status === "submitted").length;
  return {
    taskId: "tsk_fixture",
    items,
    counts: { signaturesNeeded: 6, signaturesDone: done, userTransactions: 0 },
    allowances: [
      { token: tok(FX_USDG), assetKey: FX_USDG, onchainRaw: stage === "fresh" ? "0" : "10050000", requiredRaw: "10000000", pendingPermit: stage === "partial" },
    ],
    buyReady: stage === "done",
    sellReady: { [FX_AAPLX]: stage === "done", [FX_NVDAX]: stage === "done" },
    complete: stage === "done",
  };
}

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

export function fxRuntime(state: "working" | "waiting" | "awaiting_fill" = "waiting", mode: "LIVE" | "SIMULATION" = "LIVE"): TaskRuntime {
  return {
    agentMode: "hosted",
    executorMode: mode === "SIMULATION" ? null : "hosted",
    presence: {
      mode: "hosted",
      state,
      currentActivity: state === "working" ? "询价 NVDAx（100 USDG 档）" : null,
      waitingFor: state === "waiting" ? "非农实际值发布后的第一份报价（数据 22:30 发布）" : null,
      lastDecisionAt: iso(14),
      nextCheckAt: new Date(now + 26 * 60_000).toISOString(),
    },
    executor: { mode: mode === "SIMULATION" ? null : "hosted", state: state === "awaiting_fill" ? "busy" : "ready", address: null, lastJobAt: iso(52) },
    needsOwner: [],
    needsOperator: [],
  };
}

export function fxActivity(mode: "LIVE" | "SIMULATION" = "LIVE"): ActivityItem[] {
  const rows: Array<[number, string, string, string | null, Record<string, unknown> | null]> = [
    [58, "agent:hosted", "run.started", "被唤醒：委托完成后的第一轮", { reason: "authorized" }],
    [57, "agent:hosted", "agent.tool", "读取决策上下文", { tool: "get_turn_context" }],
    [57, "agent:hosted", "agent.tool", "查询事件日历：非农 22:30 发布", { tool: "get_events" }],
    [56, "agent:hosted", "agent.tool", "询价 AAPLx（2 USDG）", { tool: "get_executable_quotes" }],
    [55, "agent:hosted", "intent.submitted", "买入 AAPLx 2 USDG：报价冲击 0.2%，数据前先建一小笔", { side: "buy" }],
    ...(mode === "LIVE" ? [
      [55, "system", "intent.certified", "四道核验通过，步骤证书已签发", null],
      [54, "executor:hosted", "job.sent", "交易已发出", { state: "SENT" }],
      [53, "executor:hosted", "job.confirmed", "成交确认", { state: "CONFIRMED" }],
    ] as Array<[number, string, string, string | null, Record<string, unknown> | null]> : []),
    [52, "agent:hosted", "agent.status", "等待：非农实际值未到，下次检查 22:35", { status: "waiting", waitingData: true }],
    [16, "agent:hosted", "run.started", "被唤醒：到达自定的检查时刻", { reason: "scheduled" }],
    [15, "agent:hosted", "agent.tool", "查询事件：非农实际值尚未入库", { tool: "get_events" }],
    [14, "agent:hosted", "agent.status", "继续等待：数据未到不交易", { status: "waiting", waitingData: true }],
  ];
  return rows.map(([m, actor, type, note, data], i) => ({ id: i + 1, at: iso(m), actor, type, note, data }));
}

export function fxRuns(mode: "LIVE" | "SIMULATION" = "LIVE"): AgentRunSummary[] {
  const base = { taskId: "tsk_fixture", attempt: 1, mode, model: "fixture-model", promptHash: H("1"), usage: { inputTokens: 18_200, outputTokens: 900, cacheReadTokens: 12_000, costUsdMicros: "61000" } } as const;
  return [
    { ...base, runId: "run_fx_2", turnVersion: 2, turnReason: "scheduled", startedAt: iso(16), endedAt: iso(14), state: "COMPLETED", action: { kind: "status", ref: "st_fx_2", status: "waiting" }, decisionSummary: "非农实际值还没入库；数据未到不交易，22:35 再看。", nextCheckAt: new Date(now + 26 * 60_000).toISOString(), invalidation: "实际值显著低于上期且报价冲击 > 1% 时放弃第二笔。", toolCalls: [{ name: "get_turn_context", argsHash: H("2"), resultHash: H("3") }, { name: "get_events", argsHash: H("4"), resultHash: H("5") }], prevRunHash: H("6"), runHash: H("7") },
    { ...base, runId: "run_fx_1", turnVersion: 1, turnReason: "authorized", startedAt: iso(58), endedAt: iso(55), state: "COMPLETED", action: { kind: "intent", ref: "int_fx_1", status: mode === "LIVE" ? "executed" : "simulated" }, decisionSummary: "数据前先用 2 USDG 建一小笔 AAPLx，其余等非农实际值。", nextCheckAt: iso(-30), invalidation: null, toolCalls: [{ name: "get_turn_context", argsHash: H("8"), resultHash: H("9") }, { name: "get_events", argsHash: H("a"), resultHash: H("b") }, { name: "get_executable_quotes", argsHash: H("c"), resultHash: H("d") }, { name: "submit_trade_intent", argsHash: H("e"), resultHash: H("f") }], prevRunHash: null, runHash: H("6") },
  ];
}

export function fxRunSteps(runId: string): AgentRunStep[] {
  const t = (s: number) => new Date(now - 58 * 60_000 + s * 1000).toISOString();
  if (runId === "run_fx_2") return [
    { seq: 1, kind: "tool", name: "get_turn_context", argsPreview: "{}", resultPreview: "turn 2 · scheduled · blockers: []", latencyMs: 210, at: t(2520) },
    { seq: 2, kind: "tool", name: "get_events", argsPreview: "{\"kind\":\"MACRO_TIER1\"}", resultPreview: "NFP · dataStatus=due_pending_data", latencyMs: 180, at: t(2522) },
    { seq: 3, kind: "model", tokensIn: 9100, tokensOut: 420, latencyMs: 5200, at: t(2528) },
  ];
  return [
    { seq: 1, kind: "tool", name: "get_turn_context", argsPreview: "{}", resultPreview: "turn 1 · authorized", latencyMs: 230, at: t(2) },
    { seq: 2, kind: "tool", name: "get_events", argsPreview: "{\"kind\":\"MACRO_TIER1\"}", resultPreview: "NFP 22:30 · upcoming", latencyMs: 190, at: t(4) },
    { seq: 3, kind: "tool", name: "get_executable_quotes", argsPreview: "{\"items\":[{\"side\":\"buy\",\"assetKey\":\"AAPLx\"}]}", resultPreview: "impact 20 bps · session US_REGULAR", latencyMs: 1400, at: t(7) },
    { seq: 4, kind: "model", tokensIn: 9100, tokensOut: 480, latencyMs: 6100, at: t(14) },
    { seq: 5, kind: "tool", name: "submit_trade_intent", argsPreview: "{\"kind\":\"buy\"}", resultPreview: "certified", latencyMs: 2100, at: t(17) },
  ];
}

export function fxPositions(): TaskPosition[] {
  return [{ assetKey: FX_AAPLX, boughtRaw: "8650000000000000", soldRaw: "0", netRaw: "8650000000000000", onchainRaw: "8650000000000000", sellableRaw: "8650000000000000", avgCostUsd: "231.12", coverage: { coverageBps: 10_000 } }];
}

export function fxOwnerAllowances(): OwnerAllowancesView {
  return { owner: FX_OWNER, spender: FX_PLANGUARD, allowances: [
    { token: tok(FX_USDG), assetKey: FX_USDG, onchainRaw: "12060000", requiredRaw: "8000000", excessRaw: "4060000", pendingPermit: false },
    { token: tok(FX_AAPLX), assetKey: FX_AAPLX, onchainRaw: "87435000000000000", requiredRaw: "87000000000000000", excessRaw: "435000000000000", pendingPermit: true },
  ] };
}

export function fxPublicActivity(): PublicActivityView {
  return { shareId: "shr_fixture", generatedAt: new Date(now).toISOString(), presence: "waiting", mode: "LIVE", items: [
    { at: iso(58), category: "research" }, { at: iso(56), category: "quote" }, { at: iso(55), category: "intent_buy" }, { at: iso(54), category: "tx_sent" },
    { at: iso(53), category: "fill_confirmed" }, { at: iso(52), category: "waiting_data" }, { at: iso(16), category: "research" }, { at: iso(14), category: "waiting_data" },
  ].reverse() };
}

/** 夜班（R4 数据形状的假设，见 components/agent/journal/AgentNight.tsx） */
export interface AgentNightView {
  date: string;
  mode: "LIVE" | "SIMULATION" | "FIXTURE";
  runs: number;
  fills: { buy: number; sell: number };
  costUsdMicros: string;
  sections: { looked: string[]; did: string[]; skipped: string[]; next: string[] };
  /** event 给了就按「故障 / 恢复」两类事件显示（Lane R 的 faults / recoveries 不配对）；没给则看 recovered */
  faults: Array<{ at: string; kind: string; text: string; recovered: boolean; event?: "fault" | "recovery" }>;
}
export function fxAgentNight(): AgentNightView {
  return {
    date: "2026-10-05",
    mode: "FIXTURE",
    runs: 7,
    fills: { buy: 2, sell: 1 },
    costUsdMicros: "412000",
    sections: {
      looked: ["非农实际值与上期修订", "AAPLx / NVDAx 的 100 USDG 档报价与冲击", "常规时段开盘后的参考价偏差"],
      did: ["数据前买入 AAPLx 一小笔", "数据到达后加仓 NVDAx 一笔", "理由失效后减仓本任务买入的 AAPLx 一半"],
      skipped: ["开盘前 15 分钟报价冲击 > 1%，没有追", "第二份报价与参考价偏差过大，放弃加仓"],
      next: ["周二 CPI 前不再加仓", "NVDAx 若跌破本任务均价 3% 重新评估"],
    },
    faults: [
      { at: "2026-10-06T00:41:00.000Z", kind: "cert_void", text: "证书在发送前作废 → 自动重签一次 → 成交一次", recovered: true },
      { at: "2026-10-06T02:12:00.000Z", kind: "rpc_timeout", text: "广播后节点超时 → 按交易哈希找回，没有重发", recovered: true },
    ],
  };
}

/** 任务页 fixture：目标式买入任务（托管 Agent + 平台执行，允许减仓 AAPLx / NVDAx） */
export function fxTaskView(mode: "LIVE" | "SIMULATION" = "LIVE"): TaskCreated & Record<string, unknown> {
  const t0 = iso(70);
  const deadline = new Date(now + 10 * 86_400_000).toISOString();
  const task = {
    id: "tsk_fixture", owner: FX_OWNER, playbookId: "agent_goal", status: "ACTIVE", blockers: [], nextCheckAt: null,
    mandateIds: mode === "LIVE" ? ["mdt_fx_buy"] : [], executorPresence: "offline", createdAt: t0, updatedAt: iso(14),
    conditions: { version: "conditions/1", items: [], hash: H("0") },
    goal: { ownerAddress: FX_OWNER, recipientAddress: FX_OWNER, executionChainId: 196, legs: [{ outputAssetKey: FX_AAPLX, weightBps: 10000 }], budget: { inputAssetKeys: [FX_USDG], amountInRaw: "2000000" }, side: "buy", policyId: "QUOTE_ONLY", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: 100, deadline },
    scope: { version: "scope/1", objective: "未来一周，在非农前后寻找加仓 AAPLx / NVDAx 的机会；理由失效时减掉本任务买入的部分。", inputAssetKey: FX_USDG, outputAssetKeys: [FX_AAPLX, FX_NVDAX], budgetCapRaw: "10000000", perStepCapRaw: "2000000", maxSteps: 5, deadline, allowSell: true, trustTier: "agent_data", issuance: "agent", hardConditions: [] },
  } as unknown as TaskCreated["task"];
  return {
    task, mandateDraft: null, thesisDraft: null, budgetAllocation: null, mode, params: { policyId: "QUOTE_ONLY", maxPriceImpactBps: 100 },
    mandates: mode === "LIVE" ? [{ mandateId: "mdt_fx_buy", state: "ACTIVE", current: true, spent: "2000000", stepsDone: 1, maxSteps: 5, deadline }] : [],
    timeline: [],
    runtime: fxRuntime("waiting", mode),
    delegation: mode === "LIVE" ? { counts: { signaturesNeeded: 6, signaturesDone: 6, userTransactions: 0 }, complete: true } : null,
    positions: mode === "LIVE" ? fxPositions() : [],
    steps: { planned: 5, confirmed: mode === "LIVE" ? 1 : 0, lastConfirmedAt: null },
    stepsV7: { buy: { planned: 5, confirmed: mode === "LIVE" ? 1 : 0 }, sell: { confirmed: 0 } },
  } as unknown as TaskCreated & Record<string, unknown>;
}
