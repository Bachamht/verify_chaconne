/**
 * 纯函数：把一个交易日的授权计划 / 评估 / 步骤（+ 可选 v6 任务与事件）折成 Recap。
 * 纪律：账目只从已确认回执的步骤累加，时间线里每笔确认步骤都带同一个 amountRaw（R-02 可复算）；
 * 等待原因逐条列出原因码，不写涨跌预测；里程碑只按可核对的行为（R-05）。
 */
import { hashCanonical, type Task } from "@chaconne/core/verify";
import type { MandateJson } from "../mandates/service";
import type { MandateBundle } from "./sources";
import type { Recap, RecapDecision, RecapLedgerLine, RecapMilestone, RecapMode, RecapReason, RecapRemaining, RecapRemixable, RecapTaskLine, RecapTimelineEntry, RecapTrade, RecapWaitLine } from "./types";
import type { RecapWindow } from "./window";

/** 原因码 → 说明文案（只解释条件，不预测；未知码回显原码） */
const REASON_TEXT: Record<string, string> = {
  MARKET_OUTSIDE_REGULAR: "US market outside regular hours",
  REFERENCE_STALE: "stock reference older than the policy allows",
  REFERENCE_MISSING: "no stock reference price",
  QUOTE_TOO_OLD: "quote older than allowed",
  QUOTE_UNAVAILABLE: "no executable route for this amount",
  CLOSE_SESSION_MISMATCH: "close on file is not the latest completed session",
  CLOSE_UNCONFIRMED: "16:00 last tick not yet confirmed by next session",
  PRICE_IMPACT_EXCEEDED: "price impact above your limit",
  REFERENCE_DEVIATION_EXCEEDED: "executable price deviates from reference beyond your limit",
  STEP_AWAITING_CONFIRMATION: "previous step awaits on-chain confirmation",
  CONTEXT_UNAVAILABLE: "market context unavailable",
  CONTEXT_STALE: "a context field is stale",
  EVENT_WINDOW_ACTIVE: "inside an event window you chose to avoid",
  EARNINGS_WINDOW_ACTIVE: "inside the earnings window",
  STEP_GAP_NOT_ELAPSED: "minimum gap since last confirmed step not elapsed",
  CASH_FLOOR_BLOCK: "cash floor would be breached",
  BUDGET_GROUP_CONFLICT: "budget group has no reservation for this task",
  THESIS_INVALIDATED: "a thesis premise was invalidated",
  THESIS_EXPIRED: "thesis validity expired",
  EXECUTOR_OFFLINE: "no executor heartbeat (information only)",
  AWAITING_USER_SIGNATURE: "waiting for the owner's signature (information only)",
};
export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}

const inWindow = (t: Date, w: RecapWindow) => t.getTime() >= w.dayStartUtc.getTime() && t.getTime() < w.dayEndUtc.getTime();
const add = (a: string, b: string) => (BigInt(a) + BigInt(b)).toString();

function modeOf(evidenceMode: "LIVE" | "FIXTURE"): RecapMode {
  return evidenceMode === "LIVE" ? "LIVE" : "FIXTURE";
}

function labelOf(json: MandateJson): string {
  const outs = json.legs.map((l) => l.outputAssetKey.split(":")[2]?.slice(0, 6) ?? l.outputAssetKey).join("+");
  return `${json.side} ${outs} · ${json.sku}`;
}

export interface BuildRecapInput {
  id: string;
  owner: string;
  window: RecapWindow;
  now: Date;
  mandates: MandateBundle[];
  evidenceMode: "LIVE" | "FIXTURE";
  /** Lane B 任务；null = 未接上 */
  tasks: Task[] | null;
  /** Lane D 事件数；null = 未接上 */
  eventsAvailable: boolean;
}

