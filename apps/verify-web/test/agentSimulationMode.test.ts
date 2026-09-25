import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskForm } from "../components/agent/tasks/TaskForm";
import { FirstMinuteTaskResult } from "../components/agent/home/FirstMinute";
import type { TaskCreated } from "../lib/api-v2";
import type { AssetEntry } from "../lib/assets";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale: "en", t: (key: string) => key }) }));

const assets = [
  { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", executionAllowed: true, underlyingId: "usd:USDG" },
  { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output", executionAllowed: true, underlyingId: "equity:AAPL" },
] as AssetEntry[];
const owner = "0x0000000000000000000000000000000000000001";
const time = "2026-09-25T01:00:00.000Z";
const task: TaskCreated["task"] = {
  id: "tsk_result", owner, playbookId: "session_dca", status: "ACTIVE", blockers: [], nextCheckAt: null,
  mandateIds: [], executorPresence: "offline", createdAt: time, updatedAt: time,
  conditions: { version: "conditions/1", items: [], hash: `0x${"0".repeat(64)}` },
  goal: {
    ownerAddress: owner, recipientAddress: owner, executionChainId: 196, legs: [{ outputAssetKey: assets[1]!.assetKey, weightBps: 10000 }],
    budget: { inputAssetKeys: [assets[0]!.assetKey], amountInRaw: "3000000" }, side: "buy", policyId: "REFERENCE_CONTEXT", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: null, deadline: time,
  },
};

describe("模拟入口与真实任务模式边界", () => {
  it.each(["discount_watch", "session_dca"] as const)("%s 的两次计划显示每次 15 和累计上限 30，不因 amountRaw 参数名而把 15 当总额", (playbookId) => {
    const html = renderToStaticMarkup(React.createElement(TaskForm, { assets, preset: { playbookId, steps: 2, perStepHuman: "15" } }));
    expect(html).toContain("ag_f_per_step");
    expect(html).toContain('value="15"');
    expect(html).toContain("Up to 2 steps, 30 USDG maximum in total");
    expect(html).not.toContain("ag_f_amount_total");
    expect(html).not.toContain("15 USDG maximum in total");
  });

  it("单次折价观察保留单次金额说明，未完成的非整数步数不会计算错误预算或使组件崩溃", () => {
    const single = renderToStaticMarkup(React.createElement(TaskForm, { assets, preset: { playbookId: "discount_watch", steps: 1, perStepHuman: "15" } }));
    expect(single).toContain("ag_f_amount_total");
    expect(single).not.toContain("maximum in total");
    const incomplete = renderToStaticMarkup(React.createElement(TaskForm, { assets, preset: { playbookId: "discount_watch", steps: 1.5, perStepHuman: "15" } }));
    expect(incomplete).toContain("— maximum in total");
  });

  it("锁定入口即使收到 LIVE 预填仍显示模拟创建，且不提供实盘切换", () => {
    const html = renderToStaticMarkup(React.createElement(TaskForm, { assets, modeLock: "SIMULATION", preset: { mode: "LIVE" } }));
    expect(html).toContain("ag_create_sim");
    expect(html).not.toContain("ag_create_live");
    expect(html).not.toContain('value="LIVE"');
    expect(html).not.toContain("ag_mode_live");
  });

  it("其它入口仍保留 LIVE 选择和授权钱包提示", () => {
    const html = renderToStaticMarkup(React.createElement(TaskForm, { assets, preset: { mode: "LIVE" } }));
    expect(html).toContain("ag_create_live");
    expect(html).toContain('value="LIVE"');
    expect(html).toContain("owner wallet to sign");
  });

  it.each([
    ["SIMULATION", "ag_mode_sim", "No trade certificate is signed"],
    ["LIVE", "ag_mode_live", "Creation does not mean authorization or execution"],
    [undefined, "unknown", "did not return a task mode"],
  ] as const)("结果按响应 %s 标识，不把任务创建成功当作成交", (mode, label, explanation) => {
    const value: TaskCreated = { task, mandateDraft: null, thesisDraft: null, budgetAllocation: null, ...(mode ? { mode } : {}) };
    const html = renderToStaticMarkup(React.createElement(FirstMinuteTaskResult, { value }));
    expect(html).toContain(label);
    expect(html).toContain(explanation);
    expect(html).toContain('href="/agent/tasks/tsk_result"');
    if (mode !== "SIMULATION") expect(html).not.toContain("ag_mode_sim");
    if (mode !== "LIVE") expect(html).not.toContain("ag_mode_live");
  });
});
