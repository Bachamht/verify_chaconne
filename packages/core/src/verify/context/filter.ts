/**
 * 按资产 / 任务过滤（interfaces §11.3 · X-05）：只返回相关事件与相关字段。
 *  - 资产：宏观事件 + 该标的的公司事件；
 *  - 任务：条件引用的事件类型 + 任务标的的公司事件；只有条件依赖的字段保留，其余标 `not_relevant`（键仍保留，X-04 的不变量对过滤同样成立）。
 */
import type { Condition, CtxField, EventKind, MarketContext, MarketEvent } from "../contracts";
import { COMPANY_EVENT_KINDS, eventRelevantTo, MACRO_EVENT_KINDS } from "../events/events";
import { CONTEXT_FIELD_PATHS, contextPathGet, contextPathSet } from "./schema";

export interface ContextFilter {
  /** 相关标的（registry underlyingId）；空数组 = 不按标的过滤 */
  underlyingIds?: string[];
  /** 相关事件类型；缺省 = 全部宏观类型 */
  eventKinds?: EventKind[];
  /** 相关字段路径（前缀匹配）；缺省 = 全部 */
  fieldPrefixes?: string[];
}

/** 从条件集推导相关事件类型与字段前缀 */
export function filterFromConditions(items: readonly Condition[]): Pick<ContextFilter, "eventKinds" | "fieldPrefixes"> {
  const kinds = new Set<EventKind>(["MARKET_HOLIDAY", "EARLY_CLOSE"]);
  const prefixes = new Set<string>(["session."]);
  for (const c of items) {
    switch (c.type) {
      case "avoid_event_window":
        for (const k of c.kinds) kinds.add(k);
        break;
      case "earnings_window":
        kinds.add("EARNINGS");
        break;
      case "not_in_fed_blackout":
        kinds.add("FED_BLACKOUT");
        prefixes.add("fed.blackout");
        break;
      case "max_vix":
        prefixes.add("risk.vix");
        break;
      case "max_move":
        prefixes.add("rates.move");
        break;
      case "require_cross_asset_confirmation":
        prefixes.add("crossAsset.");
        break;
      default:
        break;
    }
  }
  return { eventKinds: [...kinds], fieldPrefixes: [...prefixes] };
}

export function filterEvents(events: readonly MarketEvent[], f: ContextFilter): MarketEvent[] {
  return events.filter((ev) => {
    if (f.eventKinds && !f.eventKinds.includes(ev.kind)) return false;
    if (f.underlyingIds && f.underlyingIds.length > 0) {
      if (COMPANY_EVENT_KINDS.has(ev.kind)) return eventRelevantTo(ev, f.underlyingIds);
      return MACRO_EVENT_KINDS.has(ev.kind);
    }
    return true;
  });
}

export function filterContext(ctx: MarketContext, f: ContextFilter): MarketContext {
  const clone = structuredClone(ctx) as unknown as Record<string, unknown>;
  clone["events"] = filterEvents(ctx.events, f);
  if (f.fieldPrefixes) {
    for (const [path] of CONTEXT_FIELD_PATHS) {
      if (f.fieldPrefixes.some((p) => path.startsWith(p))) continue;
      const field = contextPathGet(clone, path) as CtxField<unknown> | undefined;
      if (!field || field.note === "not_in_tier") continue;
      contextPathSet(clone, path, { value: null, source: field.source, observedAt: null, fetchedAt: field.fetchedAt, status: "unavailable", purposes: [], note: "not_relevant" } satisfies CtxField<null>);
    }
  }
  return clone as unknown as MarketContext;
}
