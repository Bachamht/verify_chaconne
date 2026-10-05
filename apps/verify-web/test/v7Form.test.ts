/**
 * P-10 · 建任务表单：Agent 选择、执行选择（平台执行推荐）、允许减仓、「需要签名 n 次、交易 0 笔」预览、非白名单钱包提示。
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModeChoice } from "../components/agent/tasks/v7/ModeChoice";

vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale: "zh", t: (key: string) => key }) }));

const render = (p: Partial<React.ComponentProps<typeof ModeChoice>>) => renderToStaticMarkup(React.createElement(ModeChoice, { value: { agent: "hosted", executor: "hosted", allowSell: false }, onChange: () => undefined, live: true, assetCount: 2, hostedClosed: false, onUseSimulation: () => undefined, ...p }));

describe("P-10 · 模式选择与签名数预览", () => {
  it("LIVE：两种 Agent、三种执行（平台执行标推荐）、只买 → 签名 2 次、交易 0 笔", () => {
    const html = render({});
    expect(html).toContain("Chaconne Agent（托管，平台运行）");
    expect(html).toContain("我自己的 Agent（MCP / API）");
    expect(html).toContain("平台执行（推荐）");
    expect(html).toContain("我的 Agent 钱包（MCP）");
    expect(html).toContain("浏览器逐笔");
    expect(html).toContain("需要签名 2 次、交易 0 笔");
  });
  it("允许减仓 + 2 只股票 → 6 次；1 只 → 4 次", () => {
    expect(render({ value: { agent: "hosted", executor: "hosted", allowSell: true } })).toContain("需要签名 6 次、交易 0 笔");
    expect(render({ value: { agent: "hosted", executor: "hosted", allowSell: true }, assetCount: 1 })).toContain("需要签名 4 次、交易 0 笔");
  });
  it("SIMULATION：不显示执行选择与签名预览", () => {
    const html = render({ live: false });
    expect(html).not.toContain("浏览器逐笔");
    expect(html).not.toContain("sig-preview");
  });
  it("非白名单钱包：托管运行暂未开放，可先用观察模式（附切换按钮）", () => {
    const html = render({ hostedClosed: true });
    expect(html).toContain("托管运行暂未开放，可先用观察模式。");
    expect(html).toContain("改用观察模式（模拟）");
  });
  it("GoalTaskForm 只在 V7_UI 时挂选择块、把 agent / executor / allowSell 放进请求体；403 hosted_not_allowed 显示提示", () => {
    const src = readFileSync(join(__dirname, "..", "components/agent/tasks/GoalTaskForm.tsx"), "utf8");
    expect(src).toContain("{V7_UI && <ModeChoice");
    expect(src).toContain('agent: { mode: v7Mode.agent }');
    expect(src).toContain('mode === "LIVE" ? { executor: { mode: v7Mode.executor } } : {}');
    expect(src).toContain("body.scope.allowSell = v7Mode.allowSell");
    expect(src).toMatch(/r\.status === 403 && .*hosted_not_allowed/);
  });
});
