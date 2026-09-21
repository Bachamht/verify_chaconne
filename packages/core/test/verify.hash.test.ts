/**
 * 规范化与哈希（§5.3）：确定性、顺序无关、黄金样本锁定（D-12 可复现）。
 * 黄金哈希一旦变化 = 规范化规则/证据模型变了，必须升版本并记 CV-D。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { keccak256, toBytes } from "viem";
import {
  buildReport,
  canonicalJson,
  evidenceHash,
  hashCanonical,
  POLICY_QUOTE_ONLY_V1,
  POLICY_REFERENCE_CONTEXT_V1,
  registryHash,
  reportHash,
  requestHash,
  validateCreateJob,
  validateRegistry,
} from "../src/verify";
import {
  closeCrossVerifiedEvidence,
  fixtureJob,
  fixtureRegistry,
  liveHappyEvidence,
  resetFixtureIds,
  T_CLOSED,
  T_REGULAR,
} from "../src/verify/fixtures";

const FIXTURE_DIR = join(__dirname, "..", "src", "verify", "__fixtures__");
const UPDATE = process.env.UPDATE_FIXTURES === "1";

function golden(name: string, value: unknown): void {
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = join(FIXTURE_DIR, `${name}.json`);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (UPDATE || !existsSync(file)) {
    writeFileSync(file, text);
    return;
  }
  expect(readFileSync(file, "utf8"), `黄金样本 ${name} 变化：若为有意变更请 UPDATE_FIXTURES=1 并记 CV-D`).toBe(text);
}

describe("canonicalJson", () => {
  it("键排序、丢 undefined、保留 null、数组保序、非整数 number 拒绝", () => {
    expect(canonicalJson({ b: 1, a: [3, { z: null, y: "x" }], c: undefined })).toBe('{"a":[3,{"y":"x","z":null}],"b":1}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/非安全整数/);
    expect(() => canonicalJson({ a: 10n })).toThrow(/bigint/);
    expect(canonicalJson("中文\"引号\"")).toBe(JSON.stringify("中文\"引号\""));
  });

  it("hashCanonical = keccak256(utf8(canonical))，与 viem 互检", () => {
    const obj = { x: "1", y: null };
    expect(hashCanonical(obj)).toBe(keccak256(toBytes(canonicalJson(obj))));
  });
});

describe("evidenceHash / requestHash / registryHash", () => {
  beforeEach(() => resetFixtureIds());

  it("证据顺序无关，内容敏感", () => {
    const ev = liveHappyEvidence();
    const h1 = evidenceHash(ev);
    const h2 = evidenceHash([...ev].reverse());
    expect(h1).toBe(h2);
    const mutated = structuredClone(ev);
    if (mutated[0]!.payload.kind === "okx_quote") mutated[0]!.payload.expectedOutRaw = "1";
    expect(evidenceHash(mutated)).not.toBe(h1);
    // rawHash 变化也改变 evidenceHash
    const m2 = structuredClone(ev);
    m2[1]!.rawHash = `0x${"ff".repeat(32)}`;
    expect(evidenceHash(m2)).not.toBe(h1);
  });

  it("registryHash 与条目顺序无关，与 provenance/展示字段无关", () => {
    const a = fixtureRegistry();
    const b = fixtureRegistry();
    b.entries.reverse();
    b.entries[0]!.displaySymbol = "OTHER";
    b.entries[0]!.provenance = [];
    expect(registryHash(a)).toBe(registryHash(b));
    const c = fixtureRegistry();
    c.entries[1]!.tokenDecimals = 6;
    expect(registryHash(c)).not.toBe(registryHash(a));
    expect(validateRegistry(a)).toEqual([]);
  });

  it("requestHash 对展开后的参数敏感、对 clientRequestId 敏感", () => {
    const v1 = validateCreateJob(fixtureJob());
    const v2 = validateCreateJob(fixtureJob({ maxPriceImpactBps: null })); // 默认 100 = 同值
    const v3 = validateCreateJob(fixtureJob({ clientRequestId: "other" }));
    if (!v1.ok || !v2.ok || !v3.ok) throw new Error("validate");
    expect(requestHash(v1.job)).toBe(requestHash(v2.job));
    expect(requestHash(v3.job)).not.toBe(requestHash(v1.job));
  });
});

describe("报告：可复现 + 黄金样本（D-12）", () => {
  beforeEach(() => resetFixtureIds());

  it("同输入两次构建报告完全一致", () => {
    const v = validateCreateJob(fixtureJob());
    if (!v.ok) throw new Error("validate");
    const ev = liveHappyEvidence();
    const args = { jobId: "job_fixture_1", reportVersion: 1, job: v.job, policy: v.policy, registry: fixtureRegistry(), evidence: ev, evaluatedAt: T_REGULAR };
    const r1 = buildReport(args);
    const r2 = buildReport({ ...args, evidence: [...ev].reverse() });
    expect(reportHash(r1)).toBe(reportHash(r2));
    expect(r1.evidenceHash).toBe(evidenceHash(ev));
    expect(r1.evidenceIds).toEqual([...ev.map((e) => e.evidenceId)].sort());
  });

  it("黄金样本：STRICT_LIVE 合格报告", () => {
    const v = validateCreateJob(fixtureJob());
    if (!v.ok) throw new Error("validate");
    const ev = liveHappyEvidence();
    const report = buildReport({ jobId: "job_fixture_live", reportVersion: 1, job: v.job, policy: v.policy, registry: fixtureRegistry(), evidence: ev, evaluatedAt: T_REGULAR });
    expect(report.verdict).toBe("eligible");
    golden("report.strict_live.eligible", { evidence: ev, report, reportHash: reportHash(report) });
    golden("policy.hashes", {
      STRICT_LIVE: v.policy.policyDefinitionHash,
      REFERENCE_CONTEXT: hashCanonical(POLICY_REFERENCE_CONTEXT_V1),
      QUOTE_ONLY: hashCanonical(POLICY_QUOTE_ONLY_V1),
      registry: registryHash(fixtureRegistry()),
    });
  });

  it("黄金样本：REFERENCE_CONTEXT 交叉核验收盘报告", () => {
    const v = validateCreateJob(fixtureJob({ policyId: "REFERENCE_CONTEXT" }));
    if (!v.ok) throw new Error("validate");
    const ev = closeCrossVerifiedEvidence();
    const report = buildReport({ jobId: "job_fixture_close", reportVersion: 1, job: v.job, policy: v.policy, registry: fixtureRegistry(), evidence: ev, evaluatedAt: T_CLOSED });
    expect(report.verdict).toBe("eligible");
    expect(report.reference?.kind).toBe("close_cross_verified");
    golden("report.reference_context.cross_verified", { evidence: ev, report, reportHash: reportHash(report) });
  });

  it("黄金样本：休市 STRICT_LIVE 拒绝报告（决赛现场预期结果）", () => {
    const v = validateCreateJob(fixtureJob());
    if (!v.ok) throw new Error("validate");
    const ev = closeCrossVerifiedEvidence();
    const report = buildReport({ jobId: "job_fixture_live_closed", reportVersion: 1, job: v.job, policy: v.policy, registry: fixtureRegistry(), evidence: ev, evaluatedAt: T_CLOSED });
    expect(report.verdict).toBe("rejected");
    golden("report.strict_live.closed_rejected", { evidence: ev, report, reportHash: reportHash(report) });
  });
});
