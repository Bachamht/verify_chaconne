/**
 * MarketContext（interfaces §11.3）结构校验——纯函数，零依赖。
 *
 * 只保留契约里声明的键：任何未知顶层键（如 producer 私有研究、预测台账、阈值）在这里被丢弃，
 * 于是永远不会进入证据、快照或任何响应（X-06 黑名单扫描的根）。
 * 每个 CtxField 必须齐全：{value, source, observedAt, fetchedAt, status, purposes, note?}——缺键即拒收，不用默认值冒充。
 */
import type { CtxField, CtxPurpose, CtxStatus, MarketContext, MarketEvent } from "../contracts";
import { validateMarketEvent } from "../events/events";

export interface ContextSchemaError {
  path: string;
  code: string;
}
export type ContextSchemaResult = { ok: true; ctx: MarketContext } | { ok: false; errors: ContextSchemaError[] };

/** ISO-8601 带时区（crowsnest 输出 `+00:00`，TS 输出 `Z`；两者都收，签名载荷保留原串） */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
/** CV-D12：数值型字段 value 一律十进制字符串（canon-1 只允许安全整数，浮点进不了签名） */
const DECIMAL_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const STATUSES: ReadonlySet<string> = new Set<CtxStatus>(["ok", "stale", "unavailable", "unfinished"]);
const PURPOSES: ReadonlySet<string> = new Set<CtxPurpose>(["internal", "display", "agent", "paid"]);

/** 字段路径 → 值类型校验器（value 为 null 时不校验类型） */
type ValueCheck = (v: unknown) => boolean;
const isNum: ValueCheck = (v) => typeof v === "string" && DECIMAL_RE.test(v) && Number.isFinite(Number(v));
const isBool: ValueCheck = (v) => typeof v === "boolean";
const isStr: ValueCheck = (v) => typeof v === "string";
const isIso: ValueCheck = (v) => typeof v === "string" && ISO_RE.test(v);
const isSessionLabel: ValueCheck = (v) => v === "ASIA" || v === "EU_OPEN" || v === "US_PRE" || v === "US_REGULAR" || v === "US_POST";
const isCrossAsset: ValueCheck = (v) => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["eventId"] === "string" && (o["state"] === "relief" || o["state"] === "transmission" || o["state"] === "divergence" || o["state"] === "undecided") && isIso(o["atUtc"]);
};

/** 契约字段清单：路径 → 值校验。顺序即响应里的键顺序（tier 裁剪时逐一保留）。 */
export const CONTEXT_FIELD_PATHS: ReadonlyArray<readonly [string, ValueCheck]> = [
  ["session.label", isSessionLabel],
  ["session.usTradingDay", isBool],
  ["session.holiday", isStr],
  ["session.earlyClose", isBool],
  ["session.hoursToUsOpen", isNum],
  ["session.hoursToUsClose", isNum],
  ["session.etDate", isStr],
  ["fed.blackout", isBool],
  ["fed.blackoutUntil", isIso],
  ["fed.hikeProb", isNum],
  ["fed.hikeProbDrift24hPp", isNum],
  ["rates.y2", isNum],
  ["rates.y10", isNum],
  ["rates.y30", isNum],
  ["rates.s2s30Bp", isNum],
  ["rates.curveShape", isStr],
  ["rates.realYield10", isNum],
  ["rates.move", isNum],
  ["risk.vix", isNum],
  ["risk.nqOvernightPct", isNum],
  ["risk.esOvernightPct", isNum],
  ["risk.dxy", isNum],
  ["risk.dxyPct1d", isNum],
  ["crossAsset.lastDataRelease", isCrossAsset],
  ["driftVerdict", isStr],
];
export const CONTEXT_GROUPS = ["session", "fed", "rates", "risk", "crossAsset"] as const;

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

function validateField(raw: unknown, path: string, check: ValueCheck, errors: ContextSchemaError[]): CtxField<unknown> | null {
  if (typeof raw !== "object" || raw === null) {
    errors.push({ path, code: "field_missing" });
    return null;
  }
  const o = raw as Record<string, unknown>;
  const before = errors.length;
  if (!("value" in o)) errors.push({ path: `${path}.value`, code: "missing" });
  if (typeof o["source"] !== "string") errors.push({ path: `${path}.source`, code: "expected_string" });
  if (o["observedAt"] !== null && !isIso(o["observedAt"])) errors.push({ path: `${path}.observedAt`, code: "expected_iso_or_null" });
  if (!isIso(o["fetchedAt"])) errors.push({ path: `${path}.fetchedAt`, code: "expected_iso" });
  if (!STATUSES.has(String(o["status"]))) errors.push({ path: `${path}.status`, code: "unknown_status" });
  const purposes = o["purposes"];
  if (!Array.isArray(purposes) || purposes.some((p) => !PURPOSES.has(String(p)))) errors.push({ path: `${path}.purposes`, code: "expected_purpose_list" });
  if (o["note"] !== undefined && typeof o["note"] !== "string") errors.push({ path: `${path}.note`, code: "expected_string" });
  if (o["value"] !== null && o["value"] !== undefined && !check(o["value"])) errors.push({ path: `${path}.value`, code: "wrong_type" });
  if (errors.length !== before) return null;
  const field: CtxField<unknown> = {
    value: o["value"] === undefined ? null : o["value"],
    source: o["source"] as string,
    observedAt: (o["observedAt"] as string | null) ?? null,
    fetchedAt: o["fetchedAt"] as string,
    status: o["status"] as CtxStatus,
    purposes: [...(purposes as CtxPurpose[])],
    ...(typeof o["note"] === "string" ? { note: o["note"] } : {}),
  };
  return field;
}

