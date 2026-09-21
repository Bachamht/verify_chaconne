import { describe, expect, it } from "vitest";
import {
  bpsToPercentString,
  computeMinOutRaw,
  decimalToFixed,
  deviationBps,
  executableUsdPerShare,
  fixedToDecimal,
  formatUnits,
  parseAdverseImpactBps,
  parseRaw,
} from "../src/verify";

describe("amounts：整数金额与定点换算（D-05 独立手算表）", () => {
  it("parseRaw 拒绝非整数/前导零/负数", () => {
    expect(parseRaw("0")).toBe(0n);
    expect(parseRaw("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    for (const bad of ["01", "-1", "1.5", "1e3", "", " 1", "0x10"]) {
      expect(() => parseRaw(bad)).toThrow();
    }
  });

  it("decimalToFixed / fixedToDecimal 往返（截断而非四舍五入）", () => {
    expect(decimalToFixed("250", 6)).toBe(250_000_000n);
    expect(decimalToFixed("0.1234567", 6)).toBe(123_456n);
    expect(decimalToFixed("-1.5", 2)).toBe(-150n);
    expect(fixedToDecimal(250_000_000n, 6)).toBe("250");
    expect(fixedToDecimal(123_456n, 6)).toBe("0.123456");
    expect(fixedToDecimal(-150n, 2)).toBe("-1.5");
    expect(fixedToDecimal(5n, 3)).toBe("0.005");
    expect(formatUnits("400000000000000000", 18)).toBe("0.4");
    expect(formatUnits("100000000", 6)).toBe("100");
  });

  it("minOut：向下取整，边界 0/9999 bps", () => {
    expect(computeMinOutRaw("1000000", 50)).toBe("995000");
    expect(computeMinOutRaw("1000001", 50)).toBe("995000"); // 995000.995 → floor
    expect(computeMinOutRaw("7", 1)).toBe("6"); // 6.9993 → 6
    expect(computeMinOutRaw("7", 0)).toBe("7");
    expect(computeMinOutRaw("7", 9999)).toBe("0");
    expect(() => computeMinOutRaw("7", 10_000)).toThrow();
    expect(() => computeMinOutRaw("7", -1)).toThrow();
  });

  it("priceImpactPercent → 不利 bps：null/非法保持 null；负=不利向上取整；正=0", () => {
    expect(parseAdverseImpactBps(null)).toBeNull();
    expect(parseAdverseImpactBps(undefined)).toBeNull();
    expect(parseAdverseImpactBps("")).toBeNull();
    expect(parseAdverseImpactBps("NaN")).toBeNull();
    expect(parseAdverseImpactBps("abc")).toBeNull();
    expect(parseAdverseImpactBps("-0.5")).toBe(50);
    expect(parseAdverseImpactBps("-0.001")).toBe(1); // 0.1bps → 向上取 1
    expect(parseAdverseImpactBps("-0.12")).toBe(12);
    expect(parseAdverseImpactBps("-12.3456")).toBe(1235);
    expect(parseAdverseImpactBps("0")).toBe(0);
    expect(parseAdverseImpactBps("0.8")).toBe(0);
  });

  it("bps → OKX slippagePercent 字符串", () => {
    expect(bpsToPercentString(50)).toBe("0.5");
    expect(bpsToPercentString(1)).toBe("0.01");
    expect(bpsToPercentString(300)).toBe("3");
    expect(bpsToPercentString(10_000)).toBe("100");
  });

  it("deviationBps：定点、四舍五入、分母 ≤0 → null", () => {
    expect(deviationBps("250", "250")).toBe(0);
    expect(deviationBps("252", "250")).toBe(80);
    expect(deviationBps("248", "250")).toBe(-80);
    expect(deviationBps("333.333333333333", "250")).toBe(3333);
    expect(deviationBps("250.00125", "250")).toBe(0); // 0.05bps → 0
    expect(deviationBps("250.0125", "250")).toBe(1); // 0.5bps → 1（四舍五入）
    expect(deviationBps("1", "0")).toBeNull();
  });

  it("executableUsdPerShare：100 USD(6dec) → 0.4 股(18dec) = $250/股；换算缺失 → null", () => {
    const base = { amountInRaw: "100000000", inDecimals: 6, expectedOutRaw: "400000000000000000", outDecimals: 18 };
    expect(executableUsdPerShare({ ...base, usdPerInputToken: "1", sharesPerToken: "1" })).toBe("250");
    // 稳定币脱锚 0.99 → 每股实付 $247.5
    expect(executableUsdPerShare({ ...base, usdPerInputToken: "0.99", sharesPerToken: "1" })).toBe("247.5");
    // rebasing：1 代币 = 1.02 股 → 0.408 股 → $245.098039215686
    expect(executableUsdPerShare({ ...base, usdPerInputToken: "1", sharesPerToken: "1.02" })).toBe("245.098039215686");
    expect(executableUsdPerShare({ ...base, usdPerInputToken: null, sharesPerToken: "1" })).toBeNull();
    expect(executableUsdPerShare({ ...base, usdPerInputToken: "1", sharesPerToken: null })).toBeNull();
    expect(executableUsdPerShare({ ...base, expectedOutRaw: "0", usdPerInputToken: "1", sharesPerToken: "1" })).toBeNull();
  });
});
