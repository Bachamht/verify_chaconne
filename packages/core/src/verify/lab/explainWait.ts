/**
 * 等待诊断（C9 · L-01）：把一次 ConditionEvaluation 展开成**全部**阻塞项（不止第一个），
 * 每项带证据时间、已知恢复点（未知写 null 并在 text 里说明为什么未知）、是否需要用户处理。
 * 文案来自 reasonText 映射表；不生成预测。
 */
import type { Blocker, ConditionEvaluation, ConditionOutcome, IsoUtc, ReasonCode } from "../contracts";
import type { ConditionEvidenceInput } from "./types";
import { blockerText, reasonBi, nextCheckUnknownBi, USER_ACTION_CODES, type BiText, type LabLocale } from "./reasonText";

export interface ExplainWaitResult {
  outcome: ConditionOutcome;
  evaluatedAt: IsoUtc;
  /** 全部阻塞项；text 按 locale */
  blockers: Blocker[];
  /** 与 blockers 同序的双语文案（页面切换语言不必重新请求） */
  i18n: Array<{ code: ReasonCode; en: string; zh: string }>;
  /** 各项已知恢复点的最小值；全部未知 → null */
  nextCheckAt: IsoUtc | null;
  nextCheckNote: BiText;
  /** blockers 中 userActionRequired=true 的子集 */
  userActionRequired: Blocker[];
}

/** 证据时间：该阻塞项引用的证据里最晚的 receivedAt；没有引用证据但依赖上下文 → context.packagedAt；都没有 → null */
function evidenceAtFor(evidenceIds: string[], ev: ConditionEvidenceInput, contextBased: boolean): IsoUtc | null {
  const times = ev.records.filter((r) => evidenceIds.includes(r.evidenceId)).map((r) => r.time.receivedAt).sort();
  const last = times[times.length - 1];
  if (last) return last;
  if (contextBased && ev.context) return ev.context.packagedAt;
  return null;
}

const CONTEXT_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["CONTEXT_UNAVAILABLE", "CONTEXT_STALE", "CONTEXT_FIELD_NOT_IN_TIER", "EVENT_WINDOW_ACTIVE", "EVENT_DATE_UNCERTAIN", "VOL_REGIME_EXCEEDED", "FED_BLACKOUT", "CROSS_ASSET_UNCONFIRMED"]);

export function explainWait(evaluation: ConditionEvaluation, evidence: ConditionEvidenceInput, locale: LabLocale = "en"): ExplainWaitResult {
  const blockers: Blocker[] = [];
  const i18n: ExplainWaitResult["i18n"] = [];
  const seen = new Set<string>();
  for (const item of evaluation.perItem) {
    if (item.outcome === "SATISFIED") continue;
    for (const r of item.reasons) {
      const key = `${r.code}:${[...r.evidenceIds].sort().join(",")}:${item.nextCheckAt ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const nextCheckAt = item.nextCheckAt;
      blockers.push({
        code: r.code,
        evidenceIds: [...r.evidenceIds],
        evidenceAt: evidenceAtFor(r.evidenceIds, evidence, CONTEXT_CODES.has(r.code)),
        nextCheckAt,
        userActionRequired: USER_ACTION_CODES.has(r.code),
        text: blockerText(r.code, nextCheckAt, locale),
      });
      const bi = reasonBi(r.code);
      const unk = nextCheckAt ? null : nextCheckUnknownBi(r.code);
      i18n.push({ code: r.code, en: unk ? `${bi.en} ${unk.en}` : bi.en, zh: unk ? `${bi.zh} ${unk.zh}` : bi.zh });
    }
  }
  const known = blockers.map((b) => b.nextCheckAt).filter((x): x is string => !!x).sort();
  const nextCheckAt = known[0] ?? evaluation.nextCheckAt ?? null;
  const allUnknown = blockers.length > 0 && known.length === 0;
  const nextCheckNote: BiText =
    blockers.length === 0
      ? { en: "No blockers: every condition is satisfied at this evaluation.", zh: "没有阻塞项：本次评估全部条件满足。" }
      : allUnknown
        ? { en: "No item has a known recovery time; the next check happens on the regular monitor cadence, not at a promised moment.", zh: "没有任何一项有已知恢复点；下次检查按 monitor 常规节奏进行，不承诺具体时刻。" }
        : known.length < blockers.length
          ? { en: "Earliest known recovery point among items; other items have no known time and may still block after it.", zh: "各项已知恢复点中最早的一个；其它项没有已知时间，到点后仍可能阻塞。" }
          : { en: "Earliest known recovery point among all items. Reaching it means re-checking, not a guaranteed pass.", zh: "全部项已知恢复点中最早的一个。到点只意味着重新检查，不保证通过。" };
  return { outcome: evaluation.outcome, evaluatedAt: evaluation.evaluatedAt, blockers, i18n, nextCheckAt, nextCheckNote, userActionRequired: blockers.filter((b) => b.userActionRequired) };
}
