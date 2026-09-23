/**
 * 事件契约（interfaces §11.2）纯函数：结构校验、修订合并、窗口计算、证据 payload。
 *
 * 时间语义（§11.1）：scheduledAtUtc = 事件发生；firstKnownAt = 首次可知；sourceFetchedAt = 抓取。
 * 窗口不由 producer 决定：每个任务按自己的条件参数在这里算窗口。
 */
import { EVENT_KINDS, type EventKind, type IsoUtc, type MarketEvent, type MarketEventEvidence } from "../contracts";
import { zonedDayBoundsUtcMs } from "../conditions/calendarUtil";

export interface EventSchemaError {
  path: string;
  code: string;
}
export type EventSchemaResult = { ok: true; event: MarketEvent } | { ok: false; errors: EventSchemaError[] };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: ReadonlySet<string> = new Set(EVENT_KINDS);
const STATUSES: ReadonlySet<string> = new Set(["confirmed", "estimated", "revised", "cancelled", "released"]);
const PRECISIONS: ReadonlySet<string> = new Set(["exact", "day", "estimate"]);

/** 宏观 / 日历类事件：与所有标的相关（underlyingIds 为空） */
export const MACRO_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["MACRO_TIER1", "MACRO_TIER2", "FED_SPEECH", "FED_BLACKOUT", "MARKET_HOLIDAY", "EARLY_CLOSE"]);
/** 公司事件：必须带 underlyingIds */
export const COMPANY_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(["EARNINGS", "CORPORATE_ACTION"]);

