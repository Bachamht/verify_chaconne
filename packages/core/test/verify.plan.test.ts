/** 规划引擎（v5 W1 · PL-01～PL-08）。期望值来自 interfaces §10.1 规则，不由被测函数生成。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  bisectMaxAmount,
  buildLadder,
  buildPlanReport,
  candidateJob,
  candidateToCreateJob,
  chooseRecommended,
  goalHash,
  planHash,
  requestHash,
  validateCreateJob,
  type AssetRegistry,
  type EvidenceRecord,
  type PlanGoal,
  type PlanEvidenceSet,
} from "../src/verify";
import { FIXTURE_CHAIN_ID, FIXTURE_OWNER, FIXTURE_RECIPIENT, FIXTURE_STABLE, FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY, fixtureRegistry, liveHappyEvidence, quoteEvidence, resetFixtureIds, T_CLOSED, T_REGULAR } from "../src/verify/fixtures";

const V2 = join(__dirname, "..", "src", "verify", "__fixtures__", "v2");
function golden(name: string, value: unknown) {
  if (!existsSync(V2)) mkdirSync(V2, { recursive: true });
  const file = join(V2, `${name}.json`);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.UPDATE_FIXTURES === "1" || !existsSync(file)) return writeFileSync(file, text);
  expect(readFileSync(file, "utf8"), `黄金样本 v2 ${name} 变化`).toBe(text);
}

const STABLE2 = "0x4444444444444444444444444444444444444444" as const;
const STABLE2_KEY = `eip155:${FIXTURE_CHAIN_ID}:${STABLE2}`;

function registryWithStable2(): AssetRegistry {
  const reg = fixtureRegistry();
  const base = reg.entries[0]!;
  return { ...reg, entries: [...reg.entries, { ...base, assetKey: STABLE2_KEY, tokenAddress: STABLE2, displaySymbol: "FUSD2", issuerId: "fixture-stable2" }] };
}

function goal(over: Partial<PlanGoal> = {}): PlanGoal {
  return {
    ownerAddress: FIXTURE_OWNER,
    recipientAddress: FIXTURE_RECIPIENT,
    executionChainId: FIXTURE_CHAIN_ID,
    legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }],
    budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "100000000" },
    side: "buy",
    policyId: "STRICT_LIVE",
    policyVersion: "1.0.0",
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: 300,
    deadline: "2026-09-25T00:00:00.000Z",
    ...over,
  };
}

/** 每个候选一条报价：$250/股 → out = amount × 4e9；冲击可按 ladderBps 定制 */
function quotesFor(specs: ReturnType<typeof buildLadder>, now: string, impactOf: (ladderBps: number, inputKey: string) => number | null | "missing" = () => 12): PlanEvidenceSet["quotes"] {
  const t = new Date(Date.parse(now) - 5000).toISOString();
  const out: PlanEvidenceSet["quotes"] = {};
  for (const s of specs) {
    const imp = impactOf(s.ladderBps, s.inputAssetKey);
    if (imp === "missing") {
      out[s.candidateId] = null;
      continue;
    }
    out[s.candidateId] = quoteEvidence({
      receivedAt: t,
      amountInRaw: s.amountInRaw,
      expectedOutRaw: (BigInt(s.amountInRaw) * 4_000_000_000n).toString(),
      adverseImpactBps: imp,
      priceImpactPercentRaw: imp === null ? null : `-${(imp / 100).toFixed(2)}`,
      fromToken: s.inputAssetKey === FIXTURE_STABLE_KEY ? FIXTURE_STABLE : STABLE2,
      id: `ev_q_${s.candidateId}`,
    });
  }
  return out;
}

function shared(now = T_REGULAR): EvidenceRecord[] {
  return liveHappyEvidence(now).filter((e) => e.payload.kind !== "okx_quote");
}

beforeEach(() => resetFixtureIds());

