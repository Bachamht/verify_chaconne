/**
 * v7 Lane D · D5 实际值时延测量（开发计划 §3.4 第 5 条；D-02 / A-09）：
 *   官方发布时刻 → crowsnest 抓到（fetchedAt）→ verify 入库（outcome_received_at）→ data_arrived 轮次开启 → 轮次开始
 *
 * 输入：任意 JSONL（scripts/captureEvent.ts 的 {capturedAt, url, body} 行、crowsnest 导出、DB 导出行均可）。
 * 每行递归找事件对象（有 id / kind / revision）与 DB 导出行（id|event_id + outcome_received_at）。
 * 来源诚实标注：
 *  - officialReleaseAt：outcome.publishedAt（有）否则 scheduledAtUtc（预定时刻，不是观测）
 *  - crowsnestFetchedAt：outcome.fetchedAt（有）否则首个「已到达」版本的 sourceFetchedAt
 *  - verifyReceivedAt：DB 的 outcome_received_at（精确）；没有 → 首个显示已到达的 verify 轮询 capturedAt（上界），
 *    并给出最后一个未到达轮询（下界）
 *  - 「已到达」信号：带 outcome；旧版服务会剥掉 outcome，退化为 status=released（标 status_released）
 * 只读数据、只做减法；不补、不估。
 */

type Json = Record<string, unknown>;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const ms = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);
const minIso = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b);
const maxIso = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);

export interface LatencyLine {
  file: string;
  /** 1-based */
  lineNo: number;
  text: string;
}

export type ArrivalSignal = "outcome" | "status_released";
export interface EventLatency {
  eventId: string;
  officialReleaseAt: string | null;
  officialReleaseSource: "outcome.publishedAt" | "scheduledAtUtc" | null;
  crowsnestFetchedAt: string | null;
  crowsnestFetchedSource: "outcome.fetchedAt" | "sourceFetchedAt" | null;
  verifyReceivedAt: string | null;
  verifyReceivedSource: "outcome_received_at" | "first_verify_poll_with_data" | null;
  /** 轮询模式下：最后一个仍未到达的 verify 轮询（下界） */
  verifyLastPollWithoutData: string | null;
  arrivalSignal: ArrivalSignal | null;
  turnOpenedAt: string | null;
  runStartedAt: string | null;
  deltasMs: {
    releaseToCrowsnest: number | null;
    crowsnestToVerify: number | null;
    releaseToVerify: number | null;
    verifyToTurnOpened: number | null;
    turnOpenedToRunStarted: number | null;
  };
  evidence: string[];
}

interface Acc {
  release: { at: string; src: "outcome.publishedAt" | "scheduledAtUtc" } | null;
  fetched: { at: string; src: "outcome.fetchedAt" | "sourceFetchedAt" } | null;
  receivedExact: string | null;
  firstPollWith: string | null;
  lastPollWithout: string | null;
  signal: ArrivalSignal | null;
  turnOpenedAt: string | null;
  runStartedAt: string | null;
  evidence: Set<string>;
}

function isEventObj(o: Json): boolean {
  return typeof o["id"] === "string" && typeof o["kind"] === "string" && typeof o["revision"] === "number";
}
function arrivalOf(o: Json): ArrivalSignal | null {
  if (o["outcome"] && typeof o["outcome"] === "object") return "outcome";
  if (o["status"] === "released") return "status_released";
  return null;
}
function walk(v: unknown, visit: (o: Json) => void, depth = 0): void {
  if (depth > 12 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit, depth + 1);
    return;
  }
  const o = v as Json;
  visit(o);
  for (const k of Object.keys(o)) walk(o[k], visit, depth + 1);
}

export interface LatencyOptions {
  /** 只看这些事件；缺省 = 所有出现「已到达」信号的 MACRO_TIER1 事件 */
  eventIds?: string[];
}