/** 校验并重建：只含契约键；事件逐条校验（events.ts）。 */
export function validateMarketContext(raw: unknown): ContextSchemaResult {
  const errors: ContextSchemaError[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: [{ path: "$", code: "not_object" }] };
  const o = raw as Record<string, unknown>;
  if (o["schemaVersion"] !== "chaconne-context/1") errors.push({ path: "schemaVersion", code: "unsupported" });
  if (o["producer"] !== "crowsnest") errors.push({ path: "producer", code: "unknown_producer" });
  if (!isIso(o["packagedAt"])) errors.push({ path: "packagedAt", code: "expected_iso" });
  if (typeof o["signature"] !== "string" || o["signature"].length === 0) errors.push({ path: "signature", code: "expected_string" });
  if (o["signatureAlg"] !== "ed25519") errors.push({ path: "signatureAlg", code: "unsupported" });
  if (typeof o["publicKeyId"] !== "string" || o["publicKeyId"].length === 0) errors.push({ path: "publicKeyId", code: "expected_string" });
  // CV-D13：provenance.mode 可选；缺省视为 live（摄入方记录来源 URL）
  let provenance: MarketContext["provenance"] | undefined;
  if (o["provenance"] !== undefined) {
    const pv = o["provenance"] as Record<string, unknown> | null;
    const mode = pv && typeof pv === "object" ? pv["mode"] : undefined;
    if (mode !== "live" && mode !== "backfill" && mode !== "sample") errors.push({ path: "provenance.mode", code: "expected_live|backfill|sample" });
    else provenance = { mode };
  }
  const out: Record<string, unknown> = {};
  for (const [path, check] of CONTEXT_FIELD_PATHS) {
    const f = validateField(getPath(o, path), path, check, errors);
    if (f) setPath(out, path, f);
  }
  const events: MarketEvent[] = [];
  if (!Array.isArray(o["events"])) errors.push({ path: "events", code: "expected_array" });
  else {
    (o["events"] as unknown[]).forEach((e, i) => {
      const r = validateMarketEvent(e);
      if (r.ok) events.push(r.event);
      else for (const err of r.errors) errors.push({ path: `events[${i}].${err.path}`, code: err.code });
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  const ctx = {
    schemaVersion: "chaconne-context/1" as const,
    producer: "crowsnest" as const,
    packagedAt: o["packagedAt"] as string,
    signature: o["signature"] as string,
    signatureAlg: "ed25519" as const,
    publicKeyId: o["publicKeyId"] as string,
    session: out["session"],
    events,
    fed: out["fed"],
    rates: out["rates"],
    risk: out["risk"],
    crossAsset: out["crossAsset"],
    driftVerdict: out["driftVerdict"],
    ...(provenance ? { provenance } : {}),
  } as MarketContext;
  return { ok: true, ctx };
}

/** CV-D13：只有 live 可参与 LIVE 判定；缺省 = live */
export function contextProvenanceMode(ctx: Pick<MarketContext, "provenance">): "live" | "backfill" | "sample" {
  return ctx.provenance?.mode ?? "live";
}

/** 读取字段（按路径）；不存在返回 null（契约里不该发生，防御用） */
export function contextField(ctx: MarketContext, path: string): CtxField<unknown> | null {
  const v = getPath(ctx, path);
  return typeof v === "object" && v !== null && "status" in (v as object) ? (v as CtxField<unknown>) : null;
}

/** 逐字段遍历（含 events 作为一个伪字段 "events"） */
export function contextFieldEntries(ctx: MarketContext): Array<[string, CtxField<unknown>]> {
  const out: Array<[string, CtxField<unknown>]> = [];
  for (const [path] of CONTEXT_FIELD_PATHS) {
    const f = contextField(ctx, path);
    if (f) out.push([path, f]);
  }
  return out;
}

export { getPath as contextPathGet, setPath as contextPathSet };