export function buildRecap(i: BuildRecapInput): Recap {
  const w = i.window;
  const baseMode = modeOf(i.evidenceMode);
  const handled: RecapTaskLine[] = [];
  const waited: RecapWaitLine[] = [];
  const trades: RecapTrade[] = [];
  const remaining: RecapRemaining[] = [];
  const decisions: RecapDecision[] = [];
  const timeline: RecapTimelineEntry[] = [];
  const ledgerMap = new Map<string, RecapLedgerLine>();
  const modes = new Set<RecapMode>();
  const remixable: RecapRemixable[] = [];
  const milestones: RecapMilestone[] = [];

  let firstAuth: { at: Date; refId: string } | null = null;
  let firstConfirmed: { at: Date; refId: string; txHash: string | null } | null = null;
  let firstCompletion: { at: Date; refId: string } | null = null;

  for (const m of i.mandates) {
    const json = m.row.mandateJson as MandateJson;
    const label = labelOf(json);
    const mode = baseMode;
    modes.add(mode);
    const inputAssetKey = json.side === "sell" ? (json.legs[0]?.outputAssetKey ?? json.inputAssetKey) : json.inputAssetKey;
    const outputAssetKey = json.side === "sell" ? json.inputAssetKey : (json.legs[0]?.outputAssetKey ?? "");

    if (!firstAuth || m.row.createdAt < firstAuth.at) firstAuth = { at: m.row.createdAt, refId: m.row.id };
    if (m.row.state === "COMPLETED" && (!firstCompletion || m.row.updatedAt < firstCompletion.at)) firstCompletion = { at: m.row.updatedAt, refId: m.row.id };
    if (inWindow(m.row.createdAt, w)) timeline.push({ at: m.row.createdAt.toISOString(), refId: m.row.id, type: "status", text: `authorization registered (${json.sku}, ${m.row.maxSteps} step(s))` });

    // 评估：等待原因按原因码聚合
    const evals = [...m.evaluations].sort((a, b) => a.evaluatedAt.getTime() - b.evaluatedAt.getTime());
    const reasonCount = new Map<string, number>();
    for (const e of evals) {
      const reasons = (e.reasonsJson as Array<{ code: string; severity?: string }> | null) ?? [];
      if (e.status === "WAIT" || e.status === "BLOCKED") for (const r of reasons) if (r.severity !== "info") reasonCount.set(r.code, (reasonCount.get(r.code) ?? 0) + 1);
      timeline.push({ at: e.evaluatedAt.toISOString(), refId: m.row.id, type: "evaluation", text: `${e.status}${reasons.length ? `: ${reasons.map((r) => r.code).join(", ")}` : ""}` });
    }
    const latestEval = evals.at(-1) ?? null;
    const blockers: RecapReason[] = latestEval && latestEval.status !== "READY" ? (((latestEval.reasonsJson as Array<{ code: string }> | null) ?? []).map((r) => ({ code: r.code, text: reasonText(r.code) }))) : [];
    if (reasonCount.size > 0) waited.push({ refId: m.row.id, label, reasons: [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => ({ code, text: reasonText(code) })), evaluations: evals.length, nextCheckAt: null });

    // 步骤：只有 CONFIRMED（链上回执）进账目；REVERTED 记时间线不进账目
    for (const s of [...m.steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
      const sj = s.stepJson as { step: { amountIn: string; outputToken: string } };
      const receipt = (s.receiptJson as { event?: { received?: string } } | null) ?? null;
      const at = s.updatedAt;
      if (s.state === "CONFIRMED" && inWindow(at, w)) {
        const received = receipt?.event?.received ?? null;
        trades.push({ at: at.toISOString(), refId: m.row.id, stepIndex: s.stepIndex, side: json.side, inputAssetKey, outputAssetKey, amountInRaw: sj.step.amountIn, receivedRaw: received, txHash: s.txHash, state: s.state, mode });
        timeline.push({ at: at.toISOString(), refId: m.row.id, type: "step_confirmed", text: `step ${s.stepIndex} confirmed`, assetKey: inputAssetKey, amountRaw: sj.step.amountIn, receivedRaw: received ?? undefined, txHash: s.txHash });
        const line = ledgerMap.get(inputAssetKey) ?? { assetKey: inputAssetKey, spentRaw: "0", receivedRaw: "0", steps: 0 };
        line.spentRaw = add(line.spentRaw, sj.step.amountIn);
        line.receivedRaw = add(line.receivedRaw, received ?? "0");
        line.steps += 1;
        ledgerMap.set(inputAssetKey, line);
        if (!firstConfirmed || at < firstConfirmed.at) firstConfirmed = { at, refId: m.row.id, txHash: s.txHash };
      } else if (s.state === "REVERTED" && inWindow(at, w)) {
        timeline.push({ at: at.toISOString(), refId: m.row.id, type: "step_reverted", text: `step ${s.stepIndex} reverted on-chain (not counted)`, txHash: s.txHash });
      } else if (inWindow(s.createdAt, w)) {
        timeline.push({ at: s.createdAt.toISOString(), refId: m.row.id, type: "step_issued", text: `step ${s.stepIndex} certificate issued (${s.state})` });
      }
    }

    handled.push({ refId: m.row.id, refKind: "mandate", label, status: m.row.state, mode, steps: { done: m.row.stepsDone, max: m.row.maxSteps }, blockers, nextCheckAt: null });
    const stepsLeft = m.row.maxSteps - m.row.stepsDone;
    if ((m.row.state === "ACTIVE" || m.row.state === "PAUSED") && stepsLeft > 0) remaining.push({ refId: m.row.id, label, stepsLeft, deadline: m.row.deadline.toISOString() });
    if (m.row.state === "PAUSED") decisions.push({ refId: m.row.id, label, code: "PAUSED", text: "Issuance is paused by you; resume or revoke on-chain to stop for good.", action: "resume" });
    if ((m.row.state === "ACTIVE" || m.row.state === "PAUSED") && m.row.deadline.getTime() - i.now.getTime() < 24 * 3600_000) decisions.push({ refId: m.row.id, label, code: "EXPIRING", text: "Authorization expires within 24 h; unfinished steps need a new authorization.", action: "extend" });
    if (m.row.state === "CANCELLED") decisions.push({ refId: m.row.id, label, code: "CANCELLED_OFFCHAIN", text: "Service-side cancel only stops new certificates; an already-issued, unexpired certificate may still execute. Revoke on PlanGuard to stop for good.", action: "revoke" });
    remixable.push({ refId: m.row.id, refKind: "mandate", structure: { side: json.side, inputAssetKey: json.inputAssetKey, outputAssetKeys: json.legs.map((l) => l.outputAssetKey), steps: m.row.maxSteps }, remixHref: `/agent?remix=mandate:${m.row.id}` });
  }

  // v6 任务（Lane B）：接上后才有内容；未接上 coverage=unavailable
  if (i.tasks) {
    for (const t of i.tasks) {
      const tmode: RecapMode = "SIMULATION"; // Task 本身不带 evidenceMode；授权前一律视为模拟/草案，授权后由 mandate 行覆盖
      modes.add(tmode);
      handled.push({ refId: t.id, refKind: "task", label: `${t.playbookId} · ${t.goal.side} ${t.goal.legs.map((l) => l.outputAssetKey.split(":")[2]?.slice(0, 6)).join("+")}`, status: t.status, mode: tmode, steps: { done: 0, max: 0 }, blockers: t.blockers.map((b) => ({ code: b.code, text: b.text })), nextCheckAt: t.nextCheckAt });
      if (t.status === "WAITING" && t.blockers.length) waited.push({ refId: t.id, label: t.playbookId, reasons: t.blockers.map((b) => ({ code: b.code, text: b.text })), evaluations: 0, nextCheckAt: t.nextCheckAt });
      for (const b of t.blockers) if (b.userActionRequired) decisions.push({ refId: t.id, label: t.playbookId, code: b.code, text: b.text, action: "review" });
      if (t.status === "AWAITING_AUTHORIZATION") decisions.push({ refId: t.id, label: t.playbookId, code: "AWAITING_AUTHORIZATION", text: "Task drafted but not authorized; sign the TradeMandate to let it run.", action: "authorize" });
      remixable.push({ refId: t.id, refKind: "task", structure: { side: t.goal.side, inputAssetKey: t.goal.budget.inputAssetKeys[0] ?? "", outputAssetKeys: t.goal.legs.map((l) => l.outputAssetKey), policyId: t.goal.policyId, steps: 0 }, remixHref: `/agent?remix=task:${t.id}` });
    }
  }

  if (firstAuth) milestones.push({ id: "first_authorization", label: { en: "First authorization signed", zh: "第一次签署授权" }, at: firstAuth.at.toISOString(), evidence: { refId: firstAuth.refId } });
  if (firstConfirmed) milestones.push({ id: "first_step_confirmed", label: { en: "First step confirmed on X Layer", zh: "第一步在 X Layer 确认" }, at: firstConfirmed.at.toISOString(), evidence: { refId: firstConfirmed.refId, txHash: firstConfirmed.txHash } });
  if (firstCompletion) milestones.push({ id: "first_full_completion", label: { en: "First authorization fully completed", zh: "第一次授权全部完成" }, at: firstCompletion.at.toISOString(), evidence: { refId: firstCompletion.refId } });

  timeline.sort((a, b) => a.at.localeCompare(b.at));
  if (modes.size === 0) modes.add(baseMode);
  return {
    id: i.id,
    owner: i.owner,
    date: w.date,
    tz: "America/New_York",
    closeAtUtc: w.closeAtUtc?.toISOString() ?? "",
    earlyClose: w.earlyClose,
    generateAfterUtc: w.generateAfterUtc?.toISOString() ?? "",
    generatedAt: i.now.toISOString(),
    modes: [...modes],
    coverage: { mandates: "ok", tasks: i.tasks ? "ok" : "unavailable", events: i.eventsAvailable ? "ok" : "unavailable" },
    sections: { handled, waited, trades, remaining, decisions },
    ledger: [...ledgerMap.values()],
    timeline,
    milestones,
    remixable,
    share: { public: false, hideAssets: true, hideAmounts: true, shareId: null, publicUrl: null },
  };
}

/** 确定性 id：同一 owner + 交易日总是同一份 */
export function recapId(callerId: string, owner: string, date: string): string {
  return `rcp_${hashCanonical({ callerId, owner: owner.toLowerCase(), date }).slice(2, 26)}`;
}

/** R-02 复算：账目每资产 spentRaw 必须等于时间线里 step_confirmed 的 amountRaw 之和 */
export function ledgerMatchesTimeline(r: Pick<Recap, "ledger" | "timeline">): boolean {
  const sum = new Map<string, bigint>();
  for (const t of r.timeline) if (t.type === "step_confirmed" && t.assetKey && t.amountRaw) sum.set(t.assetKey, (sum.get(t.assetKey) ?? 0n) + BigInt(t.amountRaw));
  for (const l of r.ledger) if ((sum.get(l.assetKey) ?? 0n) !== BigInt(l.spentRaw)) return false;
  for (const [k, v] of sum) if (!r.ledger.some((l) => l.assetKey === k && BigInt(l.spentRaw) === v)) return false;
  return true;
}

/** R-04 公开视图：owner 恒隐藏；可选隐藏资产与金额 */
export function publicRecapView(r: Recap): Record<string, unknown> {
  const hideA = r.share.hideAssets;
  const hideM = r.share.hideAmounts;
  const asset = (k: string) => (hideA ? "hidden" : k);
  const amt = (v: string | null | undefined) => (hideM ? null : (v ?? null));
  return {
    shareId: r.share.shareId,
    date: r.date,
    tz: r.tz,
    earlyClose: r.earlyClose,
    generatedAt: r.generatedAt,
    modes: r.modes,
    privacy: { owner: "hidden", assets: hideA ? "hidden" : "shown", amounts: hideM ? "hidden" : "shown" },
    summary: { handled: r.sections.handled.length, waited: r.sections.waited.length, trades: r.sections.trades.length, remaining: r.sections.remaining.length, decisions: r.sections.decisions.length },
    waitedReasons: r.sections.waited.flatMap((x) => x.reasons.map((y) => y.code)),
    trades: r.sections.trades.map((t) => ({ at: t.at, side: t.side, inputAssetKey: asset(t.inputAssetKey), outputAssetKey: asset(t.outputAssetKey), amountInRaw: amt(t.amountInRaw), receivedRaw: amt(t.receivedRaw), txHash: t.txHash, mode: t.mode })),
    ledger: r.ledger.map((l) => ({ assetKey: asset(l.assetKey), spentRaw: amt(l.spentRaw), receivedRaw: amt(l.receivedRaw), steps: l.steps })),
    milestones: r.milestones,
    remixable: r.remixable.map((x) => ({ refKind: x.refKind, structure: { ...x.structure, inputAssetKey: asset(x.structure.inputAssetKey), outputAssetKeys: x.structure.outputAssetKeys.map(asset) }, remixHref: x.remixHref })),
  };
}
