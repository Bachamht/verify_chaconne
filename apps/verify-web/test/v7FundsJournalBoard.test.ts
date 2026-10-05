/**
 * P-05 资金页额度 · P-06 夜班四段 + 成本 + 故障与恢复 · P-07 公开看板只有类别与时间。
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AllowanceSection, excessOf } from "../components/agent/funds/AllowanceSection";
import { AgentNight, agentNightOf } from "../components/agent/journal/AgentNight";
import { AgentWatchBoard, boardLabel, presenceLabel } from "../components/live/AgentWatchBoard";
import { normalizePublicActivity } from "../lib/api-v2";
import { fxAgentNight, fxPublicActivity } from "../lib/v7fixtures";
import type { AssetEntry } from "../lib/assets";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale: "zh", t: (key: string) => key }) }));

const assets = [
  { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", executionAllowed: true, underlyingId: "usd:USDG" },
  { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output", executionAllowed: true, underlyingId: "equity:AAPL" },
] as AssetEntry[];

describe("P-05 · 资金页额度", () => {
  it("差额：服务端给 excessRaw 用它，否则 onchain − required，不为负", () => {
    expect(excessOf({ onchainRaw: "12060000", requiredRaw: "8000000" })).toBe(4060000n);
    expect(excessOf({ onchainRaw: "1", requiredRaw: "8" })).toBe(0n);
    expect(excessOf({ onchainRaw: "9", requiredRaw: "8", excessRaw: "5" })).toBe(5n);
  });
  it("fixture：每个代币显示链上额度、需要、多出、在途 permit；两种收回入口；风险说明", () => {
    const html = renderToStaticMarkup(React.createElement(AllowanceSection, { owner: "0x0000000000000000000000000000000000000001", assets, fixture: true }));
    for (const t of ["给 PlanGuard 的额度", "USDG", "AAPLx", "链上额度", "需要", "多出", "12.06", "4.06", "有一份额度正在上链", "收回多余额度（签名）", "自己发 approve(0)（交易，你付 gas）", "过期的授权会被合约拒绝"]) expect(html).toContain(t);
    expect(html).toContain('id="allowances"');
  });
  it("Funds 只在 V7_UI 时挂额度段", () => {
    const src = readFileSync(join(__dirname, "..", "components/agent/funds/Funds.tsx"), "utf8");
    expect(src).toContain("{V7_UI && <AllowanceSection");
  });
});

describe("P-06 · 夜班日志", () => {
  it("四段 + 轮次 + 成交 + 成本 + 故障与恢复", () => {
    const html = renderToStaticMarkup(React.createElement(AgentNight, { recap: null, fixture: true }));
    for (const t of ["看了什么", "做了什么", "为什么没做", "下一步观察什么", "轮次", "成交", "模型成本", "$0.41", "故障与恢复", "cert_void", "已恢复", "ag_mode_fixture"]) expect(html).toContain(t);
  });
  it("recap 没有 agent 字段 → 说明还没接入，示例折叠并标 FIXTURE", () => {
    const html = renderToStaticMarkup(React.createElement(AgentNight, { recap: { id: "r", date: "2026-10-05" } as never }));
    expect(html).toContain("夜班数据还没有接入");
    expect(html).toContain("<details");
    expect(html).toContain("FIXTURE");
  });
  it("recap.agent 归一化", () => {
    const n = agentNightOf({ date: "2026-10-05", agent: { ...fxAgentNight(), mode: "LIVE", runs: "3", faults: [{ kind: "rpc_timeout", recovered: true }] } });
    expect(n?.runs).toBe(3);
    expect(n?.mode).toBe("LIVE");
    expect(n?.faults[0]).toMatchObject({ kind: "rpc_timeout", recovered: true });
    expect(agentNightOf({ date: "x" })).toBeNull();
  });
});

describe("P-07 · 公开值守看板只有类别与时间", () => {
  it("标签来自固定表；未知类别 → 其它活动；原始字符串永不上屏", () => {
    expect(boardLabel("intent_buy", "zh")).toBe("提交买入意图");
    expect(boardLabel("fill_confirmed", "zh")).toBe("成交确认");
    expect(boardLabel("waiting_data", "zh")).toBe("等待：实际值未到");
    expect(boardLabel("research", "zh")).toBe("研究中");
    expect(boardLabel("bought 100 USDG of AAPLx for 0xabc", "zh")).toBe("其它活动");
    expect(presenceLabel("waiting", "zh")).toBe("在等待");
    expect(presenceLabel("<img>", "zh")).toBeNull();
  });
  it("服务端多给的字段在归一化时就丢掉", () => {
    const v = normalizePublicActivity({ shareId: "s", presence: "working", items: [{ at: "2026-10-05T23:40:00.000Z", category: "intent_buy", amountInRaw: "2000000", qty: "0.0086", owner: "0x00000000000000000000000000000000000000aa", txHash: "0xdead", note: "bought AAPLx" }] });
    expect(Object.keys(v!.items[0]!)).toEqual(["at", "category"]);
  });
  it("fixture 渲染：没有金额、数量、地址、代币符号或自由文本", () => {
    const html = renderToStaticMarkup(React.createElement(AgentWatchBoard, { shareId: "shr_fixture" }));
    // SSR 首帧（无 window）是加载态；直接渲染 fixture 列表检查文字
    expect(html).toContain("值守看板");
    const labels = fxPublicActivity().items.map((x) => boardLabel(x.category, "zh"));
    for (const l of labels) expect(l).not.toMatch(/\d|0x|USDG|AAPLx|NVDAx/);
    expect(labels).toContain("提交买入意图");
  });
  it("路由在开关关闭时 404", () => {
    const src = readFileSync(join(__dirname, "..", "app/live/agent/[shareId]/page.tsx"), "utf8");
    expect(src).toContain("if (!V7_UI) notFound();");
  });
});
