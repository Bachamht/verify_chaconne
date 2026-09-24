/** V-32 · 任务标题与阻塞项：不用 tsk_ id 当标题；金额带符号与人类单位；阻塞码有中文短句。 */
import { describe, expect, it } from "vitest";
import { blockerSentence, statusLabel, taskTitle } from "../components/agent/tasks/taskTitle";
import { reasonText } from "../lib/reasons";

const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const assets = [{ assetKey: USDG, displaySymbol: "USDG", tokenDecimals: 6 }, { assetKey: AAPLX, displaySymbol: "AAPLx", tokenDecimals: 18 }];
const task = { playbookId: "session_dca" as const, goal: { side: "buy", legs: [{ outputAssetKey: AAPLX, weightBps: 10000 }], budget: { inputAssetKeys: [USDG], amountInRaw: "6000000" } } as never };

describe("taskTitle", () => {
  it("有 params：模板 · 资产 · 每步金额 × 步数", () => {
    expect(taskTitle(task, { perStepAmountRaw: "2000000", steps: 3 }, assets, "zh")).toBe("分段定投 · AAPLx · 2 USDG × 3 步");
    expect(taskTitle(task, { perStepAmountRaw: "2000000", steps: 3 }, assets, "en")).toBe("Session DCA · AAPLx · 2 USDG × 3 step(s)");
  });
  it("只有 goal（列表页）：模板 · 资产 · 总额；登记表没到时退回短地址而不是崩", () => {
    expect(taskTitle(task, null, assets, "zh")).toBe("分段定投 · AAPLx · 共 6 USDG");
    expect(taskTitle(task, null, [], "zh")).toMatch(/^分段定投 · 0x9d27…890a · 共 6/);
  });
  it("状态与阻塞码都有人话", () => {
    expect(statusLabel("WAITING", "zh")).toBe("等待中");
    expect(statusLabel("PAUSED", "en")).toBe("Paused");
    expect(blockerSentence({ code: "SESSION_RULE_BLOCK", text: "Outside the sessions allowed by this task." }, "zh")).toBe("现在不在你允许的美股时段（只在常规时段买）。");
    expect(blockerSentence({ code: "THESIS_INVALIDATED", text: "x" }, "zh")).not.toContain("THESIS");
    for (const code of ["SESSION_RULE_BLOCK", "THESIS_INVALIDATED", "EVENT_WINDOW_ACTIVE", "CASH_FLOOR_BLOCK", "BUDGET_GROUP_CONFLICT", "STEP_GAP_NOT_ELAPSED", "DAILY_STEP_CAP_REACHED"]) expect(reasonText(code, "zh")).not.toBe(code);
    // 未知码退回接口给的 text
    expect(blockerSentence({ code: "SOMETHING_NEW", text: "given text" }, "zh")).toBe("given text");
  });
});

describe("V-33 · 休市时两套都在等开盘", () => {
  it("两套都是 UNSATISFIED 且都含 SESSION_RULE_BLOCK → 提示；否则不提示", async () => {
    const { bothWaitingForOpen } = await import("../components/agent/lab/compareHints");
    expect(bothWaitingForOpen([{ outcome: "UNSATISFIED", blockingCodes: ["SESSION_RULE_BLOCK"] }, { outcome: "UNSATISFIED", blockingCodes: ["SESSION_RULE_BLOCK", "EVENT_WINDOW_ACTIVE"] }])).toBe(true);
    expect(bothWaitingForOpen([{ outcome: "SATISFIED", blockingCodes: [] }, { outcome: "UNSATISFIED", blockingCodes: ["SESSION_RULE_BLOCK"] }])).toBe(false);
    expect(bothWaitingForOpen(null)).toBe(false);
  });
});
