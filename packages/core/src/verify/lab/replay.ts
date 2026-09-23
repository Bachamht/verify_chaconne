/**
 * 决策回放（C9 · L-03 / L-04 / L-05）：在 [from, to] 上按固定步长取评估点，**每个评估点只用当时已可知的数据**：
 *  - 证据记录按 `time.receivedAt ≤ t`；
 *  - 上下文快照按 `receivedAt ≤ t` 且 `packagedAt ≤ t`，取最新一份；
 *  - 事件按 `firstKnownAt ≤ t` 选每个 id 的最新可知修订（后来才可知的修订不用）；
 *  - 依赖 quote 的条件在无 quote 时点 → INSUFFICIENT_EVIDENCE，阻塞项 text 带 `[NO_QUOTE]`；
 *  - 参考价（premium_1h）只作背景与覆盖/缺口统计，绝不当 quote；断供清空区间 → gaps REFERENCE_PURGED；
 *  - 无任何档案的时点 → gaps NO_ARCHIVE。
 * 输出没有任何收益字段（类型即约束；测试用黑名单扫描）。
 */
import type { Blocker, ConditionOutcome, ConditionSet, IsoUtc, MarketEvent, PlaybookId, ReplayGapReason, ReplayRun } from "../contracts";
import type { ConditionEvaluator, ConditionEvidenceInput, ConditionTaskState, ReplayArchive } from "./types";
import { explainWait } from "./explainWait";
import type { LabLocale } from "./reasonText";

/** 需要 quote 才能判定的条件类型 */
export const QUOTE_DEPENDENT_TYPES: ReadonlySet<string> = new Set(["premium_bps_lte", "target_price_gte", "target_price_lte", "tracked_cost_pnl_pct_gte"]);
/** 报价可见窗口：评估点之前多久内收到的 quote 才算"有 quote" */
export const REPLAY_QUOTE_LOOKBACK_MS = 5 * 60_000;
/** 证据可见窗口（非 quote）：太久之前的记录不算该时点的档案 */
export const REPLAY_EVIDENCE_LOOKBACK_MS = 24 * 3600_000;

export interface RunReplayInput {
  id: string;
  playbookId: PlaybookId;
  conditions: ConditionSet;
  assetKey: string;
  from: IsoUtc;
  to: IsoUtc;
  /** 评估步长（分钟），默认 60 */
  stepMinutes?: number;
  archive: ReplayArchive;
  evaluator: ConditionEvaluator;
  taskState: ConditionTaskState;
  locale?: LabLocale;
  /** 评估点上限（防爆） */
  maxPoints?: number;
  /** CV-D13：provenance.mode='sample' 的上下文只能用于联调；默认排除（当作没有档案） */
  allowSample?: boolean;
}

export interface ReplayRunResult {
  run: ReplayRun;
  /** 回放产出的评估标 REPLAY（interfaces §11.12） */
  mode: "REPLAY";
  evaluatorId: string;
  /** 各来源在区间内的记录数（页面"数据取不到显示不可用"用） */
  sources: { verify_evidence: number; verify_context_snapshots: number; premium_1h: number; events: number };
  /** CV-D13：各评估点实际用到的上下文来源模式计数；backfill / sample 只能出 REPLAY，绝不当 LIVE；excludedSample = 因未允许而被排除的 sample 快照数 */
  contextProvenance: { live: number; backfill: number; sample: number; unknown: number; excludedSample: number };
  note: { en: string; zh: string };
}

