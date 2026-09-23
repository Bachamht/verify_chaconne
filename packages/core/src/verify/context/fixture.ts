/**
 * 测试/联调用 MarketContext 构造器（CV-D12：数值一律十进制字符串）。只造结构，不造签名——签名由测试用临时密钥对完成。
 * ⚠ 全部数值为明显桩值，不代表任何真实市场。
 */
import type { CtxField, CtxPurpose, IsoUtc, MarketContext, MarketEvent } from "../contracts";

const ALL: CtxPurpose[] = ["internal", "display", "agent", "paid"];
const INTERNAL_DISPLAY: CtxPurpose[] = ["internal", "display"];

export function ctxField<T>(value: T | null, at: IsoUtc, opts: { observedAt?: IsoUtc | null; purposes?: CtxPurpose[]; source?: string; status?: CtxField<T>["status"]; note?: string } = {}): CtxField<T> {
  return { value, source: opts.source ?? "fixture", observedAt: opts.observedAt === undefined ? at : opts.observedAt, fetchedAt: at, status: opts.status ?? (value === null ? "unavailable" : "ok"), purposes: opts.purposes ?? ALL, ...(opts.note ? { note: opts.note } : {}) };
}

export interface FixtureContextArgs {
  /** 打包时刻（各字段 fetchedAt/observedAt 默认同此） */
  at: IsoUtc;
  events?: MarketEvent[];
  publicKeyId?: string;
  provenance?: MarketContext["provenance"];
  /** 逐字段覆盖 */
  overrides?: Partial<{ vix: string | null; move: string | null; blackout: boolean; blackoutUntil: IsoUtc | null; crossAsset: { eventId: string; state: "relief" | "transmission" | "divergence" | "undecided"; atUtc: IsoUtc } | null; ratesObservedAt: IsoUtc; riskObservedAt: IsoUtc | null; sessionLabel: "ASIA" | "EU_OPEN" | "US_PRE" | "US_REGULAR" | "US_POST" }>;
}

/** 未签名的上下文（signature 占位；测试里再签） */
export function fixtureMarketContext(a: FixtureContextArgs): MarketContext {
  const at = a.at;
  const o = a.overrides ?? {};
  const ratesAt = o.ratesObservedAt ?? at;
  const riskAt = o.riskObservedAt === undefined ? at : o.riskObservedAt;
  return {
    schemaVersion: "chaconne-context/1",
    producer: "crowsnest",
    packagedAt: at,
    signature: "0x" + "00".repeat(64),
    signatureAlg: "ed25519",
    publicKeyId: a.publicKeyId ?? "test-k1",
    session: {
      label: ctxField(o.sessionLabel ?? "US_REGULAR", at),
      usTradingDay: ctxField(true, at),
      holiday: ctxField<string | null>(null, at, { status: "ok" }),
      earlyClose: ctxField(false, at),
      hoursToUsOpen: ctxField("0", at),
      hoursToUsClose: ctxField("5", at),
      etDate: ctxField(at.slice(0, 10), at),
    },
    events: a.events ?? [],
    fed: { blackout: ctxField(o.blackout ?? false, at), blackoutUntil: ctxField<IsoUtc | null>(o.blackoutUntil ?? null, at, { status: "ok" }), hikeProb: ctxField("42.5", at), hikeProbDrift24hPp: ctxField("2.3", at) },
    rates: { y2: ctxField("4.32", at, { observedAt: ratesAt }), y10: ctxField("4.96", at, { observedAt: ratesAt }), y30: ctxField("5.29", at, { observedAt: ratesAt }), s2s30Bp: ctxField("97", at, { observedAt: ratesAt }), curveShape: ctxField<string | null>("bear_steepener", at, { observedAt: ratesAt }), realYield10: ctxField("2.44", at, { observedAt: ratesAt }), move: ctxField(o.move === undefined ? "93.4" : o.move, at, { observedAt: ratesAt }) },
    risk: { vix: ctxField(o.vix === undefined ? "17.85" : o.vix, at, { observedAt: riskAt, purposes: INTERNAL_DISPLAY }), nqOvernightPct: ctxField<string>(null, at, { observedAt: null, purposes: INTERNAL_DISPLAY }), esOvernightPct: ctxField<string>(null, at, { observedAt: null, purposes: INTERNAL_DISPLAY }), dxy: ctxField("98.412", at, { observedAt: riskAt, purposes: INTERNAL_DISPLAY }), dxyPct1d: ctxField("-0.192", at, { observedAt: riskAt, purposes: INTERNAL_DISPLAY }) },
    crossAsset: { lastDataRelease: ctxField(o.crossAsset === undefined ? null : o.crossAsset, at, { status: "ok" }) },
    driftVerdict: ctxField("no drift", at),
    ...(a.provenance ? { provenance: a.provenance } : {}),
  };
}

export function fixtureEvent(over: Partial<MarketEvent> & { dateLocal: string }): MarketEvent {
  const kind = over.kind ?? "MACRO_TIER1";
  return {
    id: over.id ?? `fixture:${kind}:${over.dateLocal}:${(over.name ?? "event").toLowerCase().replace(/\s+/g, "-")}`,
    kind,
    name: over.name ?? "event",
    underlyingIds: over.underlyingIds ?? [],
    scheduledAtUtc: over.scheduledAtUtc ?? null,
    dateLocal: over.dateLocal,
    datePrecision: over.datePrecision ?? (over.scheduledAtUtc ? "exact" : "day"),
    sessionHint: over.sessionHint ?? null,
    status: over.status ?? "confirmed",
    revision: over.revision ?? 0,
    ...(over.revisedFrom ? { revisedFrom: over.revisedFrom } : {}),
    source: over.source ?? "fixture",
    sourceFetchedAt: over.sourceFetchedAt ?? `${over.dateLocal}T00:00:00.000Z`,
    firstKnownAt: over.firstKnownAt ?? "2026-09-01T00:00:00.000Z",
    ...(over.releasedAt ? { releasedAt: over.releasedAt } : {}),
    tz: over.tz ?? "America/New_York",
  };
}
