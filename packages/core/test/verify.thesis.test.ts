/** v6 Lane B · C7 理由卡纯函数（T-01 三态、T-03 research 只收复核项、T-04 过期）+ 任务状态机 */
import { describe, expect, it } from "vitest";
import { emptyConditionEvidence, type TaskConditionState } from "../src/verify/conditions";
import { applyFieldStatus, assessContextStaleness } from "../src/verify/context";
import { fixtureMarketContext } from "../src/verify/context/fixture";
import type { ThesisCard } from "../src/verify/contracts";
import { canTransition, runningStatusAfterEvaluation, STOP_SEMANTICS_NOTE, TASK_TRANSITIONS } from "../src/verify/tasks";
import { checkThesis, machinePremisesFromConditions, premiseKindForCondition, thesisStatusOf, validateReviewItem, validateThesisInput } from "../src/verify/thesis";
import { evaluateConditions, makeConditionSet } from "../src/verify/conditions";

const NOW = "2026-09-18T15:00:00.000Z";
const st: TaskConditionState = { underlyingIds: ["us-equity:FAKE"], outputAssetKeys: ["eip155:196:0x2222222222222222222222222222222222222222"], mode: "LIVE", lastConfirmedStepAt: null, stepsConfirmedToday: 0, stepsConfirmedTodayInBudgetGroup: null, nextStepAmountRaw: "1" };
function ctxEvidence(vix: string | null) {
  const ctx = fixtureMarketContext({ at: NOW, overrides: { vix } });
  const fieldStatus = assessContextStaleness(ctx, NOW);
  return { ...emptyConditionEvidence(), context: { snapshot: applyFieldStatus(ctx, fieldStatus), fieldStatus, evidenceId: "ev_ctx", receivedAt: NOW } };
}
const card = (): ThesisCard => ({
  id: "ths_1",
  taskId: "tsk_1",
  goal: "accumulate FAKE",
  rationale: "user rationale",
  premises: [...machinePremisesFromConditions([{ type: "max_vix", value: 30 }], "ths_1"), { id: "ths_1_r0", kind: "research", text: "AI demand keeps growing", status: "unknown", lastCheckedAt: null, evidenceIds: [], reviewItems: [] }],
  validUntil: "2026-10-01T00:00:00.000Z",
  onInvalidation: "notify",
  status: "unknown",
});

describe("T-01 前提三态", () => {
  it("T-01 机器前提：VIX 17.85 ≤ 30 → holds；VIX 31 → invalidated（newlyInvalidated）；上下文不可达 → unknown；research 前提不变", () => {
    const holds = checkThesis(card(), ctxEvidence("17.85"), st, NOW);
    expect(holds.card.premises[0]!.status).toBe("holds");
    expect(holds.card.premises[1]!.status).toBe("unknown");
    expect(holds.card.status).toBe("holds"); // research 前提不参与卡片状态
    expect(holds.newlyInvalidated).toEqual([]);
    const inv = checkThesis(holds.card, ctxEvidence("31"), st, NOW);
    expect(inv.card.premises[0]!.status).toBe("invalidated");
    expect(inv.card.status).toBe("invalidated");
    expect(inv.newlyInvalidated).toEqual(["ths_1_m0"]);
    const again = checkThesis(inv.card, ctxEvidence("31"), st, NOW);
    expect(again.newlyInvalidated).toEqual([]); // 只在首次翻转时触发
    const unknown = checkThesis(holds.card, emptyConditionEvidence(), st, NOW);
    expect(unknown.card.premises[0]!.status).toBe("unknown");
    expect(unknown.card.status).toBe("unknown");
  });
  it("T-04 validUntil 过期 → expired（newlyExpired 一次）；thesisStatusOf 纯函数", () => {
    const c = { ...card(), validUntil: "2026-09-18T14:00:00.000Z" };
    const r = checkThesis(c, ctxEvidence("17.85"), st, NOW);
    expect(r.card.status).toBe("expired");
    expect(r.newlyExpired).toBe(true);
    expect(checkThesis(r.card, ctxEvidence("17.85"), st, NOW).newlyExpired).toBe(false);
    expect(thesisStatusOf(r.card.premises, "2026-12-01T00:00:00.000Z", NOW)).toBe("holds");
  });
});

