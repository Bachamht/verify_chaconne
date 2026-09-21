/** 卖出方向（v2 additive）：角色对调、单价反算、requestHash 只在 sell 时纳入 side */
import { describe, expect, it, beforeEach } from "vitest";
import { buildEffectivePolicy, evaluateVerification, POLICY_STRICT_LIVE_V1, requestHash, resolveParams, toCreateVerifyJob, validateCreateJob } from "../src/verify";
import { FIXTURE_STABLE, FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY, fixtureJob, fixtureRegistry, liveHappyEvidence, quoteEvidence, resetFixtureIds, T_REGULAR } from "../src/verify/fixtures";

beforeEach(() => resetFixtureIds());

describe("sell side", () => {
  const sellJob = () => fixtureJob({ side: "sell", inputAssetKey: FIXTURE_STOCK_KEY, outputAssetKey: FIXTURE_STABLE_KEY, amountInRaw: "400000000000000000" });
  it("validate：side 只接受 buy/sell；缺省不写入；toCreateVerifyJob 往返", () => {
    expect(validateCreateJob({ ...fixtureJob(), side: "hold" }).ok).toBe(false);
    const buy = validateCreateJob(fixtureJob());
    expect(buy.ok && "side" in buy.job).toBe(false);
    const sell = validateCreateJob(sellJob());
    expect(sell.ok && sell.job.side).toBe("sell");
    if (sell.ok) expect(toCreateVerifyJob(sell.job).side).toBe("sell");
  });
  it("requestHash：buy 与 v1 一致（不含 side）；sell 不同", () => {
    const buy = validateCreateJob(fixtureJob());
    const buyExplicit = validateCreateJob({ ...fixtureJob(), side: "buy" });
    const sell = validateCreateJob(sellJob());
    if (!buy.ok || !buyExplicit.ok || !sell.ok) throw new Error("job");
    expect(requestHash(buy.job)).toBe(requestHash(buyExplicit.job));
    expect(requestHash(sell.job)).not.toBe(requestHash(buy.job));
  });
  it("evaluate：股票→稳定币 eligible，单价 = 100 USD / 0.4 股 = 250，偏差 0；买入方向的报价不匹配 → QUOTE_UNAVAILABLE", () => {
    const v = validateCreateJob(sellJob());
    if (!v.ok) throw new Error("job");
    const params = resolveParams(POLICY_STRICT_LIVE_V1, v.job.params);
    if (!params.ok) throw new Error("params");
    const policy = buildEffectivePolicy(POLICY_STRICT_LIVE_V1, params.params);
    const shared = liveHappyEvidence().filter((e) => e.payload.kind !== "okx_quote");
    const t = new Date(Date.parse(T_REGULAR) - 5000).toISOString();
    const sellQuote = quoteEvidence({ receivedAt: t, amountInRaw: "400000000000000000", expectedOutRaw: "100000000", fromToken: FIXTURE_STOCK, toToken: FIXTURE_STABLE });
    const r = evaluateVerification({ job: v.job, policy, registry: fixtureRegistry(), evidence: [...shared, sellQuote], evaluatedAt: T_REGULAR });
    expect(r.reasons).toEqual([]);
    expect(r.verdict).toBe("eligible");
    expect(r.normalizedQuote?.executableUsdPerShare).toBe("250");
    expect(r.reference?.deviationBps).toBe(0);
    expect(r.normalizedQuote?.minOutRaw).toBe("99500000");
    const wrong = evaluateVerification({ job: v.job, policy, registry: fixtureRegistry(), evidence: liveHappyEvidence(), evaluatedAt: T_REGULAR });
    expect(wrong.reasons.map((x) => x.code)).toContain("QUOTE_UNAVAILABLE");
    // 买入任务却传 sell 的角色 → REGISTRY_MISMATCH
    const buy = validateCreateJob(fixtureJob({ inputAssetKey: FIXTURE_STOCK_KEY, outputAssetKey: FIXTURE_STABLE_KEY }));
    if (!buy.ok) throw new Error("job");
    const rb = evaluateVerification({ job: buy.job, policy, registry: fixtureRegistry(), evidence: [...shared, sellQuote], evaluatedAt: T_REGULAR });
    expect(rb.reasons.map((x) => x.code)).toContain("REGISTRY_MISMATCH");
  });
});