describe("buildLadder", () => {
  it("默认阶梯 5 档、金额向下取整、候选 id 确定", () => {
    const specs = buildLadder(goal(), fixtureRegistry());
    expect(specs.map((s) => s.ladderBps)).toEqual([10_000, 7_500, 5_000, 2_500, 1_000]);
    expect(specs.map((s) => s.amountInRaw)).toEqual(["100000000", "75000000", "50000000", "25000000", "10000000"]);
    expect(specs[0]!.candidateId).toMatch(/^cand_0_10000_[0-9a-f]{8}$/);
    expect(buildLadder(goal(), fixtureRegistry())).toEqual(specs);
  });
  it("PL-07：每腿报价数 ≤ 8：三个资金币种时阶梯截到 2 档；总候选 ≤ 12", () => {
    const reg = registryWithStable2();
    const g = goal({ budget: { inputAssetKeys: [FIXTURE_STABLE_KEY, STABLE2_KEY, FIXTURE_STABLE_KEY + "x"], amountInRaw: "100000000" } });
    const specs = buildLadder(g, reg);
    expect(specs.length).toBeLessThanOrEqual(8);
    expect(new Set(specs.map((s) => s.ladderBps))).toEqual(new Set([10_000, 7_500]));
    const two = buildLadder(goal({ legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 5000 }, { outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 5000 }], budget: { inputAssetKeys: [FIXTURE_STABLE_KEY, STABLE2_KEY], amountInRaw: "100000000" } }), reg);
    expect(two.length).toBeLessThanOrEqual(12);
  });
  it("权重之和≠10000、空阶梯拒绝；零金额候选丢弃", () => {
    expect(() => buildLadder(goal({ legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 9000 }] }), fixtureRegistry())).toThrow(/10000/);
    expect(() => buildLadder(goal({ ladderBps: [] }), fixtureRegistry())).toThrow(/ladderBps/);
    expect(buildLadder(goal({ budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "3" }, ladderBps: [10_000, 1_000] }), fixtureRegistry()).length).toBe(1);
  });
});