/** 事件按 firstKnownAt ≤ t 选每个 id 的最新可知修订 */
export function eventsKnownAsOf(versions: MarketEvent[], t: IsoUtc): MarketEvent[] {
  const tMs = Date.parse(t);
  const byId = new Map<string, MarketEvent>();
  for (const v of versions) {
    const known = Date.parse(v.firstKnownAt);
    if (!Number.isFinite(known) || known > tMs) continue; // 时间按毫秒比较（crowsnest 用 +00:00 后缀，不能按字符串比）
    const cur = byId.get(v.id);
    if (!cur || v.revision > cur.revision || (v.revision === cur.revision && known > Date.parse(cur.firstKnownAt))) byId.set(v.id, v);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

interface Interval { from: IsoUtc; to: IsoUtc }
function coalesce<T extends Interval>(items: T[], same: (a: T, b: T) => boolean): T[] {
  const out: T[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.to === it.from && same(last, it)) last.to = it.to;
    else out.push({ ...it });
  }
  return out;
}

export function runReplay(input: RunReplayInput): ReplayRunResult {
  const stepMs = Math.max(1, input.stepMinutes ?? 60) * 60_000;
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const maxPoints = input.maxPoints ?? 2000;
  const locale = input.locale ?? "en";
  const a = input.archive;
  const quoteDependent = input.conditions.items.some((i) => QUOTE_DEPENDENT_TYPES.has(i.type));
  const purged = a.referencePurged.map((p) => ({ from: Date.parse(p.from), to: Date.parse(p.to) }));

  const allowSample = input.allowSample === true;
  const prov = { live: 0, backfill: 0, sample: 0, unknown: 0, excludedSample: 0 };
  const usable = a.contextSnapshots.filter((s) => {
    if (s.context.provenance?.mode === "sample" && !allowSample) {
      prov.excludedSample++;
      return false;
    }
    return true;
  });
  const points: ReplayRun["points"] = [];
  const covRaw: Array<Interval & { sources: string[] }> = [];
  const gapRaw: Array<Interval & { reason: ReplayGapReason }> = [];

  for (let t = fromMs, n = 0; t <= toMs && n < maxPoints; t += stepMs, n++) {
    const tIso = new Date(t).toISOString();
    const tEnd = new Date(Math.min(t + stepMs, toMs)).toISOString();
    // 可见证据：receivedAt ≤ t 且在回看窗口内
    const visible = a.records.filter((r) => {
      const rt = Date.parse(r.time.receivedAt);
      return rt <= t && t - rt <= (r.payload.kind === "okx_quote" ? REPLAY_QUOTE_LOOKBACK_MS : REPLAY_EVIDENCE_LOOKBACK_MS);
    });
    const ctx = usable.filter((s) => Date.parse(s.receivedAt) <= t && Date.parse(s.context.packagedAt) <= t).sort((x, y) => Date.parse(y.context.packagedAt) - Date.parse(x.context.packagedAt))[0] ?? null;
    const ctxFresh = ctx && t - Date.parse(ctx.context.packagedAt) <= REPLAY_EVIDENCE_LOOKBACK_MS ? ctx : null;
    if (ctxFresh) {
      const m = ctxFresh.context.provenance?.mode;
      if (m === "live") prov.live++;
      else if (m === "backfill") prov.backfill++;
      else if (m === "sample") prov.sample++;
      else prov.unknown++;
    }
    const events = eventsKnownAsOf(a.eventVersions, tIso);
    const hasQuote = visible.some((r) => r.payload.kind === "okx_quote");
    const barAt = a.referenceBars.find((b) => Date.parse(b.ts) <= t && t - Date.parse(b.ts) < 3600_000) ?? null;
    const inPurged = purged.some((p) => t >= p.from && t < p.to);

    const sources: string[] = [];
    if (visible.length > 0) sources.push("verify_evidence");
    if (ctxFresh) sources.push("verify_context_snapshots");
    if (barAt && (barAt.refPriceUsd !== null || barAt.tokenPriceUsd !== null)) sources.push("premium_1h");

    const knownMs = [...visible.map((r) => Date.parse(r.time.receivedAt)), ...(ctxFresh ? [Date.parse(ctxFresh.receivedAt), Date.parse(ctxFresh.context.packagedAt)] : []), ...events.map((e) => Date.parse(e.firstKnownAt))].filter((x) => Number.isFinite(x) && x <= t);
    const knownAsOf = knownMs.length > 0 ? new Date(Math.max(...knownMs)).toISOString() : tIso;

    // 区间 [t, t+step)：最后一个评估点（t == to）只出点不出零长区间
    if (tEnd > tIso) {
      if (visible.length === 0 && !ctxFresh) gapRaw.push({ from: tIso, to: tEnd, reason: "NO_ARCHIVE" });
      else covRaw.push({ from: tIso, to: tEnd, sources });
      if (inPurged) gapRaw.push({ from: tIso, to: tEnd, reason: "REFERENCE_PURGED" });
      if (quoteDependent && !hasQuote) gapRaw.push({ from: tIso, to: tEnd, reason: "NO_QUOTE" });
    }

    const evIn: ConditionEvidenceInput = { records: visible, context: ctxFresh ? ctxFresh.context : null, events };
    const evaluation = input.evaluator.evaluate(input.conditions, evIn, input.taskState, tIso);
    const explained = explainWait(evaluation, evIn, locale);
    let outcome: ConditionOutcome = evaluation.outcome;
    const blockers: Blocker[] = [...explained.blockers];
    if (quoteDependent && !hasQuote) {
      if (outcome === "SATISFIED") outcome = "INSUFFICIENT_EVIDENCE";
      blockers.push({
        code: "QUOTE_UNAVAILABLE",
        evidenceIds: [],
        evidenceAt: null,
        nextCheckAt: null,
        userActionRequired: false,
        text: locale === "zh" ? "[NO_QUOTE] 该时点没有可用报价档案；依赖报价的条件按证据不足处理。" : "[NO_QUOTE] No quote archived at this point; quote-dependent conditions are treated as insufficient evidence.",
      });
    }
    if (visible.length === 0 && !ctxFresh && outcome === "SATISFIED") {
      // 无档案时不放行：没有任何当时可知的数据支撑"满足"
      outcome = "INSUFFICIENT_EVIDENCE";
      blockers.push({ code: "CONTEXT_UNAVAILABLE", evidenceIds: [], evidenceAt: null, nextCheckAt: null, userActionRequired: false, text: locale === "zh" ? "[NO_ARCHIVE] 该时点没有任何档案；不放行。" : "[NO_ARCHIVE] Nothing archived at this point; not passed." });
    }
    points.push({ t: tIso, outcome, blockers, knownAsOf });
  }

  const coverage = coalesce(covRaw, (x, y) => x.sources.join(",") === y.sources.join(","));
  const gaps = coalesce(
    gapRaw.sort((x, y) => (x.reason < y.reason ? -1 : x.reason > y.reason ? 1 : x.from < y.from ? -1 : 1)),
    (x, y) => x.reason === y.reason,
  ).sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.reason < y.reason ? -1 : 1));

  const run: ReplayRun = { id: input.id, playbookId: input.playbookId, conditions: input.conditions, assetKey: input.assetKey, from: input.from, to: input.to, points, coverage, gaps };
  return {
    run,
    mode: "REPLAY",
    evaluatorId: input.evaluator.id,
    sources: { verify_evidence: a.records.length, verify_context_snapshots: a.contextSnapshots.length, premium_1h: a.referenceBars.length, events: a.eventVersions.length },
    contextProvenance: prov,
    note: {
      en: "Replay shows which rule would have passed on data known at each point in time. It is not a backtest and reports no returns.",
      zh: "回放只显示在各时点已知数据下哪条规则会放行。它不是收益回测，不输出任何收益。",
    },
  };
}
