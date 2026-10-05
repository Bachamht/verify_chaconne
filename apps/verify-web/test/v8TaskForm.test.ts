/**
 * v8 任务表单（/start 第 1 步与 /agent/new 共用）：草稿、字段错误、服务端 400 字段映射、结果分类、
 * 「这意味着什么」里的签名次数（买入 2 + 每只允许卖出的股票 2）、/agent/new 的 ?from= 预填、委托向导 v8 外观。
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AssetEntry } from "../lib/assets";
import { FX_OWNER } from "../lib/v7fixtures";
import { classifyCreate, displayErrors, draftFromTemplate, localFieldErrors, mapServerDetails, meaningLines, peekText, restFieldLabel, serverFieldOf, signatureCount, stableOf, TEMPLATES } from "../components/features/task-form/model";
import { fieldErrorCopy, tf, type TaskFormKey } from "../components/features/task-form/copy";
import { fromSourceOf, newTaskHref, prefilledDraft, prefillFromQuery, prefillNote, resolvePrefill, templateFor, totalOf } from "../components/features/new-task/prefill";
import { itemFailReason, itemStepState } from "../components/features/onboarding/DelegationItemStep";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale: "zh", t: (key: string) => key }) }));

const k = (hex: string) => `eip155:196:0x${hex.repeat(40).slice(0, 40)}`;
const USDG = { assetKey: k("4a"), tokenAddress: `0x${"4a".repeat(20)}`, tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", executionAllowed: true, underlyingId: "fiat:USD" } as AssetEntry;
const USDC = { ...USDG, assetKey: k("5c"), tokenAddress: `0x${"5c".repeat(20)}`, displaySymbol: "USDC" } as AssetEntry;
const stock = (sym: string, hex: string) => ({ assetKey: k(hex), tokenAddress: `0x${hex.repeat(40).slice(0, 40)}`, tokenDecimals: 18, displaySymbol: sym, role: "stock_output", executionAllowed: true, underlyingId: `NASDAQ:${sym.slice(0, -1)}` }) as AssetEntry;
const AAPL = stock("AAPLx", "a1");
const NVDA = stock("NVDAx", "b2");
const TSLA = stock("TSLAx", "c3");
const ASSETS = [USDG, USDC, AAPL, NVDA, TSLA];
const STOCKS = [AAPL, NVDA, TSLA];
const keys = STOCKS.map((a) => a.assetKey);
const owner = "0x00000000000000000000000000000000000000aa";

describe("草稿与本地校验", () => {
  it("每个模板生成的草稿都通过校验；默认只买入；换模板保留资金币种", () => {
    TEMPLATES.forEach((_, i) => {
      const d = draftFromTemplate(i, keys, "zh");
      expect(localFieldErrors(d, ASSETS, keys)).toEqual({});
      expect(d.allowSell).toBe(false);
    });
    expect(draftFromTemplate(1, keys, "zh", { inputAssetKey: USDC.assetKey }).inputAssetKey).toBe(USDC.assetKey);
  });
  it("资金币种：没选 → USDG；选了 → 用选的；不在登记表 → 回到 USDG", () => {
    expect(stableOf({}, ASSETS)?.displaySymbol).toBe("USDG");
    expect(stableOf({ inputAssetKey: USDC.assetKey }, ASSETS)?.displaySymbol).toBe("USDC");
    expect(stableOf({ inputAssetKey: k("ff") }, ASSETS)?.displaySymbol).toBe("USDG");
  });
  it("字段错误落在对应字段：单笔超过总额、没选股票、股票已不可交易、没有资金币种", () => {
    const d = draftFromTemplate(0, keys, "zh");
    expect(localFieldErrors({ ...d, perStepHuman: "101" }, ASSETS, keys)).toEqual({ perStep: "perStep" });
    expect(localFieldErrors({ ...d, assetKeys: [] }, ASSETS, keys)).toEqual({ assets: "assets" });
    expect(localFieldErrors({ ...d, assetKeys: [k("dd")] }, ASSETS, keys)).toEqual({ assets: "unavailable" });
    expect(localFieldErrors(d, [AAPL], keys)).toMatchObject({ inputAsset: "inputAsset" });
    const shown = displayErrors({ perStep: "perStep" }, { total: "需为正数金额" }, (c) => fieldErrorCopy(c, "zh"));
    expect(shown).toEqual({ perStep: "单笔上限需大于 0，且不能超过总预算。", total: "需为正数金额" });
  });
});

describe("服务端 400：details[].field → 表单字段", () => {
  it("inputAssetKey / perStepAmountRaw 等路径都能落到字段", () => {
    expect(serverFieldOf("params.inputAssetKey")).toBe("inputAsset");
    expect(serverFieldOf("params.perStepAmountRaw")).toBe("perStep");
    expect(serverFieldOf("scope.perStepCapRaw")).toBe("perStep");
    expect(serverFieldOf("scope.budgetCapRaw")).toBe("total");
    expect(serverFieldOf("scope.outputAssetKeys[1]")).toBe("assets");
    expect(serverFieldOf("scope.deadline")).toBe("days");
    expect(serverFieldOf("scope.hardConditions[0].allow")).toBe("conditions");
    expect(serverFieldOf("ownerAddress")).toBeNull();
  });
  it("落不到字段的放进 rest；同一字段只留第一条", () => {
    const m = mapServerDetails([{ field: "params.perStepAmountRaw", code: "expected_positive_raw_amount" }, { field: "scope.perStepCapRaw", code: "required" }, { field: "ownerAddress", code: "required" }], "zh");
    expect(m.fields).toEqual({ perStep: "需为正数金额" });
    expect(m.rest).toEqual(["钱包地址：必填"]);
  });
  it("rest 不露原始路径：已知路径给中文名，未知路径写「其他设置」", () => {
    const m = mapServerDetails([{ field: "params.trustTier", code: "required" }, { field: "params.mysteryThing[0]", code: "required" }], "zh");
    expect(m.rest).toEqual(["信任级别：必填", "其他设置：必填"]);
    expect(m.rest.join("")).not.toMatch(/params|\[0\]/);
    expect(restFieldLabel("scope.ownerAddress", "en")).toBe("Wallet address");
    expect(restFieldLabel("params.x[0].y", "en")).toBe("Another setting");
  });
});

describe("建任务结果分类", () => {
  const expectSim = { mode: "SIMULATION" as const, owner };
  it("成功必须模式与 owner 都对上", () => {
    expect(classifyCreate({ status: 201, data: { mode: "SIMULATION", task: { id: "tsk_1", owner } } }, expectSim, "zh")).toEqual({ kind: "ok", id: "tsk_1" });
    expect(classifyCreate({ status: 201, data: { mode: "LIVE", task: { id: "tsk_1", owner } } }, expectSim, "zh").kind).toBe("mismatch");
    expect(classifyCreate({ status: 201, data: { mode: "SIMULATION", task: { id: "tsk_1", owner: FX_OWNER } } }, expectSim, "zh").kind).toBe("mismatch");
  });
  it("400 带字段 → fields；托管准入被拒；观察次数用完；不可达；只读中转的 403 是普通拒绝", () => {
    const f = classifyCreate({ status: 400, data: { error: "invalid_playbook_params", details: [{ field: "params.inputAssetKey", code: "required" }] } }, expectSim, "zh");
    expect(f).toEqual({ kind: "fields", fields: { inputAsset: "必填" }, rest: [] });
    expect(classifyCreate({ status: 403, data: { error: "hosted_not_allowed" } }, expectSim, "zh").kind).toBe("hosted_closed");
    expect(classifyCreate({ status: 429, data: { error: "hosted_sim_limit" } }, expectSim, "zh").kind).toBe("sim_limit");
    expect(classifyCreate(null, expectSim, "zh").kind).toBe("unreachable");
    expect(classifyCreate({ status: 0, data: null }, expectSim, "zh").kind).toBe("unreachable");
    expect(classifyCreate({ status: 403, data: { error: "relay_read_only" } }, expectSim, "zh")).toEqual({ kind: "other", message: "请求失败（relay_read_only）" });
  });
});

describe("签名次数与「这意味着什么」", () => {
  const d = draftFromTemplate(1, keys, "zh");
  it("只买入 = 2 次；允许卖出 = 2 + 每只股票 2", () => {
    expect(signatureCount({ ...d, allowSell: false })).toBe(2);
    expect(signatureCount({ ...d, assetKeys: keys, allowSell: true })).toBe(8);
  });
  it("三行人话：上限、方向（卖出包含原有持仓）、签名次数；中文无破折号、不说只签一次", () => {
    const buy = meaningLines({ ...d, assetKeys: keys }, "USDG", "zh");
    expect(buy).toHaveLength(3);
    expect(buy[0]).toContain("最多花 100 USDG");
    expect(buy[1]).toContain("不会卖出");
    expect(buy[2]).toContain("买入最多要签 2 次");
    expect(buy[2]).not.toContain("每只可以卖出");
    const sell = meaningLines({ ...d, assetKeys: keys, allowSell: true }, "USDG", "zh");
    expect(sell[1]).toContain("原有的持仓");
    expect(sell[2]).toContain("每只可以卖出的股票再加 2 次");
    for (const l of [...buy, ...sell]) { expect(l).not.toContain("——"); expect(l).not.toMatch(/只签一次|失败交易不花钱|最多只损失/); }
    expect(meaningLines({ ...d, allowSell: true }, "USDG", "en")[2]).toContain("plus two for each stock it may sell");
    expect(peekText({ ...d, assetKeys: keys }, "USDG", "zh")).toBe("100 USDG · 3 只股票 · 只买入");
  });
  it("表单文案：中文无破折号、无英文标语", () => {
    for (const key of ["template", "assets", "allow_sell_hint", "conditions", "limits", "limits_hint"] as TaskFormKey[]) {
      expect(tf("zh", key)).not.toContain("——");
      expect(tf("zh", key)).not.toMatch(/[A-Z]{3,}/);
    }
  });
});

describe("/agent/new 预填（?from=draft|event|compare|replay）", () => {
  const ctx = { stocks: STOCKS, stables: [USDG, USDC] };
  it("来源与链接", () => {
    expect(fromSourceOf("event")).toBe("event");
    expect(fromSourceOf("other")).toBeNull();
    expect(newTaskHref("replay", { asset: "AAPLx" })).toBe("/agent/new?from=replay&asset=AAPLx");
    expect(newTaskHref("event", { asset: [AAPL.assetKey, NVDA.assetKey], event: "ev_1", eventName: null })).toBe(`/agent/new?from=event&asset=${encodeURIComponent(AAPL.assetKey)}&asset=${encodeURIComponent(NVDA.assetKey)}&event=ev_1`);
  });
  it("查询串：股票代码或 assetKey 都认；最小单位按币种精度换成人类单位；总额 = 单笔 × 笔数", () => {
    const q = new URLSearchParams({ asset: "aaplx", inputAssetKey: USDC.assetKey, perStepAmountRaw: "2500000", steps: "4" });
    expect(prefillFromQuery(q, ctx)).toMatchObject({ assetKeys: ["aaplx"], inputAssetKey: USDC.assetKey, perStepHuman: "2.5", maxSteps: 4, totalHuman: "10" });
    expect(totalOf("0.1", 3, 6)).toBe("0.3");
    const r = resolvePrefill({ query: new URLSearchParams("asset=AAPLx,GONEx&asset=" + NVDA.assetKey), handoff: null, goal: null }, ctx);
    expect(r.patch.assetKeys).toEqual([AAPL.assetKey, NVDA.assetKey]);
    expect(r.dropped).toBe(1);
  });
  it("草案（模板式请求体）→ 股票、资金币种、单笔、笔数、总额", () => {
    const handoff = { playbookId: "session_dca", params: { outputAssetKey: AAPL.assetKey, inputAssetKey: USDG.assetKey, perStepAmountRaw: "1000000", steps: 3 }, scope: { objective: "财报后分三笔买", allowSell: false } };
    const r = resolvePrefill({ query: new URLSearchParams(), handoff, goal: null }, ctx);
    expect(r.patch).toMatchObject({ assetKeys: [AAPL.assetKey], inputAssetKey: USDG.assetKey, perStepHuman: "1", maxSteps: 3, totalHuman: "3", objective: "财报后分三笔买", allowSell: false });
    const start = prefilledDraft(r.patch, keys, "zh");
    expect(start.template).toBe(-1);
    expect(start.draft.strategy).toBe("");
    expect(localFieldErrors(start.draft, ASSETS, keys)).toEqual({});
  });
  it("目标草稿带 exampleId 时高亮对应模板；只给股票时保留第一个模板", () => {
    expect(templateFor({ exampleId: TEMPLATES[2]!.id, objective: "x" })).toBe(2);
    expect(templateFor({ assetKeys: [AAPL.assetKey] })).toBe(0);
  });
  it("说明句：中文无破折号，写出移除了几只", () => {
    const n = prefillNote("event", "zh", { dropped: 2, eventName: "非农" });
    expect(n).toContain("已按事件「非农」预填");
    expect(n).toContain("2 只股票当前不可交易");
    expect(n).not.toContain("——");
  });
});

describe("委托向导 v8 外观（签名逻辑共用 useDelegationWizard）", () => {
  it("清单状态 → StepFlow 步骤状态", () => {
    expect(itemStepState("confirmed", false)).toBe("done");
    expect(itemStepState("not_needed", false)).toBe("done");
    expect(itemStepState("failed", false)).toBe("failed");
    expect(itemStepState("submitted", false)).toBe("active");
    expect(itemStepState("todo", false)).toBe("idle");
    expect(itemStepState("todo", true)).toBe("active");
  });
  it("失败原因：已知码给人话，未知码不露原始码，中文页不夹英文原文", () => {
    expect(itemFailReason({ code: "permit_domain_unverified", message: "permit domain not verified" }, "zh")).toBe("这个代币的签名域还没核验通过，暂不支持额度签名。");
    const zh = itemFailReason({ code: "permit_failed", message: "the previous permit did not land on-chain" }, "zh");
    expect(zh).not.toMatch(/permit_failed|previous permit/);
    expect(zh).toContain("重新读取授权清单");
    expect(itemFailReason({ code: "permit_failed", message: "the previous permit did not land on-chain" }, "en")).toBe("the previous permit did not land on-chain");
    expect(itemFailReason({ code: "weird_code" }, "en")).not.toContain("weird_code");
  });
  it("fixture：计数器、事先说明、钱包状态、继续签名按钮禁用且写明原因", async () => {
    const { DelegationSteps } = await import("../components/features/onboarding/DelegationSteps");
    const html = renderToStaticMarkup(React.createElement(DelegationSteps, { taskId: "tsk_fixture", owner: FX_OWNER, fixture: true, taskHref: "/agent/tasks/tsk_fixture?v7fixture=1" }));
    expect(html).toContain("签名 2 / 6 · 你的交易 0 · gas 0");
    expect(html).toContain("签名前先知道");
    expect(html).toContain("你不花 gas");
    expect(html).toContain("是任务的 owner");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>从第 2 项继续签名/);
    expect(html).toContain("示例数据不能签名");
    expect(html).toContain("不证明 Agent 的判断正确");
    expect(html).not.toContain("——");
  }, 20_000);
});