describe("buildPlanReport", () => {
  it("PL-01：确定性、planHash 可复现、goalHash 稳定", () => {
    const reg = fixtureRegistry();
    const g = goal();
    const specs = buildLadder(g, reg);
    const ev: PlanEvidenceSet = { shared: shared(), quotes: quotesFor(specs, T_REGULAR) };
    const a = buildPlanReport({ planId: "plan_1", goal: g, registry: reg, specs, evidence: ev, evaluatedAt: T_REGULAR });
    const b = buildPlanReport({ planId: "plan_1", goal: g, registry: reg, specs, evidence: ev, evaluatedAt: T_REGULAR });
    expect(a).toEqual(b);
    expect(planHash(a)).toBe(a.planHash);
    expect(a.goalHash).toBe(goalHash(g));
    expect(a.candidates.length).toBe(5);
    expect(a.candidates.every((c) => c.chosenPolicyVerdict === "eligible")).toBe(true);
    expect(a.recommended).toBe(specs[0]!.candidateId);
    expect(a.candidates[0]!.nextStep).toBe("READY");
    expect(a.candidates[1]!.nextStep).toBe("ACCEPT_PARTIAL");
    // 三策略对照：休市判定由 STRICT_LIVE 决定，QUOTE_ONLY 仍 eligible
    expect(a.candidates[0]!.verdictByPolicy.QUOTE_ONLY.verdict).toBe("eligible");
    golden("plan.strict_live.buy_ladder", a);
    // 改任一证据 → planHash 变
    const ev2: PlanEvidenceSet = { ...ev, quotes: quotesFor(specs, T_REGULAR, () => 13) };
    expect(buildPlanReport({ planId: "plan_1", goal: g, registry: reg, specs, evidence: ev2, evaluatedAt: T_REGULAR }).planHash).not.toBe(a.planHash);
  });

  it("PL-02：recommended 只取 eligible 且完成比例最大；并列按 id", () => {
    expect(chooseRecommended([])).toBeNull();
    const mk = (id: string, v: "eligible" | "rejected", bps: number) => ({ candidateId: id, legIndex: 0, inputAssetKey: "k", amountInRaw: "1", expectedOutRaw: null, adverseImpactBps: null, feeEstimate: { gasNative: null, routeFeeBps: null }, completionBps: bps, verdictByPolicy: {} as never, chosenPolicyVerdict: v, reasons: [], evidenceIds: [], nextStep: "READY" as const });
    expect(chooseRecommended([mk("b", "eligible", 5000), mk("a", "eligible", 5000), mk("c", "rejected", 10_000)])).toBe("a");
    expect(chooseRecommended([mk("x", "rejected", 10_000)])).toBeNull();
  });

  it("PL-03：100% 冲击超限 → USER_MUST_RELAX_LIMIT；50% 可行 → recommended 是 50%（ACCEPT_PARTIAL）", () => {
    const reg = fixtureRegistry();
    const g = goal();
    const specs = buildLadder(g, reg);
    const ev: PlanEvidenceSet = { shared: shared(), quotes: quotesFor(specs, T_REGULAR, (bps) => (bps >= 7500 ? 150 : 40)) };
    const r = buildPlanReport({ planId: "plan_3", goal: g, registry: reg, specs, evidence: ev, evaluatedAt: T_REGULAR });
    const c100 = r.candidates.find((c) => c.completionBps === 10_000)!;
    const c50 = r.candidates.find((c) => c.completionBps === 5_000)!;
    expect(c100.chosenPolicyVerdict).toBe("rejected");
    expect(c100.reasons.map((x) => x.code)).toContain("PRICE_IMPACT_EXCEEDED");
    expect(c100.nextStep).toBe("USER_MUST_RELAX_LIMIT");
    expect(c50.chosenPolicyVerdict).toBe("eligible");
    expect(c50.nextStep).toBe("ACCEPT_PARTIAL");
    expect(r.recommended).toBe(c50.candidateId);
    expect(r.candidates.filter((c) => c.completionBps === 7500)[0]!.nextStep).toBe("USER_MUST_RELAX_LIMIT");
  });

  it("PL-04：本币种拿不到报价、另一币种可行 → SWITCH_INPUT", () => {
    const reg = registryWithStable2();
    const g = goal({ budget: { inputAssetKeys: [FIXTURE_STABLE_KEY, STABLE2_KEY], amountInRaw: "100000000" }, ladderBps: [10_000, 5_000] });
    const specs = buildLadder(g, reg);
    // STABLE2 需要自己的 stablecoin_usd 证据；这里故意让 STABLE2 报价缺失
    const ev: PlanEvidenceSet = { shared: shared(), quotes: quotesFor(specs, T_REGULAR, (_b, k) => (k === STABLE2_KEY ? "missing" : 12)) };
    const r = buildPlanReport({ planId: "plan_4", goal: g, registry: reg, specs, evidence: ev, evaluatedAt: T_REGULAR });
    const s2 = r.candidates.filter((c) => c.inputAssetKey === STABLE2_KEY);
    expect(s2.length).toBe(2);
    expect(s2.every((c) => c.nextStep === "SWITCH_INPUT")).toBe(true);
    expect(s2.every((c) => c.reasons.some((x) => x.code === "QUOTE_UNAVAILABLE"))).toBe(true);
    expect(r.recommended).toBe(specs.find((s) => s.inputAssetKey === FIXTURE_STABLE_KEY && s.ladderBps === 10_000)!.candidateId);
  });

  it("PL-05：两腿各自候选与总完成比例（QUOTE_ONLY）", () => {
    const reg = fixtureRegistry();
    const g = goal({ policyId: "QUOTE_ONLY", maxReferenceDeviationBps: null, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 6000 }, { outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 4000 }], ladderBps: [10_000, 5_000] });
    const specs = buildLadder(g, reg);
    expect(specs.map((s) => [s.legIndex, s.amountInRaw])).toEqual([[0, "60000000"], [0, "30000000"], [1, "40000000"], [1, "20000000"]]);
    const ev: PlanEvidenceSet = { shared: shared(), quotes: quotesFor(specs, T_REGULAR, (bps) => (bps === 10_000 ? 120 : 10)) };
    const r = buildPlanReport({ planId: "plan_5", goal: g, registry: reg, specs, evidence: ev, evaluatedAt: T_REGULAR });
    const leg0 = r.candidates.filter((c) => c.legIndex === 0);
    const leg1 = r.candidates.filter((c) => c.legIndex === 1);
    expect(leg0.map((c) => c.nextStep)).toEqual(["USER_MUST_RELAX_LIMIT", "ACCEPT_PARTIAL"]);
    expect(leg1.map((c) => c.nextStep)).toEqual(["USER_MUST_RELAX_LIMIT", "ACCEPT_PARTIAL"]);
    // 总完成比例 = Σ 各腿推荐完成比例 × 权重
    const best = (leg: typeof leg0) => leg.filter((c) => c.chosenPolicyVerdict === "eligible").sort((a, b) => b.completionBps - a.completionBps)[0]!.completionBps;
    const total = Math.floor((best(leg0) * 6000 + best(leg1) * 4000) / 10_000);
    expect(total).toBe(5000);
  });

  it("PL-06：卖出方向（股票→稳定币）：角色对调、单价反算、完成比例按股票预算", () => {
    const reg = fixtureRegistry();
    const g = goal({ side: "sell", legs: [{ outputAssetKey: FIXTURE_STABLE_KEY, weightBps: 10_000 }], budget: { inputAssetKeys: [FIXTURE_STOCK_KEY], amountInRaw: "400000000000000000" }, ladderBps: [10_000, 5_000] });
    const specs = buildLadder(g, reg);
    expect(specs.map((s) => s.amountInRaw)).toEqual(["400000000000000000", "200000000000000000"]);
    const t = new Date(Date.parse(T_REGULAR) - 5000).toISOString();
    const quotes: PlanEvidenceSet["quotes"] = {};
    for (const s of specs) {
      // 0.4 股 → 100 FUSD（$250/股）
      quotes[s.candidateId] = quoteEvidence({ receivedAt: t, amountInRaw: s.amountInRaw, expectedOutRaw: (BigInt(s.amountInRaw) / 4_000_000_000n).toString(), adverseImpactBps: 10, fromToken: FIXTURE_STOCK, toToken: FIXTURE_STABLE, id: `ev_q_${s.candidateId}` });
    }
    const r = buildPlanReport({ planId: "plan_6", goal: g, registry: reg, specs, evidence: { shared: shared(), quotes }, evaluatedAt: T_REGULAR });
    expect(r.candidates.map((c) => c.chosenPolicyVerdict)).toEqual(["eligible", "eligible"]);
    expect(r.candidates[0]!.nextStep).toBe("READY");
    // 单价反算 = 100 USD / 0.4 股 = 250 → 与参考价 250 偏差 0
    const job = candidateJob(g, specs[0]!, "STRICT_LIVE")!;
    expect(job.side).toBe("sell");
    expect(job.inputAssetKey).toBe(FIXTURE_STOCK_KEY);
  });

  it("休市时 STRICT_LIVE 全部 WAIT_CONDITION，recommended 为 null", () => {
    const reg = fixtureRegistry();
    const g = goal();
    const specs = buildLadder(g, reg);
    const r = buildPlanReport({ planId: "plan_w", goal: g, registry: reg, specs, evidence: { shared: shared(T_CLOSED), quotes: quotesFor(specs, T_CLOSED) }, evaluatedAt: T_CLOSED });
    expect(r.recommended).toBeNull();
    expect(r.candidates.every((c) => c.nextStep === "WAIT_CONDITION")).toBe(true);
    expect(r.candidates.every((c) => c.verdictByPolicy.STRICT_LIVE.blocking.includes("MARKET_OUTSIDE_REGULAR"))).toBe(true);
  });

  it("PL-08：候选 → CreateVerifyJob 可校验，且 requestHash 与引擎内部任务一致", () => {
    const reg = fixtureRegistry();
    const g = goal();
    const specs = buildLadder(g, reg);
    const create = candidateToCreateJob(g, specs[2]!);
    const v = validateCreateJob(create);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(requestHash(v.job)).toBe(requestHash(candidateJob(g, specs[2]!, "STRICT_LIVE")!));
    expect(v.job.amountInRaw).toBe("50000000");
    expect(requestHash(v.job)).toBe(requestHash(validateCreateJob(candidateToCreateJob(g, specs[2]!)).ok ? (validateCreateJob(candidateToCreateJob(g, specs[2]!)) as { ok: true; job: typeof v.job }).job : v.job));
  });
});