export function validateMarketEvent(raw: unknown): EventSchemaResult {
  const errors: EventSchemaError[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: [{ path: "$", code: "not_object" }] };
  const o = raw as Record<string, unknown>;
  if (typeof o["id"] !== "string" || !/^[^:\s]+:[A-Z_0-9]+:\d{4}-\d{2}-\d{2}:[^\s]+$/.test(o["id"])) errors.push({ path: "id", code: "expected_source:kind:date:slug" });
  if (!KINDS.has(String(o["kind"]))) errors.push({ path: "kind", code: "unknown_kind" });
  if (typeof o["name"] !== "string") errors.push({ path: "name", code: "expected_string" });
  const underlying = o["underlyingIds"];
  if (!Array.isArray(underlying) || underlying.some((u) => typeof u !== "string")) errors.push({ path: "underlyingIds", code: "expected_string_array" });
  else if (COMPANY_EVENT_KINDS.has(o["kind"] as EventKind) && underlying.length === 0) errors.push({ path: "underlyingIds", code: "required_for_company_event" });
  if (o["scheduledAtUtc"] !== null && !ISO_RE.test(String(o["scheduledAtUtc"]))) errors.push({ path: "scheduledAtUtc", code: "expected_iso_or_null" });
  if (!DATE_RE.test(String(o["dateLocal"]))) errors.push({ path: "dateLocal", code: "expected_yyyy_mm_dd" });
  if (!PRECISIONS.has(String(o["datePrecision"]))) errors.push({ path: "datePrecision", code: "unknown_precision" });
  if (o["datePrecision"] === "exact" && o["scheduledAtUtc"] === null) errors.push({ path: "scheduledAtUtc", code: "required_when_exact" });
  if (o["sessionHint"] !== null && o["sessionHint"] !== "bmo" && o["sessionHint"] !== "amc" && o["sessionHint"] !== "dmh") errors.push({ path: "sessionHint", code: "unknown_hint" });
  if (!STATUSES.has(String(o["status"]))) errors.push({ path: "status", code: "unknown_status" });
  if (!Number.isInteger(o["revision"]) || (o["revision"] as number) < 0) errors.push({ path: "revision", code: "expected_nonneg_int" });
  if (o["revisedFrom"] !== undefined) {
    const rf = o["revisedFrom"] as Record<string, unknown> | null;
    if (typeof rf !== "object" || rf === null || (rf["scheduledAtUtc"] !== null && !ISO_RE.test(String(rf["scheduledAtUtc"]))) || !DATE_RE.test(String(rf["dateLocal"]))) errors.push({ path: "revisedFrom", code: "invalid" });
  }
  if (typeof o["source"] !== "string" || !o["source"]) errors.push({ path: "source", code: "expected_string" });
  if (!ISO_RE.test(String(o["sourceFetchedAt"]))) errors.push({ path: "sourceFetchedAt", code: "expected_iso" });
  if (!ISO_RE.test(String(o["firstKnownAt"]))) errors.push({ path: "firstKnownAt", code: "expected_iso" });
  if (o["releasedAt"] !== undefined && !ISO_RE.test(String(o["releasedAt"]))) errors.push({ path: "releasedAt", code: "expected_iso" });
  if (typeof o["tz"] !== "string" || !/^[A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$|^UTC$/.test(o["tz"])) errors.push({ path: "tz", code: "expected_iana_tz" });
  if (errors.length > 0) return { ok: false, errors };
  const event: MarketEvent = {
    id: o["id"] as string,
    kind: o["kind"] as EventKind,
    name: o["name"] as string,
    underlyingIds: [...(underlying as string[])],
    scheduledAtUtc: (o["scheduledAtUtc"] as string | null) ?? null,
    dateLocal: o["dateLocal"] as string,
    datePrecision: o["datePrecision"] as MarketEvent["datePrecision"],
    sessionHint: (o["sessionHint"] as MarketEvent["sessionHint"]) ?? null,
    status: o["status"] as MarketEvent["status"],
    revision: o["revision"] as number,
    ...(o["revisedFrom"] !== undefined ? { revisedFrom: { scheduledAtUtc: ((o["revisedFrom"] as Record<string, unknown>)["scheduledAtUtc"] as string | null) ?? null, dateLocal: (o["revisedFrom"] as Record<string, unknown>)["dateLocal"] as string } } : {}),
    source: o["source"] as string,
    sourceFetchedAt: o["sourceFetchedAt"] as string,
    firstKnownAt: o["firstKnownAt"] as string,
    ...(o["releasedAt"] !== undefined ? { releasedAt: o["releasedAt"] as string } : {}),
    tz: o["tz"] as string,
  };
  return { ok: true, event };
}

/**
 * 修订合并：按 id 合并，revision 递增才更新；firstKnownAt 取「已有值、producer 值、首次入库时刻」三者最早。
 * 返回 null = 不更新（旧修订或相同修订）。
 */
export function mergeEventRevision(existing: MarketEvent | null, incoming: MarketEvent, receivedAt: IsoUtc): { event: MarketEvent; isNew: boolean; isRevision: boolean } | null {
  const candidates = [incoming.firstKnownAt, receivedAt, ...(existing ? [existing.firstKnownAt] : [])].filter((x) => !Number.isNaN(Date.parse(x)));
  const firstKnownAt = candidates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? incoming.firstKnownAt;
  if (!existing) return { event: { ...incoming, firstKnownAt }, isNew: true, isRevision: false };
  if (incoming.revision <= existing.revision) return null;
  const changedTime = incoming.scheduledAtUtc !== existing.scheduledAtUtc || incoming.dateLocal !== existing.dateLocal;
  const revisedFrom = incoming.revisedFrom ?? (changedTime ? { scheduledAtUtc: existing.scheduledAtUtc, dateLocal: existing.dateLocal } : undefined);
  return { event: { ...incoming, firstKnownAt, ...(revisedFrom ? { revisedFrom } : {}) }, isNew: false, isRevision: true };
}

export type EventWindowSpec = { beforeMin: number; afterMin: number; includeEstimated: boolean; wholeDayIfDayPrecision: boolean };
export type EventWindow =
  | { kind: "exact"; fromMs: number; toMs: number }
  | { kind: "whole_day"; fromMs: number; toMs: number }
  /** 日期精度不足且用户未预选整日等待：不补时刻（EVENT_DATE_UNCERTAIN） */
  | { kind: "uncertain"; dayFromMs: number; dayToMs: number }
  | { kind: "ignored" };

/** 按任务参数算事件窗口。cancelled 事件与不含估计的估计事件 → ignored。 */
export function eventWindow(ev: MarketEvent, spec: EventWindowSpec): EventWindow {
  if (ev.status === "cancelled") return { kind: "ignored" };
  const estimated = ev.datePrecision === "estimate" || ev.status === "estimated";
  if (estimated && !spec.includeEstimated) return { kind: "ignored" };
  if (ev.datePrecision === "exact" && ev.scheduledAtUtc) {
    const t = Date.parse(ev.scheduledAtUtc);
    return { kind: "exact", fromMs: t - spec.beforeMin * 60_000, toMs: t + spec.afterMin * 60_000 };
  }
  const day = zonedDayBoundsUtcMs(ev.tz, ev.dateLocal);
  if (spec.wholeDayIfDayPrecision) return { kind: "whole_day", fromMs: day.startMs - spec.beforeMin * 60_000, toMs: day.endMs + spec.afterMin * 60_000 };
  return { kind: "uncertain", dayFromMs: day.startMs, dayToMs: day.endMs };
}

export function eventEvidencePayload(ev: MarketEvent): MarketEventEvidence {
  return { kind: "market_event", eventId: ev.id, eventKind: ev.kind, revision: ev.revision, status: ev.status, datePrecision: ev.datePrecision, scheduledAtUtc: ev.scheduledAtUtc, dateLocal: ev.dateLocal, firstKnownAt: ev.firstKnownAt };
}

/** 事件与标的是否相关：宏观事件对所有标的相关；公司事件按 underlyingIds 交集 */
export function eventRelevantTo(ev: MarketEvent, underlyingIds: readonly string[]): boolean {
  if (MACRO_EVENT_KINDS.has(ev.kind) && ev.underlyingIds.length === 0) return true;
  return ev.underlyingIds.some((u) => underlyingIds.includes(u));
}
