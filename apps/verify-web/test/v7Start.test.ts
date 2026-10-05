/**
 * P-01 / P-08 · /start v7：① 交代任务 → ② SIMULATION + 托管 Agent → ③ 同一份目标与范围建 LIVE（托管 Agent + 平台执行）→ 向导 → ④ 任务页；
 * 「我来扮演 Agent」教学入口在页底（/start?mode=play）；开关关闭时旧流程的路径不变。
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildStartRequest, createFailureKind, sameScope, validateStartDraft, type StartDraft } from "../components/onboarding/modelV7";
import type { AssetEntry } from "../lib/assets";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale: "zh", t: (key: string) => key }) }));

const USDG = { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", executionAllowed: true, underlyingId: "usd:USDG" } as AssetEntry;
const A = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const N = "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const owner = "0x00000000000000000000000000000000000000aa";
const draft: StartDraft = { objective: "未来一周在非农前后加仓", strategy: "数据前小仓位", assetKeys: [N, A], totalHuman: "10", perStepHuman: "2", maxSteps: 5, days: 7, allowSell: true, regularOnly: true, trustTier: "agent_data", watch: ["MACRO_TIER1"], exampleId: "macro_allocation" };
const deadline = "2026-10-12T00:00:00.000Z";

describe("P-01 · 请求体", () => {
  it("SIMULATION = 托管 Agent、无执行方；LIVE = 托管 Agent + 平台执行；范围完全相同", () => {
    const sim = buildStartRequest(draft, USDG, owner, "SIMULATION", "a", deadline)!;
    const live = buildStartRequest(draft, USDG, owner, "LIVE", "b", deadline)!;
    expect(sim.mode).toBe("SIMULATION");
    expect(sim.agent).toEqual({ mode: "hosted" });
    expect(sim.executor).toBeUndefined();
    expect(live.mode).toBe("LIVE");
    expect(live.executor).toEqual({ mode: "hosted" });
    expect(sameScope(sim, live)).toBe(true);
    expect(live.scope).toMatchObject({ budgetCapRaw: "10000000", perStepCapRaw: "2000000", maxSteps: 5, allowSell: true, issuance: "agent", outputAssetKeys: [A, N].sort(), hardConditions: [{ type: "session", allow: ["US_REGULAR"] }] });
    expect(live.ownerAddress).toBe(owner);
  });
  it("校验：每笔上限不超过总额、至少一只股票、步数与天数范围；不合法不构造请求", () => {
    expect(validateStartDraft(draft, USDG)).toEqual([]);
    expect(validateStartDraft({ ...draft, perStepHuman: "11" }, USDG)).toContain("perStep");
    expect(validateStartDraft({ ...draft, assetKeys: [] }, USDG)).toContain("assets");
    expect(validateStartDraft({ ...draft, totalHuman: "1.0000001" }, USDG)).toContain("total");
    expect(validateStartDraft({ ...draft, maxSteps: 0, days: 400 }, USDG)).toEqual(expect.arrayContaining(["maxSteps", "days"]));
    expect(buildStartRequest({ ...draft, objective: " " }, USDG, owner, "LIVE", "x", deadline)).toBeNull();
    expect(buildStartRequest(draft, USDG, "not-an-address", "LIVE", "x", deadline)).toBeNull();
  });
  it("失败分类：托管未开放 → 提示先用观察模式；观察次数用完 → 明天再来", () => {
    expect(createFailureKind({ status: 403, data: { error: "hosted_not_allowed" } })).toBe("hosted_closed");
    expect(createFailureKind({ status: 429, data: { error: "hosted_sim_limit" } })).toBe("sim_limit");
    expect(createFailureKind({ status: 429, data: { error: "rate_limited" } })).toBe("other");
    expect(createFailureKind({ status: 400, data: { error: "recipient_must_be_owner" } })).toBe("other");
  });
});

describe("P-01 / P-08 · 页面", () => {
  it("新流程：四步条、观察模式按钮文案、页底教学入口指向 /start?mode=play", async () => {
    const { OnboardingV7 } = await import("../components/onboarding/OnboardingV7");
    const html = renderToStaticMarkup(React.createElement(OnboardingV7, { account: owner }));
    for (const t of ["交代任务", "先跑给我看", "真实运行", "任务页", "我来扮演 Agent"]) expect(html).toContain(t);
    expect(html).toContain('href="/start?mode=play"');
    expect(html).toContain('aria-current="step"');
  }, 20_000);
  it("Onboarding：只在 V7_UI 且不是 mode=play 时走新流程；旧流程在开关关闭时路径不变（/start?step=result）", () => {
    const src = readFileSync(join(__dirname, "..", "components/onboarding/Onboarding.tsx"), "utf8");
    expect(src).toContain('if (V7_UI && sp.get("mode") !== "play")');
    expect(src).toContain('const PLAY_BASE = V7_UI ? "/start?mode=play" : "/start";');
    const PLAY_BASE = "/start";
    expect(`${PLAY_BASE}${PLAY_BASE.includes("?") ? "&" : "?"}step=result`).toBe("/start?step=result");
    const v7 = "/start?mode=play";
    expect(`${v7}${v7.includes("?") ? "&" : "?"}step=result`).toBe("/start?mode=play&step=result");
  });
});
