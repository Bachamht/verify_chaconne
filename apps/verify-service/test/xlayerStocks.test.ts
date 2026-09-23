/**
 * core 的 XLAYER_EXECUTABLE_STOCKS 必须与执行登记表严格一致。
 * 这份清单以前手维护在主站，登记表一扩容就漂移；漂移的后果是主站给出的 Agent 深链
 * 指向一只 Verify 并未放行执行的股票，用户点进去必然失败。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { XLAYER_EXECUTABLE_STOCKS, xlayerStockFor } from "@chaconne/core";

const reg = JSON.parse(readFileSync("config/registry.xlayer.v1.2.json", "utf8")) as {
  version: string;
  entries: Array<{ role: string; executionAllowed: boolean; displaySymbol: string; underlyingId: string }>;
};
const allowed = reg.entries.filter((e) => e.role === "stock_output" && e.executionAllowed);
const blocked = reg.entries.filter((e) => e.role === "stock_output" && !e.executionAllowed);

describe("XLAYER_EXECUTABLE_STOCKS ↔ 执行登记表", () => {
  it("条数一致", () => {
    expect(Object.keys(XLAYER_EXECUTABLE_STOCKS)).toHaveLength(allowed.length);
  });
  it("每只放行的股票都能由底层代码查到代币符号（带前缀与不带前缀都要能查）", () => {
    for (const e of allowed) {
      expect(xlayerStockFor(e.underlyingId)).toBe(e.displaySymbol);
      expect(xlayerStockFor(e.underlyingId.split(":").pop()!)).toBe(e.displaySymbol);
    }
  });
  it("未放行执行的不得出现——买得进卖不出的不能给深链", () => {
    expect(blocked.length).toBeGreaterThan(0);
    for (const e of blocked) expect(xlayerStockFor(e.underlyingId)).toBeNull();
  });
  it("稳定币不在清单里", () => {
    for (const e of reg.entries.filter((x) => x.role === "stable_input")) {
      expect(Object.values(XLAYER_EXECUTABLE_STOCKS)).not.toContain(e.displaySymbol);
    }
  });
  it("登记表本身：放行的股票都必须是 stock_output 且带 executionSides", () => {
    for (const e of allowed) expect(e.role).toBe("stock_output");
  });
});
