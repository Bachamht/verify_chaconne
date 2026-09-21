import { describe, expect, it } from "vitest";
import { makeAssetKey, parseAssetKey, toCreateVerifyJob, validateCreateJob } from "../src/verify";
import { fixtureJob, FIXTURE_STABLE, FIXTURE_STOCK_KEY } from "../src/verify/fixtures";

describe("validateCreateJob（§5.1 校验）", () => {
  it("合法请求 → 规范化：地址小写、参数展开", () => {
    const v = validateCreateJob(fixtureJob({ ownerAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.job.ownerAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(v.job.params).toEqual({ maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300 });
    expect(toCreateVerifyJob(v.job).maxPriceImpactBps).toBe(100);
  });

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["非对象", null as unknown as Record<string, unknown>, "not_object"],
    ["零收款地址", { recipientAddress: "0x0000000000000000000000000000000000000000" }, "zero_address"],
    ["非法地址", { ownerAddress: "0x123" }, "invalid_address"],
    ["assetKey 大写", { outputAssetKey: FIXTURE_STOCK_KEY.toUpperCase() }, "invalid"],
    ["assetKey 链不一致", { outputAssetKey: "eip155:1952:0x2222222222222222222222222222222222222222" }, "chain_mismatch"],
    ["输入输出相同", { outputAssetKey: `eip155:196:${FIXTURE_STABLE}` }, "same_as_input"],
    ["金额 0", { amountInRaw: "0" }, "not_positive"],
    ["金额小数", { amountInRaw: "1.5" }, "invalid"],
    ["金额 number", { amountInRaw: 100 }, "invalid"],
    ["exactOut", { mode: "exactOut" }, "unsupported"],
    ["未知策略", { policyId: "LOOSE" }, "unknown"],
    ["未知版本", { policyVersion: "9.9.9" }, "unknown"],
    ["滑点缺失", { maxSlippageBps: null }, "required"],
    ["滑点越界", { maxSlippageBps: 0 }, "out_of_range"],
    ["冲击越界", { maxPriceImpactBps: 5000 }, "out_of_range"],
    ["clientRequestId 含空格", { clientRequestId: "a b" }, "invalid"],
  ];
  for (const [name, patch, code] of bad) {
    it(`拒绝：${name} (${code})`, () => {
      const raw = patch === null ? null : { ...fixtureJob(), ...patch };
      const v = validateCreateJob(raw);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.map((e) => e.code)).toContain(code);
    });
  }

  it("QUOTE_ONLY 不接受偏差参数（范围 0..0 且非必填）", () => {
    const ok = validateCreateJob(fixtureJob({ policyId: "QUOTE_ONLY", maxReferenceDeviationBps: null }));
    expect(ok.ok).toBe(true);
    const bad = validateCreateJob(fixtureJob({ policyId: "QUOTE_ONLY", maxReferenceDeviationBps: 300 }));
    expect(bad.ok).toBe(false);
  });

  it("assetKey 工具", () => {
    expect(makeAssetKey(196, "0xABCDEFabcdef0000000000000000000000000000")).toBe("eip155:196:0xabcdefabcdef0000000000000000000000000000");
    expect(parseAssetKey("eip155:196:0xabcdefabcdef0000000000000000000000000000")).toEqual({ chainId: 196, address: "0xabcdefabcdef0000000000000000000000000000" });
    expect(parseAssetKey("solana:abc")).toBeNull();
    expect(() => makeAssetKey(0, FIXTURE_STABLE)).toThrow();
  });
});
