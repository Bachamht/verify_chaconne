/**
 * P-03 / P-04 · 任务页 v7：四问卡每一问有数据来源、「没有需要你处理的事」空态；活动流 3 s / 10 s / 隐藏即停；
 * 活动类别归类（公开看板只用类别）；开关关闭时 v7 组件不挂载。
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostedAgentState, TaskRuntime } from "@chaconne/core/verify";
import { activityCategory, budgetUsage, isBusy, mergeActivity, pollIntervalMs, POLL_FAST_MS, POLL_SLOW_MS, presenceKey, sortNeedsOwner } from "../components/agent/tasks/v7/runtimeModel";
import { FourQuestions } from "../components/agent/tasks/v7/FourQuestions";
import { TaskConsoleV7 } from "../components/agent/tasks/v7/TaskConsoleV7";
import { RunModelUsage } from "../components/agent/tasks/v7/RunList";
import { fxActivity, fxPositions, fxRuntime, fxTaskView } from "../lib/v7fixtures";
import { V7_UI, v7FixtureRequested } from "../lib/v7";
import type { AssetEntry } from "../lib/assets";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
let locale: "zh" | "en" = "zh";
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale, t: (key: string) => key }) }));

const assets = [
  { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", executionAllowed: true, underlyingId: "usd:USDG" },
  { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output", executionAllowed: true, underlyingId: "equity:AAPL" },
] as AssetEntry[];

const rt = (over: Partial<TaskRuntime> = {}): TaskRuntime => ({ ...fxRuntime("waiting"), ...over });
const hostedRuntime = (state: HostedAgentState): TaskRuntime => rt({ presence: { mode: "hosted", state, currentActivity: null, waitingFor: null, lastDecisionAt: null, nextCheckAt: null } });

describe("P-04 · 轮询间隔", () => {
  it("轮次进行中 / 等成交 / 执行在发送 → 3 s；其它 → 10 s；页面隐藏 → 停", () => {
    expect(pollIntervalMs(fxRuntime("working"), false)).toBe(POLL_FAST_MS);
    expect(pollIntervalMs(fxRuntime("awaiting_fill"), false)).toBe(3000);
    expect(pollIntervalMs(rt({ executor: { mode: "hosted", state: "busy", address: null, lastJobAt: null } }), false)).toBe(3000);
    expect(pollIntervalMs(fxRuntime("waiting"), false)).toBe(POLL_SLOW_MS);
    expect(pollIntervalMs(null, false)).toBe(10_000);
    expect(pollIntervalMs(fxRuntime("working"), true)).toBeNull();
    expect(isBusy(null)).toBe(false);
  });
  it("活动流钩子监听 visibilitychange，隐藏时不排下一次", () => {
    const src = readFileSync(join(__dirname, "..", "components/agent/tasks/v7/useActivityFeed.ts"), "utf8");
    expect(src).toContain("visibilitychange");
    expect(src).toContain("pollIntervalMs(runtime, hidden)");
    expect(src).toMatch(/intervalMs === null/);
  });
  it("增量合并按 id 去重、按时间排序", () => {
    const a = fxActivity();
    const merged = mergeActivity(a.slice(0, 5), a.slice(3));
    expect(merged.map((x) => x.id)).toEqual(a.map((x) => x.id));
  });
});

describe("活动类别", () => {
  it("fixture 时间线归到看板类别", () => {
    const cats = fxActivity("LIVE").map(activityCategory);
    expect(cats).toEqual(["research", "research", "research", "quote", "intent_buy", "certified", "tx_sent", "fill_confirmed", "waiting_data", "research", "research", "waiting_data"]);
  });
  it("服务端给了 data.category 就用；认不出 → other", () => {
    expect(activityCategory({ type: "whatever", actor: "system", data: { category: "fill_confirmed" } })).toBe("fill_confirmed");
    expect(activityCategory({ type: "zzz", actor: "system", data: { category: "not_a_category" } })).toBe("other");
    expect(activityCategory({ type: "job.failed", actor: "executor:hosted", data: { state: "EXPIRED" } })).toBe("exec_failed");
    expect(activityCategory({ type: "task.recertified", actor: "system", data: null })).toBe("recovered");
    expect(activityCategory({ type: "intent.submitted", actor: "agent:hosted", data: { side: "sell" } })).toBe("intent_sell");
    expect(activityCategory({ type: "agent.status", actor: "agent:hosted", data: { status: "ended" } })).toBe("ended");
  });
  it("presence 文案键", () => {
    expect(presenceKey(null)).toBe("pres_none");
    expect(presenceKey({ mode: "byo", state: "online", lastResponseAt: null, nextCheckAt: null })).toBe("pres_online");
    expect(presenceKey(fxRuntime("working").presence)).toBe("pres_working");
  });
  it("待办阻塞在前；预算已用 / 剩余", () => {
    expect(sortNeedsOwner([{ blocking: false, n: 1 }, { blocking: true, n: 2 }]).map((x) => x.n)).toEqual([2, 1]);
    expect(budgetUsage("10000000", "2000000")).toEqual({ used: "2000000", left: "8000000" });
    expect(budgetUsage("10", "12")).toEqual({ used: "12", left: "0" });
    expect(budgetUsage(null, "1")).toBeNull();
  });
});

describe("P-03 · 四问卡", () => {
  const base = { delegationCounts: { signaturesNeeded: 6, signaturesDone: 6 }, delegationComplete: true, fills: { buy: 1, sell: 0, planned: 5, latest: { txHash: `0x${"a".repeat(64)}` } }, positions: fxPositions(), budget: { capRaw: "10000000", spentRaw: "2000000", decimals: 6, symbol: "USDG" }, assets, sim: false, onAction: () => undefined };
  it("四问都在，各自有数据；没有待办时明确写「没有需要你处理的事」", () => {
    locale = "zh";
    const html = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime: fxRuntime("waiting") }));
    for (const q of ["它接手了吗", "现在在做什么", "已经做成什么", "需要我处理什么"]) expect(html).toContain(q);
    expect(html).toContain("Chaconne Agent · 在等待");
    expect(html).toContain("平台执行 · 就绪");
    expect(html).toContain("已完成");
    expect(html).toContain("非农实际值发布后的第一份报价");
    expect(html).toContain("买 1 笔 · 卖 0 笔（计划最多买 5 笔）");
    expect(html).toContain("AAPLx");
    expect(html).toContain("已用 2 USDG · 剩余 8 USDG");
    expect(html).toContain("没有需要你处理的事。");
  });
  it("working 时显示当前工具的人话；有待办时列出并给按钮；平台事项不算你的待办", () => {
    const runtime = rt({ ...fxRuntime("working"), needsOwner: [{ code: "reclaim_allowance", blocking: false, text: { zh: "任务结束后链上额度多出 4.06 USDG", en: "4.06 USDG extra allowance" }, action: { kind: "reclaim_allowance" } }, { code: "allowance_low", blocking: true, text: { zh: "额度不足，签一份新额度", en: "allowance low" }, action: { kind: "sign_permit", itemId: "permit:0x1" } }], needsOperator: ["executor_gas_low"] });
    const html = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime }));
    expect(html).toContain("询价 NVDAx（100 USDG 档）");
    expect(html).not.toContain("没有需要你处理的事");
    expect(html.indexOf("额度不足")).toBeLessThan(html.indexOf("链上额度多出"));
    expect(html).toContain("签一份新额度");
    expect(html).toContain("收回多余额度");
    expect(html).toContain("平台在处理：执行身份 gas 不足（不需要你操作）");
  });
  it("英文", () => {
    locale = "en";
    const html = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime: fxRuntime("waiting") }));
    expect(html).toContain("Has it taken over?");
    expect(html).toContain("Nothing needs your attention.");
    locale = "zh";
  });
  it("运行态、金额与模式缺失时不推断已接手、无待办或花费为零", () => {
    locale = "zh";
    const html = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime: null, delegationCounts: null, delegationComplete: null, modeKnown: false, fills: { buy: null, sell: null, planned: 5, latest: null }, positions: null, budget: { ...base.budget, spentRaw: null } }));
    expect(html).toContain("等待运行状态");
    expect(html).toContain("needs-unknown");
    expect(html).toContain("模式待确认");
    expect(html).toContain("成交记录待获取");
    expect(html).toContain("已用与剩余预算待获取");
    for (const guess of ["没有需要你处理的事", "还没有 Agent 接手", "已用 0", "还没有成交", 'data-tone="active"', "真实资金任务"]) expect(html).not.toContain(guess);
  });
  it.each(["paused", "ended", "blocked_owner", "blocked_operator"] as const)("%s 不标为正在值守", (state) => {
    const html = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime: hostedRuntime(state) }));
    expect(html).not.toContain('data-tone="active"');
  });
  it("有明确零值时仍显示零；币种精度未知时不猜金额", () => {
    const knownZero = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime: fxRuntime("waiting"), budget: { ...base.budget, spentRaw: "0" } }));
    expect(knownZero).toContain("已用 0 USDG · 剩余 10 USDG");
    const unknownDecimals = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime: fxRuntime("waiting"), assets: [], budget: { ...base.budget, decimals: null } }));
    expect(unknownDecimals).toContain("已用与剩余预算待获取");
    expect(unknownDecimals).toContain("数量待确认");
    expect(unknownDecimals).not.toContain("已用 2");
  });
  it("平台费用拦截与未完成委托并存时同时解释责任，保留原动作", () => {
    const runtime = rt({ ...hostedRuntime("blocked_owner"), needsOwner: [{ code: "delegation_incomplete", blocking: true, text: { zh: "委托未完成", en: "Delegation incomplete" }, action: { kind: "sign_delegation" } }], needsOperator: ["fee_budget_exhausted"] });
    const html = renderToStaticMarkup(React.createElement(FourQuestions, { ...base, runtime, delegationComplete: false, delegationCounts: { signaturesDone: 5, signaturesNeeded: 6 } }));
    expect(html).toContain("平台费用拦截无需重复签名");
    expect(html).toContain("委托未完成");
    expect(html).toContain("继续委托签名");
    expect(html).not.toContain('data-tone="active"');
    expect(html.indexOf("平台费用拦截")).toBeLessThan(html.indexOf("委托未完成"));
  });
});

describe("轮次模型成本", () => {
  it("缺失成本和 token 数不显示成零，明确是成本记录而非用户账单", () => {
    locale = "zh";
    const html = renderToStaticMarkup(React.createElement(RunModelUsage, {}));
    expect(html).toContain("模型成本");
    expect(html).toContain("未提供");
    expect(html).toContain("非用户账单");
    expect(html).toContain("输入 — / 输出 —");
    expect(html).not.toContain("$0.00");
  });
  it("服务明确提供的零成本仍显示零，英文保留成本边界", () => {
    locale = "en";
    const html = renderToStaticMarkup(React.createElement(RunModelUsage, { usage: { costUsdMicros: "0", inputTokens: 0, outputTokens: 0 } }));
    expect(html).toContain("$0.00");
    expect(html).toContain("Model cost");
    expect(html).toContain("not a user bill");
    expect(html).toContain("in 0 / out 0");
    locale = "zh";
  });
  it.each(["", "not-reported", "-1"])("无效成本 %s 显示未提供", (costUsdMicros) => {
    const html = renderToStaticMarkup(React.createElement(RunModelUsage, { usage: { costUsdMicros } }));
    expect(html).toContain("未提供");
    expect(html).not.toContain("$");
  });
});

describe("P-03 · 运行台（fixture）", () => {
  it("LIVE：四问卡、活动流、轮次、持仓、接管、控制（含收回额度与公开看板）", () => {
    const v = fxTaskView("LIVE");
    const html = renderToStaticMarkup(React.createElement(TaskConsoleV7, { id: "tsk_fixture", view: v, fills: [], assets, stable: assets[0]!, fixture: true, onToast: () => undefined, onReload: () => undefined, controls: { pending: null, stoppable: true, paused: false, onPause: () => undefined, onResume: () => undefined, onCancel: () => undefined, onDelete: () => undefined, revokeSlot: null } }));
    for (const t of ["four-questions", "活动流", "轮次记录", "本任务持仓", "谁来决策、谁来执行", "暂停", "取消", "收回额度", "生成公开值守看板", "被唤醒：委托完成后的第一轮", "成交确认"]) expect(html).toContain(t);
    expect(html).not.toContain("sim-badge");
    expect(html).toContain("平台执行：暂停在交易发送前生效");
  });
  it("SIMULATION：活动流标 SIMULATION，不显示委托与执行选择", () => {
    const v = fxTaskView("SIMULATION");
    const html = renderToStaticMarkup(React.createElement(TaskConsoleV7, { id: "tsk_fixture", view: v, fills: [], assets, stable: assets[0]!, fixture: true, onToast: () => undefined, onReload: () => undefined, controls: { pending: null, stoppable: true, paused: false, onPause: () => undefined, onResume: () => undefined, onCancel: () => undefined, onDelete: () => undefined, revokeSlot: null } }));
    expect(html).toContain("sim-badge");
    expect(html).toContain("SIMULATION · 观察模式");
    expect(html).not.toContain("委托 Chaconne Agent");
    expect(html).not.toContain("浏览器逐笔");
  });
  it("缺少 v7 字段的真实响应保留控制和记录入口，不捏造预算与完成状态", () => {
    locale = "zh";
    const v = { ...fxTaskView("LIVE"), runtime: null, mode: undefined, steps: undefined, stepsV7: undefined, mandates: undefined, delegation: null, positions: null };
    const html = renderToStaticMarkup(React.createElement(TaskConsoleV7, { id: "tsk_legacy", view: v, fills: [], assets, stable: null, fixture: false, onToast: () => undefined, onReload: () => undefined, controls: { pending: null, stoppable: false, paused: true, onPause: () => undefined, onResume: () => undefined, onCancel: () => undefined, onDelete: () => undefined, revokeSlot: React.createElement("button", null, "链上撤销"), legacyAuthorizeSlot: React.createElement("button", null, "旧版授权") } }));
    for (const t of ["任务模式尚未返回", "needs-unknown", "成交记录待获取", "已用与剩余预算待获取", "恢复", "取消", "链上撤销", "旧版授权", "收回额度", "生成公开值守看板", "删除", 'href="#v7-activity"', 'href="#v7-assets"', 'href="#v7-controls"', "轮次记录"]) expect(html).toContain(t);
    expect(html).not.toContain("已用 0");
    expect(html).not.toContain("没有需要你处理的事");
    expect(html).not.toContain(">真实资金任务</span>");
    expect(html).toContain("当前决策与执行配置还未确认");
    expect(html.match(/<fieldset[^>]*disabled=""/g)).toHaveLength(2);
  });
  it("步骤响应只有 buy 时仍可显示买入数，卖出不补零", () => {
    const v = { ...fxTaskView("LIVE"), stepsV7: { buy: { planned: 5, confirmed: 2 } } };
    const html = renderToStaticMarkup(React.createElement(TaskConsoleV7, { id: "tsk_partial", view: v, fills: [], assets, stable: assets[0]!, fixture: false, onToast: () => undefined, onReload: () => undefined, controls: { pending: null, stoppable: true, paused: false, onPause: () => undefined, onResume: () => undefined, onCancel: () => undefined, onDelete: () => undefined, revokeSlot: null } }));
    expect(html).toContain("买 2 笔 · 卖 — 笔");
    expect(html).not.toContain("卖 0 笔");
  });
});

describe("开关", () => {
  it("NEXT_PUBLIC_V7_UI 缺省关闭；关闭时 fixture 也不生效", () => {
    expect(process.env.NEXT_PUBLIC_V7_UI ?? "0").toBe("0");
    expect(V7_UI).toBe(false);
    expect(v7FixtureRequested("?v7fixture=1")).toBe(false);
  });
  it("TaskDetail 只在 V7_UI 时挂运行台，旧布局原样保留在后面", () => {
    const src = readFileSync(join(__dirname, "..", "components/agent/tasks/TaskDetail.tsx"), "utf8");
    const i = src.indexOf("if (V7_UI) {");
    expect(i).toBeGreaterThan(0);
    expect(src.indexOf("<TaskConsoleV7")).toBeGreaterThan(i);
    // 旧布局（动作卡）仍在 V7 分支之后
    expect(src.lastIndexOf('<Card title={zh ? "动作" : "Actions"}>')).toBeGreaterThan(src.indexOf("<TaskConsoleV7"));
  });
});
