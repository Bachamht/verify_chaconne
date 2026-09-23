"use client";
/** 事件台接口（Lane D）：GET /v1/event-impacts、POST /v1/event-impacts/actions。字段以 verify-service impacts/service.ts 为准。 */
import type { Blocker, Condition, EventImpact, EvidenceRecord, ImpactAction, MarketEvent } from "@chaconne/core/verify";

export type Relevance = "holding_and_task" | "holding" | "task" | "universe";
export interface RuleView {
  taskId: string;
  ruleLabel: string;
  active: boolean;
  upcoming: boolean;
  needsChoice: boolean;
  nextCheckAt: string | null;
  window: { startUtc: string; endUtc: string; basis: string } | null;
}
export interface EventDeskItem {
  event: MarketEvent;
  impact: EventImpact;
  relevance: Relevance;
  rules: RuleView[];
  blockers: Blocker[];
  noteCode: "MACRO_RESEARCH_ONLY" | "COMPANY_EVENT" | null;
}
export interface AssetCoverageView {
  assetKey: string;
  displaySymbol: string;
  underlyingId: string;
  executionAllowed: boolean;
  coverage: "covered" | "unknown" | "unavailable" | "not_probed";
  code: "EARNINGS_COVERAGE_UNKNOWN" | null;
  lastProbedAt: string | null;
  sharesPerToken: string | null;
}
export interface ImpactsResponse {
  owner: string;
  horizonHours: number;
  generatedAt: string;
  holdings: { status: "ok" | "unavailable"; note: string | null; asOf: string | null; count: number };
  tasks: { status: "ok" | "unavailable"; note: string | null; count: number };
  impacts: EventImpact[];
  items: EventDeskItem[];
  coverage: AssetCoverageView[];
  corporateActions: { status: "not_connected"; note: string };
}
export type ActionEffect = "evidence" | "created" | "attached" | "draft" | "kept" | "wait" | "needs_choice" | "paused" | "preview" | "not_ready" | "invalid";
export interface ActionResult {
  action: ImpactAction;
  eventId: string;
  taskId: string | null;
  effect: ActionEffect;
  executed: false;
  issuesExecution: false;
  mode: "SIMULATION" | null;
  code?: string;
  message: { zh: string; en: string };
  evidence?: EvidenceRecord[];
  draft?: unknown;
  nextCheckAt?: string | null;
  blockers?: Blocker[];
  taskStatus?: string;
  preview?: { proposedConditions: Condition[]; diff: Array<{ itemType: string; before: unknown; after: unknown }>; writesAuthorization: false };
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null; error: string | null }> {
  let res: Response;
  try {
    res = await fetch(`/agent/events/api/${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch {
    return { status: 0, data: null, error: "network" };
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const err = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : null;
  return { status: res.status, data: data as T, error: res.ok ? null : (err ?? `http_${res.status}`) };
}

export const eventDesk = {
  impacts: (owner: string, horizonHours: number) => call<ImpactsResponse>("GET", `v1/event-impacts?owner=${encodeURIComponent(owner)}&horizonHours=${horizonHours}`),
  action: (body: { owner: string; eventId: string; action: ImpactAction; taskId?: string | null; wholeDayIfDayPrecision?: boolean }) => call<ActionResult>("POST", "v1/event-impacts/actions", body),
};
