/** V-24 · 建任务请求体：两个此前漏掉的必填字段（inputAssetKey / perStepAmountRaw）必须进 params；400 details 映射到字段；默认金额规则。 */
import { describe, expect, it } from "vitest";
import { amountParamOf, buildTaskBody, defaultPerStep, presetFromDraft, validateDraft, type TaskDraft } from "../components/agent/tasks/taskDraft";
import { fieldErrors } from "../lib/errors";
import { formatAmount } from "../lib/format";
import { conditionText } from "../lib/conditions";

const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const OWNER = "0xbacb0000000000000000000000000000000f0381";
const draft: TaskDraft = { playbookId: "session_dca", outputAssetKey: AAPLX, inputAssetKey: USDG, steps: 3, perStepHuman: "1", mode: "SIMULATION", conditions: [{ type: "session", allow: ["US_REGULAR"] }] };

describe("V-24 · 请求体", () => {
  it("session_dca：params 带 inputAssetKey 与 perStepAmountRaw（按精度换 raw），不带 from/to", () => {
    const b = buildTaskBody(draft, OWNER, 6, "web-1");
    expect(b.params).toEqual({ inputAssetKey: USDG, outputAssetKey: AAPLX, steps: 3, perStepAmountRaw: "1000000" });
    expect(b.ownerAddress).toBe(OWNER);
    expect(b.mode).toBe("SIMULATION");
    expect(Object.keys(b.params)).not.toContain("from");
  });
  it("discount_watch：单步模板用 amountRaw + maxPremiumBps", () => {
    const b = buildTaskBody({ ...draft, playbookId: "discount_watch", steps: 1, perStepHuman: "2.5" }, OWNER, 6, "web-2");
    expect(b.params).toEqual({ inputAssetKey: USDG, outputAssetKey: AAPLX, steps: 1, amountRaw: "2500000", maxPremiumBps: 30 });
    expect(amountParamOf("event_aware_accumulate")).toBe("perStepAmountRaw");
  });
  it("前置校验与服务端同名 code：缺 owner / 金额非法 / 步数越界", () => {
    expect(validateDraft(draft, OWNER, 6)).toEqual({});
    expect(validateDraft({ ...draft, perStepHuman: "0" }, OWNER, 6).perStepAmountRaw).toBe("expected_positive_raw_amount");
    expect(validateDraft({ ...draft, steps: 0 }, OWNER, 6).steps).toBe("expected_integer_in_range");
    expect(validateDraft(draft, "", 6).ownerAddress).toBe("required");
    expect(validateDraft(draft, OWNER, null).perStepAmountRaw).toBe("expected_positive_raw_amount");
  });
  it("400 details → 字段级人话（去 params. 前缀），不是「尚未就绪」", () => {
    const fe = fieldErrors([{ field: "inputAssetKey", code: "required" }, { field: "perStepAmountRaw", code: "required" }, { field: "params.inputAssetKey", code: "not_stable_input" }, { field: "from", code: "unknown_param" }], "zh");
    expect(fe["inputAssetKey"]).toBe("必填");
    expect(fe["perStepAmountRaw"]).toBe("必填");
    expect(fe["from"]).toBe("这个模板不接受此参数");
    expect(fieldErrors(null, "en")).toEqual({});
  });
  it("默认每步金额：余额未知 → 1；余额充足 → 1；余额不足 → 余额/步数截到 2 位", () => {
    expect(defaultPerStep(null, 6, 3)).toBe("1");
    expect(defaultPerStep("7298894", 6, 3)).toBe("1");
    expect(defaultPerStep("1500000", 6, 3)).toBe("0.5");
    expect(defaultPerStep("1234567", 6, 2)).toBe("0.61");
    expect(defaultPerStep("0", 6, 2)).toBe("1");
  });
  it("草案 → 预填：raw 金额按精度还原成人类单位；conditions 两种形状都收", () => {
    const p = presetFromDraft({ playbookId: "session_dca", mode: "SIMULATION", params: { outputAssetKey: AAPLX, inputAssetKey: USDG, steps: 2, perStepAmountRaw: "1500000" }, conditions: { items: [{ type: "session", allow: ["US_REGULAR"] }] } }, () => 6);
    expect(p).toMatchObject({ playbookId: "session_dca", mode: "SIMULATION", steps: 2, perStepHuman: "1.5" });
    expect(p.conditions?.length).toBe(1);
    expect(presetFromDraft(null, () => 6)).toEqual({});
  });
});

describe("金额与条件的人话", () => {
  it("formatAmount：raw + 精度 + 符号；缺失是 —，不是 0", () => {
    expect(formatAmount("2000000", 6, "USDG")).toBe("2 USDG");
    expect(formatAmount("29344314705268530", 18, "AAPLx")).toBe("0.029344 AAPLx");
    expect(formatAmount(null, 6, "USDG")).toBe("—");
    expect(formatAmount("", 6)).toBe("—");
  });
  it("conditionText：不再显示 JSON", () => {
    const s = conditionText({ type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, "zh");
    expect(s).toContain("一级宏观数据");
    expect(s).not.toContain("{");
    expect(conditionText({ type: "session", allow: ["US_REGULAR"] }, "en")).toBe("Only during US regular hours");
  });
});

describe("A2MCP 完整草案（S lane）原样进表单", () => {
  it("带 clientRequestId / ownerAddress / missingForCreate 的完整请求体也能预填；owner 只在合法时带上", async () => {
    const { presetFromDraft } = await import("../components/agent/tasks/taskDraft");
    const body = { clientRequestId: "a2mcp-1", ownerAddress: "0xbacb0000000000000000000000000000000f0381", playbookId: "session_dca", mode: "SIMULATION", params: { inputAssetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", outputAssetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", steps: 2, perStepAmountRaw: "1000000" }, conditions: { version: "conditions/1", items: [{ type: "session", allow: ["US_REGULAR"] }] }, missingForCreate: [] };
    const p = presetFromDraft(body as never, () => 6);
    expect(p.ownerAddress).toBe("0xbacb0000000000000000000000000000000f0381");
    expect(p.perStepHuman).toBe("1");
    expect(p.steps).toBe(2);
    expect(presetFromDraft({ ownerAddress: "not-an-address" }, () => 6).ownerAddress).toBeUndefined();
  });
});
