/** 收盘分类（CV-D06 · T-01/T-02）、乘数变化（T-04）、策略 v1.1.0 哈希（v1.0.0 钉住不变） */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildEffectivePolicy,
  buildReport,
  classifyLastTrade,
  confirmLastTick,
  evaluateVerification,
  findPolicy,
  isRegularCloseInstant,
  latestPolicy,
  POLICIES,
  POLICY_QUOTE_ONLY_V1,
  POLICY_REFERENCE_CONTEXT_V1,
  POLICY_REFERENCE_CONTEXT_V1_1,
  POLICY_STRICT_LIVE_V1,
  policyDefinitionHash,
  reportHash,
  resolveParams,
  validateCreateJob,
  type EvidenceRecord,
  type PolicyDefinition,
  type RefCloseEvidence,
} from "../src/verify";
import { closeEvidence, fixtureJob, fixtureRegistry, quoteEvidence, resetFixtureIds, rwaEvidence, stableEvidence, T_CLOSED, tokenMetaEvidence } from "../src/verify/fixtures";

const FIX = join(__dirname, "..", "src", "verify", "__fixtures__");
const V2 = join(FIX, "v2");
const UPDATE = process.env.UPDATE_FIXTURES === "1";
function golden(name: string, value: unknown) {
  if (!existsSync(V2)) mkdirSync(V2, { recursive: true });
  const file = join(V2, `${name}.json`);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (UPDATE || !existsSync(file)) return writeFileSync(file, text);
  expect(readFileSync(file, "utf8"), `黄金样本 v2 ${name} 变化`).toBe(text);
}

function run(def: PolicyDefinition, evidence: EvidenceRecord[], at: string) {
  const job = validateCreateJob(fixtureJob({ policyId: def.policyId, policyVersion: def.version, maxReferenceDeviationBps: def.policyId === "QUOTE_ONLY" ? null : 300 }));
  if (!job.ok) throw new Error(JSON.stringify(job.errors));
  const params = resolveParams(def, job.job.params);
  if (!params.ok) throw new Error("params");
  return evaluateVerification({ job: job.job, policy: buildEffectivePolicy(def, params.params), registry: fixtureRegistry(), evidence, evaluatedAt: at });
}
const t = (now: string, off: number) => new Date(Date.parse(now) - off * 1000).toISOString();
function closedSet(now: string, close: EvidenceRecord): EvidenceRecord[] {
  return [quoteEvidence({ receivedAt: t(now, 5) }), close, stableEvidence({ receivedAt: t(now, 20), usdPerToken: "1" }), tokenMetaEvidence({ receivedAt: t(now, 60), decimals: 18 })];
}

beforeEach(() => resetFixtureIds());

describe("v1.0.0 策略哈希钉住 / v1.1.0 新哈希", () => {
  it("v1.0.0 三个定义哈希与 __fixtures__/policy.hashes.json 完全一致（未受 acceptedCloseKinds 影响）", () => {
    const pinned = JSON.parse(readFileSync(join(FIX, "policy.hashes.json"), "utf8")) as Record<string, string>;
    expect(policyDefinitionHash(POLICY_STRICT_LIVE_V1)).toBe(pinned["STRICT_LIVE"]);
    expect(policyDefinitionHash(POLICY_REFERENCE_CONTEXT_V1)).toBe(pinned["REFERENCE_CONTEXT"]);
    expect(policyDefinitionHash(POLICY_QUOTE_ONLY_V1)).toBe(pinned["QUOTE_ONLY"]);
    expect("acceptedCloseKinds" in POLICY_REFERENCE_CONTEXT_V1).toBe(false);
  });
  it("v1.1.0 可查、为最新、哈希与 v1.0.0 不同并写入黄金样本 v2", () => {
    for (const id of ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"] as const) {
      expect(findPolicy(id, "1.1.0")).not.toBeNull();
      expect(latestPolicy(id).version).toBe("1.1.0");
      expect(POLICIES[id].length).toBe(2);
      expect(policyDefinitionHash(findPolicy(id, "1.1.0")!)).not.toBe(policyDefinitionHash(findPolicy(id, "1.0.0")!));
    }
    expect(POLICY_REFERENCE_CONTEXT_V1_1.acceptedCloseKinds).toEqual(["official_close", "close_cross_verified", "close_last_tick"]);
    golden("policy.hashes.v1_1_0", {
      STRICT_LIVE: policyDefinitionHash(findPolicy("STRICT_LIVE", "1.1.0")!),
      REFERENCE_CONTEXT: policyDefinitionHash(findPolicy("REFERENCE_CONTEXT", "1.1.0")!),
      QUOTE_ONLY: policyDefinitionHash(findPolicy("QUOTE_ONLY", "1.1.0")!),
    });
  });
});