describe("bisectMaxAmount", () => {
  it("整笔可行只探 1 次；否则二分且探测次数 ≤ 上限", async () => {
    const calls: string[] = [];
    const probe = async (a: string) => {
      calls.push(a);
      return BigInt(a) <= 60_000_000n ? 50 : 150;
    };
    expect(await bisectMaxAmount({ lo: "10000000", hi: "60000000", capBps: 100, probe })).toEqual({ amountRaw: "60000000", adverseImpactBps: 50, probes: 1 });
    calls.length = 0;
    const r = await bisectMaxAmount({ lo: "10000000", hi: "100000000", capBps: 100, probe, maxProbes: 8 });
    expect(r).not.toBeNull();
    expect(BigInt(r!.amountRaw) <= 60_000_000n).toBe(true);
    expect(r!.probes).toBeLessThanOrEqual(8);
    expect(calls.length).toBe(r!.probes);
    expect(await bisectMaxAmount({ lo: "70000000", hi: "100000000", capBps: 100, probe })).toBeNull();
  });
});

describe("chooseRecommended 并列打破（I2 集成发现：多资金币种时应推荐到手更多的那个）", () => {
  const base = {
    legIndex: 0,
    inputAssetKey: "eip155:196:0xaaa",
    amountInRaw: "10000000",
    adverseImpactBps: 5,
    feeEstimate: { gasNative: null, routeFeeBps: null },
    completionBps: 10_000,
    verdictByPolicy: {} as never,
    chosenPolicyVerdict: "eligible" as const,
    reasons: [],
    evidenceIds: [],
    nextStep: "READY" as const,
  };
  it("同完成度同腿：expectedOutRaw 大者胜，与 candidateId 字典序无关", () => {
    const worseIdSmaller = { ...base, candidateId: "cand_0_10000_49da7458", expectedOutRaw: "29877910264282854" };
    const betterIdLarger = { ...base, candidateId: "cand_0_10000_939c8df8", expectedOutRaw: "29879082105654912" };
    expect(chooseRecommended([worseIdSmaller, betterIdLarger])).toBe("cand_0_10000_939c8df8");
    expect(chooseRecommended([betterIdLarger, worseIdSmaller])).toBe("cand_0_10000_939c8df8");
  });
  it("完成度优先于产出；跨腿按 legIndex；产出未知排在已知之后；全非 eligible → null", () => {
    const full = { ...base, candidateId: "c_full", expectedOutRaw: "1" };
    const half = { ...base, candidateId: "c_half", completionBps: 5_000, expectedOutRaw: "999999" };
    expect(chooseRecommended([half, full])).toBe("c_full");
    const leg1 = { ...base, candidateId: "c_leg1", legIndex: 1, expectedOutRaw: "999999999" };
    expect(chooseRecommended([leg1, full])).toBe("c_full");
    const unknown = { ...base, candidateId: "c_unknown", expectedOutRaw: null };
    expect(chooseRecommended([unknown, full])).toBe("c_full");
    expect(chooseRecommended([{ ...full, chosenPolicyVerdict: "rejected" as const }])).toBeNull();
  });
});