export function computeOutcomeLatency(lines: readonly LatencyLine[], opts: LatencyOptions = {}): EventLatency[] {
  const acc = new Map<string, Acc>();
  const tier1 = new Set<string>();
  const get = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) acc.set(id, (a = { release: null, fetched: null, receivedExact: null, firstPollWith: null, lastPollWithout: null, signal: null, turnOpenedAt: null, runStartedAt: null, evidence: new Set() }));
    return a;
  };
  // 两遍：先收集各事件的到达信号与精确入库时刻，再算轮询界（需要知道哪一行之后算「已到达」）
  type Poll = { id: string; at: string; sig: ArrivalSignal | null; ref: string };
  const polls: Poll[] = [];
  for (const ln of lines) {
    if (!ln.text.trim()) continue;
    let root: unknown;
    try {
      root = JSON.parse(ln.text);
    } catch {
      continue;
    }
    const ref = `${ln.file}:${ln.lineNo}`;
    const r = root as Json;
    const lineAt = [r["capturedAt"], r["observedAt"], r["at"], r["ts"]].find(isIso) as string | undefined;
    const fromVerify = typeof r["url"] === "string" && /\/v1\/(events|context)/.test(r["url"]);
    walk(root, (o) => {
      // DB 导出：{ id | event_id, outcome_received_at }
      const dbId = typeof o["event_id"] === "string" ? o["event_id"] : typeof o["id"] === "string" ? o["id"] : null;
      const recv = o["outcome_received_at"] ?? o["outcomeReceivedAt"];
      if (dbId && isIso(recv)) {
        const a = get(dbId);
        a.receivedExact = minIso(a.receivedExact, recv);
        a.evidence.add(ref);
      }
      // Lane A 轮次：{ eventId, reason: "data_arrived", requestedAt|openedAt, startedAt? }
      if (typeof o["eventId"] === "string" && o["reason"] === "data_arrived") {
        const a = get(o["eventId"]);
        const opened = [o["openedAt"], o["requestedAt"]].find(isIso) as string | undefined;
        if (opened) a.turnOpenedAt = minIso(a.turnOpenedAt, opened);
        if (isIso(o["startedAt"])) a.runStartedAt = minIso(a.runStartedAt, o["startedAt"]);
        a.evidence.add(ref);
      }
      if (!isEventObj(o)) return;
      const id = o["id"] as string;
      if (o["kind"] === "MACRO_TIER1") tier1.add(id);
      const a = get(id);
      const sig = arrivalOf(o);
      const outcome = (o["outcome"] ?? null) as Json | null;
      if (outcome && isIso(outcome["publishedAt"])) a.release = { at: minIso(a.release?.src === "outcome.publishedAt" ? a.release.at : null, outcome["publishedAt"])!, src: "outcome.publishedAt" };
      else if (!a.release && isIso(o["scheduledAtUtc"])) a.release = { at: o["scheduledAtUtc"], src: "scheduledAtUtc" };
      if (sig) {
        if (sig === "outcome" || !a.signal) a.signal = sig;
        if (outcome && isIso(outcome["fetchedAt"])) a.fetched = { at: minIso(a.fetched?.src === "outcome.fetchedAt" ? a.fetched.at : null, outcome["fetchedAt"])!, src: "outcome.fetchedAt" };
        else if (a.fetched?.src !== "outcome.fetchedAt" && isIso(o["sourceFetchedAt"])) a.fetched = { at: minIso(a.fetched?.at ?? null, o["sourceFetchedAt"])!, src: "sourceFetchedAt" };
        a.evidence.add(ref);
      }
      if (fromVerify && lineAt) polls.push({ id, at: lineAt, sig, ref });
    });
  }
  // 信号强度一致：若该事件出现过 outcome，只认带 outcome 的轮询为「已到达」
  const arrived = (p: Poll) => (acc.get(p.id)!.signal === "outcome" ? p.sig === "outcome" : p.sig !== null);
  for (const p of polls) {
    const a = acc.get(p.id)!;
    if (arrived(p)) a.firstPollWith = minIso(a.firstPollWith, p.at);
  }
  for (const p of polls) {
    const a = acc.get(p.id)!;
    if (!arrived(p) && (!a.firstPollWith || Date.parse(p.at) < Date.parse(a.firstPollWith))) a.lastPollWithout = maxIso(a.lastPollWithout, p.at);
  }
  const ids = opts.eventIds ?? [...acc.keys()].filter((id) => tier1.has(id) && acc.get(id)!.signal !== null);
  return ids
    .filter((id) => acc.has(id))
    .sort()
    .map((id) => {
      const a = acc.get(id)!;
      const received = a.receivedExact ?? a.firstPollWith;
      const d = (x: string | null | undefined, y: string | null | undefined) => (ms(x) !== null && ms(y) !== null ? ms(y)! - ms(x)! : null);
      return {
        eventId: id,
        officialReleaseAt: a.release?.at ?? null,
        officialReleaseSource: a.release?.src ?? null,
        crowsnestFetchedAt: a.fetched?.at ?? null,
        crowsnestFetchedSource: a.fetched?.src ?? null,
        verifyReceivedAt: received,
        verifyReceivedSource: a.receivedExact ? "outcome_received_at" : a.firstPollWith ? "first_verify_poll_with_data" : null,
        verifyLastPollWithoutData: a.receivedExact ? null : a.lastPollWithout,
        arrivalSignal: a.signal,
        turnOpenedAt: a.turnOpenedAt,
        runStartedAt: a.runStartedAt,
        deltasMs: {
          releaseToCrowsnest: d(a.release?.at, a.fetched?.at),
          crowsnestToVerify: d(a.fetched?.at, received),
          releaseToVerify: d(a.release?.at, received),
          verifyToTurnOpened: d(received, a.turnOpenedAt),
          turnOpenedToRunStarted: d(a.turnOpenedAt, a.runStartedAt),
        },
        evidence: [...a.evidence].sort().slice(0, 20),
      };
    });
}

const fmt = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(1)} s`);
/** test-results.md 用的表 */
export function latencyMarkdown(rows: readonly EventLatency[]): string {
  const head = "| event | release (source) | crowsnest fetchedAt (source) | verify received (source) | release→crowsnest | crowsnest→verify | release→verify | verify→turn | turn→run | signal |\n|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) => `| ${r.eventId} | ${r.officialReleaseAt ?? "—"} (${r.officialReleaseSource ?? "—"}) | ${r.crowsnestFetchedAt ?? "—"} (${r.crowsnestFetchedSource ?? "—"}) | ${r.verifyReceivedAt ?? "—"} (${r.verifyReceivedSource ?? "—"}${r.verifyLastPollWithoutData ? `; last poll without data ${r.verifyLastPollWithoutData}` : ""}) | ${fmt(r.deltasMs.releaseToCrowsnest)} | ${fmt(r.deltasMs.crowsnestToVerify)} | ${fmt(r.deltasMs.releaseToVerify)} | ${fmt(r.deltasMs.verifyToTurnOpened)} | ${fmt(r.deltasMs.turnOpenedToRunStarted)} | ${r.arrivalSignal ?? "—"} |`);
  return [head, ...body].join("\n");
}