describe("T-01 收盘分类（classifyLastTrade）", () => {
  // 2026-09-18（周五）16:00:00 ET = 20:00:00Z
  const T1600 = Math.floor(Date.parse("2026-09-18T20:00:00.000Z") / 1000);
  it("16:00:00 ET 整 → last_tick；15:59:30 → gap（pyth 形态）；盘中 → null；秒不为 0 不算整点", () => {
    expect(isRegularCloseInstant(T1600)).toBe(true);
    expect(isRegularCloseInstant(T1600 + 1)).toBe(false);
    expect(classifyLastTrade({ tUnixSec: T1600, nowIso: T_CLOSED })).toEqual({ closeSource: "last_tick", tradingDate: "2026-09-18", sourcePublishedAt: "2026-09-18T20:00:00.000Z", note: "last_tick_at_1600" });
    expect(classifyLastTrade({ tUnixSec: T1600 - 30, nowIso: T_CLOSED })).toMatchObject({ closeSource: "pyth", note: "gap_before_close" });
    expect(classifyLastTrade({ tUnixSec: T1600 - 3600, nowIso: "2026-09-18T19:30:00.000Z" })).toBeNull();
    // 盘后 tick（16:05）不是收盘
    expect(classifyLastTrade({ tUnixSec: T1600 + 300, nowIso: T_CLOSED })).toBeNull();
  });
  it("真实 9/18 样本：c=336.13, t=16:00:00 ET → last_tick；v1.0.0 REFERENCE_CONTEXT 拒绝（provisional）、v1.1.0 接受并标 CLOSE_UNCONFIRMED", () => {
    const close = closeEvidence({ receivedAt: t(T_CLOSED, 3), closeUsd: "336.13", closeSource: "last_tick", sourcePublishedAt: "2026-09-18T20:00:00.000Z" });
    // 报价按 $336.13 定：100 FUSD → 0.2975 股
    const ev = closedSet(T_CLOSED, close).map((e) => (e.payload.kind === "okx_quote" ? quoteEvidence({ receivedAt: t(T_CLOSED, 5), expectedOutRaw: "297503000000000000" }) : e));
    const v10 = run(POLICY_REFERENCE_CONTEXT_V1, ev, T_CLOSED);
    expect(v10.verdict).toBe("limited");
    expect(v10.reasons.map((r) => r.code)).toContain("REFERENCE_PROVISIONAL");
    expect(v10.reference?.kind).toBe("close_last_tick");
    const v11 = run(POLICY_REFERENCE_CONTEXT_V1_1, ev, T_CLOSED);
    expect(v11.verdict).toBe("eligible");
    expect(v11.reasons.map((r) => r.code)).toEqual(["CLOSE_UNCONFIRMED"]);
    expect(v11.reference?.kind).toBe("close_last_tick");
    expect(v11.comparisonStatus).toBe("official_close");
    expect(v11.reference?.deviationBps).not.toBeNull();
    // 黄金样本 v2
    const job = validateCreateJob(fixtureJob({ policyId: "REFERENCE_CONTEXT", policyVersion: "1.1.0" }));
    if (!job.ok) throw new Error("job");
    const report = buildReport({ jobId: "job_fixture_v2", reportVersion: 1, job: job.job, policy: job.policy, registry: fixtureRegistry(), evidence: ev, evaluatedAt: T_CLOSED });
    golden("report.reference_context.close_last_tick", { report, reportHash: reportHash(report) });
  });
  it("T-02：次日 pc 与 last_tick 一致 → 升级 official（带确认）；不一致 → 不升级", () => {
    const rec = closeEvidence({ receivedAt: t(T_CLOSED, 3), closeUsd: "336.13", closeSource: "last_tick" }).payload as RefCloseEvidence;
    const up = confirmLastTick(rec, { method: "next_day_pc", closeUsd: "336.13", confirmedAt: "2026-09-21T13:31:00.000Z" });
    expect(up).toMatchObject({ closeSource: "official", confirmation: { method: "next_day_pc", matchedUsd: "336.13" } });
    expect(confirmLastTick(rec, { method: "next_day_pc", closeUsd: "337", confirmedAt: "x" })).toBeNull();
    expect(confirmLastTick({ ...rec, closeSource: "official" }, { method: "candle", closeUsd: "336.13", confirmedAt: "x" })).toBeNull();
    // 升级后的证据在 v1.0.0 与 v1.1.0 下都是 official_close，且无 CLOSE_UNCONFIRMED
    const ev = closedSet(T_CLOSED, { ...closeEvidence({ receivedAt: t(T_CLOSED, 3) }), payload: up! });
    for (const def of [POLICY_REFERENCE_CONTEXT_V1, POLICY_REFERENCE_CONTEXT_V1_1]) {
      const r = run(def, ev, T_CLOSED);
      expect(r.reference?.kind).toBe("official_close");
      expect(r.reasons.map((x) => x.code)).not.toContain("CLOSE_UNCONFIRMED");
    }
  });
  it("STRICT_LIVE v1.1.0 acceptedCloseKinds=[] 不影响 live 路径；QUOTE_ONLY v1.1.0 不比较", () => {
    const ev = closedSet(T_CLOSED, closeEvidence({ receivedAt: t(T_CLOSED, 3), closeSource: "official" }));
    expect(run(findPolicy("STRICT_LIVE", "1.1.0")!, ev, T_CLOSED).reasons.map((r) => r.code)).toContain("MARKET_OUTSIDE_REGULAR");
    expect(run(findPolicy("QUOTE_ONLY", "1.1.0")!, ev, T_CLOSED).comparisonStatus).toBe("not_requested");
  });
});