describe("V-27 时间门不是论点前提", () => {
  it("session / min_gap 之类生成 kind=timing：休市时 status=invalidated 但卡片仍 holds、不进 newlyInvalidated；显式写 machine 也归为 timing", () => {
    const premises = [...machinePremisesFromConditions([{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }, { type: "max_vix", value: 30 }], "ths_2")];
    expect(premises.map((p) => p.kind)).toEqual(["timing", "timing", "machine"]);
    const c: ThesisCard = { ...card(), premises };
    const closed = "2026-09-18T22:00:00.000Z"; // 18:00 ET，休市
    const r = checkThesis(c, ctxEvidence("17.85"), st, closed);
    expect(r.card.premises[0]!.status).toBe("invalidated"); // 展示如实：此刻不在常规时段
    expect(r.card.premises[0]!.kind).toBe("timing");
    expect(r.card.status).toBe("holds"); // 但论点没有被推翻
    expect(r.newlyInvalidated).toEqual([]);
    // 旧卡里存成 machine 的 session 前提也不推翻论点
    const legacy: ThesisCard = { ...card(), premises: [{ ...premises[0]!, kind: "machine" }] };
    const lr = checkThesis(legacy, ctxEvidence("17.85"), st, closed);
    expect(lr.card.status).toBe("holds");
    expect(lr.card.premises[0]!.kind).toBe("timing");
    expect(premiseKindForCondition({ type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true })).toBe("timing");
    expect(premiseKindForCondition({ type: "thesis_holds", thesisId: "x" })).toBe("machine");
    const v = validateThesisInput({ goal: "g", validUntil: "2026-10-01T00:00:00.000Z", onInvalidation: "notify", premises: [{ kind: "machine", text: "regular hours", condition: { type: "session", allow: ["US_REGULAR"] } }] }, "LIVE", NOW);
    expect(v.ok && v.input.premises[0]!.kind).toBe("timing");
  });
  it("thesis_holds：invalidated / unknown 时 nextCheckAt 取证据里的下次复评时刻（已知就不为 null）", () => {
    const set = makeConditionSet([{ type: "thesis_holds", thesisId: "ths_1" }]);
    const ev = { ...emptyConditionEvidence(), theses: { ths_1: { status: "invalidated" as const, evidenceIds: [], nextCheckAt: "2026-09-18T15:00:30.000Z" } } };
    const r = evaluateConditions(set, ev, st, NOW);
    expect(r.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "THESIS_INVALIDATED" }], nextCheckAt: "2026-09-18T15:00:30.000Z" });
    expect(r.nextCheckAt).toBe("2026-09-18T15:00:30.000Z");
    const none = evaluateConditions(set, { ...ev, theses: { ths_1: { status: "invalidated", evidenceIds: [] } } }, st, NOW);
    expect(none.perItem[0]!.nextCheckAt).toBeNull();
  });
});

describe("T-03 research 前提只生成复核项", () => {
  it("T-03 复核项 sourceUrl 必填、side 只能 support/counter；理由卡输入校验：machine 前提必须带合法 condition、validUntil 必须在未来、onInvalidation 三选一", () => {
    expect(validateReviewItem({ side: "support", text: "x" }, "user", NOW).ok).toBe(false);
    expect(validateReviewItem({ side: "support", text: "x", sourceUrl: "https://example.com/a" }, "agent", NOW)).toMatchObject({ ok: true, item: { addedBy: "agent", side: "support" } });
    expect(validateReviewItem({ side: "maybe", text: "x", sourceUrl: "https://example.com/a" }, "user", NOW).ok).toBe(false);
    const bad = validateThesisInput({ goal: "g", validUntil: "2026-09-01T00:00:00.000Z", onInvalidation: "sell_everything", premises: [{ kind: "machine", text: "t", condition: { type: "max_vix", value: -1 } }] }, "LIVE", NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.field)).toEqual(expect.arrayContaining(["validUntil", "onInvalidation", "premises[0].condition.value"]));
    const ok = validateThesisInput({ goal: "g", rationale: "r", validUntil: "2026-10-01T00:00:00.000Z", onInvalidation: "draft_exit", premises: [{ kind: "research", text: "AI demand" }, { kind: "machine", text: "vix", condition: { type: "max_vix", value: 30 } }] }, "LIVE", NOW);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.conditions).toEqual([{ type: "max_vix", value: 30 }]);
  });
});

describe("任务 12 态状态机", () => {
  it("合法/非法转移；终态不可出；停止语义文案固定", () => {
    expect(canTransition("DRAFT", "AWAITING_AUTHORIZATION")).toBe(true);
    expect(canTransition("AWAITING_AUTHORIZATION", "ACTIVE")).toBe(true);
    expect(canTransition("ACTIVE", "STEP_PREPARED")).toBe(true);
    expect(canTransition("STEP_PREPARED", "PARTIAL")).toBe(true);
    expect(canTransition("PAUSED", "ACTIVE")).toBe(true);
    expect(canTransition("REVOKE_PENDING", "REVOKED")).toBe(true);
    expect(canTransition("COMPLETED", "ACTIVE")).toBe(false);
    expect(canTransition("REVOKED", "ACTIVE")).toBe(false);
    expect(canTransition("CANCELLED", "PAUSED")).toBe(false);
    expect(canTransition("PAUSED", "STEP_PREPARED")).toBe(false);
    expect(Object.keys(TASK_TRANSITIONS).length).toBe(12);
    expect(STOP_SEMANTICS_NOTE).toMatch(/revokeMandate/);
    expect(runningStatusAfterEvaluation({ current: "ACTIVE", outcome: "INSUFFICIENT_EVIDENCE", mandateBlocked: false, stepIssued: false, stepsDone: 0, completed: false })).toBe("WAITING");
    expect(runningStatusAfterEvaluation({ current: "WAITING", outcome: "SATISFIED", mandateBlocked: false, stepIssued: true, stepsDone: 0, completed: false })).toBe("STEP_PREPARED");
    expect(runningStatusAfterEvaluation({ current: "WAITING", outcome: "SATISFIED", mandateBlocked: false, stepIssued: false, stepsDone: 1, completed: false })).toBe("PARTIAL");
    expect(runningStatusAfterEvaluation({ current: "PAUSED", outcome: "SATISFIED", mandateBlocked: false, stepIssued: false, stepsDone: 0, completed: false })).toBe("PAUSED");
  });
});
