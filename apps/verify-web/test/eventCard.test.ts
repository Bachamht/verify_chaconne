/** V-34 · 事件卡：一个主动作 + 「更多」；不适用的动作不显示。 */
import { describe, expect, it } from "vitest";
import { primaryActionOf } from "../components/agent/events/primaryAction";

describe("primaryActionOf", () => {
  it("有任务命中 → 按规则等待；无任务 → 建观察任务；都不能 → 查看依据；什么都没有 → null", () => {
    expect(primaryActionOf(["view_evidence", "wait_by_rule", "pause_issuance"], true)).toBe("wait_by_rule");
    expect(primaryActionOf(["view_evidence", "create_watch_task"], false)).toBe("create_watch_task");
    expect(primaryActionOf(["view_evidence", "keep_plan"], false)).toBe("view_evidence");
    expect(primaryActionOf([], false)).toBeNull();
  });
});