describe("T-04 UNIT_CHANGED", () => {
  it("同源两次乘数观测不同 → warning UNIT_CHANGED（不阻断）；相同 → 无；跨源不同不算", () => {
    const base = closedSet(T_CLOSED, closeEvidence({ receivedAt: t(T_CLOSED, 3), closeSource: "official" }));
    const changed = [...base, rwaEvidence({ receivedAt: t(T_CLOSED, 600), stockPriceUsd: null, ratio: "1.003269" }), rwaEvidence({ receivedAt: t(T_CLOSED, 6), stockPriceUsd: null, ratio: "1.003400" })];
    const r = run(POLICY_REFERENCE_CONTEXT_V1_1, changed, T_CLOSED);
    const u = r.reasons.find((x) => x.code === "UNIT_CHANGED");
    expect(u).toMatchObject({ severity: "warning", detail: { from: "1.003269", to: "1.003400", source: "okx_rwa_token.ratio" } });
    expect(r.verdict).toBe("eligible");
    const same = [...base, rwaEvidence({ receivedAt: t(T_CLOSED, 600), stockPriceUsd: null, ratio: "1.003269" }), rwaEvidence({ receivedAt: t(T_CLOSED, 6), stockPriceUsd: null, ratio: "1.003269" })];
    expect(run(POLICY_REFERENCE_CONTEXT_V1_1, same, T_CLOSED).reasons.map((x) => x.code)).not.toContain("UNIT_CHANGED");
    const cross = [...base, rwaEvidence({ receivedAt: t(T_CLOSED, 6), stockPriceUsd: null, ratio: "1.003269" }), tokenMetaEvidence({ receivedAt: t(T_CLOSED, 7), decimals: 18, multiplier: "1.0034" })];
    expect(run(POLICY_REFERENCE_CONTEXT_V1_1, cross, T_CLOSED).reasons.map((x) => x.code)).not.toContain("UNIT_CHANGED");
  });
});
