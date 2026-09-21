/** delta 解释器（v5 W2 · M-12 的纯函数部分） */
import { describe, expect, it, beforeEach } from "vitest";
import { buildReport, explainDelta, validateCreateJob } from "../src/verify";
import { fixtureJob, fixtureRegistry, liveHappyEvidence, resetFixtureIds, rwaEvidence, T_CLOSED, T_REGULAR } from "../src/verify/fixtures";

function report(at: string, extra = [] as ReturnType<typeof rwaEvidence>[]) {
  const v = validateCreateJob(fixtureJob());
  if (!v.ok) throw new Error("job");
  return buildReport({ jobId: "job_d", reportVersion: 1, job: v.job, policy: v.policy, registry: fixtureRegistry(), evidence: [...liveHappyEvidence(at), ...extra], evaluatedAt: at });
}
beforeEach(() => resetFixtureIds());

describe("explainDelta", () => {
  it("首次评估：无 prev", () => {
    const d = explainDelta(null, report(T_REGULAR));
    expect(d.addedReasons).toEqual([]);
    expect(d.sessionChange).toBeNull();
    expect(d.summary.en).toMatch(/^First evaluation: eligible\./);
    expect(d.summary.zh).toMatch(/^首次评估：eligible。/);
  });
  it("休市 → 开市：REFERENCE_STALE/MARKET_OUTSIDE_REGULAR 解除，时段变化，判定变化，双语人话", () => {
    const prev = report(T_CLOSED);
    const next = report(T_REGULAR);
    const d = explainDelta(prev, next);
    expect(prev.verdict).toBe("rejected");
    expect(d.removedReasons).toContain("MARKET_OUTSIDE_REGULAR");
    expect(d.addedReasons).toEqual([]);
    expect(d.sessionChange).toEqual({ from: "CLOSED", to: "REGULAR" });
    expect(d.summary.en).toContain("Verdict changed rejected → eligible.");
    expect(d.summary.en).toContain("Cleared: market outside regular hours");
    expect(d.summary.zh).toContain("已解除：不在美股常规时段");
    expect(d.summary.en).toMatch(/ready to execute/);
    // 反向：开市 → 休市
    const back = explainDelta(next, prev);
    expect(back.addedReasons).toContain("MARKET_OUTSIDE_REGULAR");
    expect(back.summary.zh).toContain("新出现：不在美股常规时段");
    expect(back.summary.en).toMatch(/wait for the condition/);
  });
  it("info 级原因不计入增减；乘数变化进 unitChange", () => {
    const prev = report(T_REGULAR);
    const next = report(T_REGULAR, [rwaEvidence({ receivedAt: new Date(Date.parse(T_REGULAR) - 900_000).toISOString(), stockPriceUsd: "250.1", ratio: "1.0030" }), rwaEvidence({ receivedAt: new Date(Date.parse(T_REGULAR) - 2000).toISOString(), stockPriceUsd: "250.1", ratio: "1.0035" })]);
    const d = explainDelta(prev, next);
    expect(d.addedReasons).toEqual(["UNIT_CHANGED"]);
    expect(d.unitChange).toEqual({ from: null, to: "1.0035" });
    expect(d.summary.zh).toContain("代币乘数");
    expect(explainDelta(next, next).addedReasons).toEqual([]);
    expect(explainDelta(next, next).summary.en).toContain("Verdict unchanged");
  });
});
