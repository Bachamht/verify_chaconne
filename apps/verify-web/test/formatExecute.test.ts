/** V-37 · 报告页 / 执行页人类单位：原始单位 → 「5 USDG」「≈0.01488 AAPLx」，价格 2–4 位，时刻带标签。 */
import { describe, expect, it } from "vitest";
import { assetMeta, fmtAmount, fmtClock, fmtPrice } from "../lib/format.execute";

describe("fmtAmount", () => {
  it("稳定币 6 位精度：5000000 → 5 USDG；带小数最多 4 位", () => {
    expect(fmtAmount("5000000", 6, "USDG")).toBe("5 USDG");
    expect(fmtAmount("7298894", 6, "USDG")).toBe("7.2988 USDG");
    expect(fmtAmount(2000000n, 6, "USDG")).toBe("2 USDG");
  });
  it("股票代币 18 位精度、小于 1：保留 4 位有效数字，≈ 表示估算", () => {
    expect(fmtAmount("14881933517207632", 18, "AAPLx", { approx: true })).toBe("≈0.01488 AAPLx");
    expect(fmtAmount("14807523849621593", 18, "AAPLx")).toBe("0.0148 AAPLx");
  });
  it("空值与非法值：不猜", () => {
    expect(fmtAmount(null, 6, "USDG")).toBe("—");
    expect(fmtAmount("", 6, "USDG")).toBe("—");
    expect(fmtAmount("abc", 6, "USDG")).toBe("abc");
  });
  it("没有符号时不留尾随空格", () => {
    expect(fmtAmount("1000000", 6, "")).toBe("1");
  });
});

describe("fmtPrice", () => {
  it("≥ 1 两位小数，< 1 四位", () => {
    expect(fmtPrice("335.977848188786")).toBe("$335.98");
    expect(fmtPrice("0.123456")).toBe("$0.1235");
    expect(fmtPrice(1234.5)).toBe("$1,234.50");
  });
  it("非数字原样返回，空值为 —", () => {
    expect(fmtPrice("n/a")).toBe("n/a");
    expect(fmtPrice(null)).toBe("—");
  });
});

describe("fmtClock / assetMeta", () => {
  it("时刻是 HH:mm:ss（本地）", () => {
    expect(fmtClock("2026-09-24T04:20:18Z", "zh")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(fmtClock("not a date")).toBe("not a date");
  });
  it("登记表命中用真实精度与符号；未命中给保守默认且 known=false", () => {
    const list = [{ assetKey: "evm:196:0xabc", tokenDecimals: 6, displaySymbol: "USDG" }];
    expect(assetMeta(list, "evm:196:0xabc", "stable_input")).toEqual({ decimals: 6, symbol: "USDG", known: true });
    expect(assetMeta(list, "evm:196:0xdef", "stock_output")).toEqual({ decimals: 18, symbol: "", known: false });
    expect(assetMeta(null, "x", "stable_input").decimals).toBe(6);
  });
});
