/** ABI 漂移守卫：MCP 内嵌的 PlanGuard ABI 子集必须与合约编译产物逐项一致 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodePacked, keccak256 } from "viem";
import { outputSetHash } from "@chaconne/core/verify";
import { normalizeOutputSet, PLAN_GUARD_ABI } from "../src/planGuardAbi";

describe("PlanGuard ABI", () => {
  it("与 packages/verify-contracts/abi/ChaconneVerifyPlanGuard.json 一致（子集逐项相等）", () => {
    const full = (JSON.parse(readFileSync(join(__dirname, "..", "..", "verify-contracts", "abi", "ChaconneVerifyPlanGuard.json"), "utf8")) as { abi: Array<Record<string, unknown>> }).abi;
    const key = (x: Record<string, unknown>) => `${String(x["type"])}:${String(x["name"] ?? "")}:${JSON.stringify(x["inputs"] ?? [])}`;
    const fullKeys = new Set(full.map(key));
    for (const item of PLAN_GUARD_ABI as unknown as Array<Record<string, unknown>>) expect(fullKeys.has(key(item)), `missing/drifted: ${String(item["name"])}`).toBe(true);
    expect(PLAN_GUARD_ABI.some((x) => x.type === "function" && x.name === "executeStep")).toBe(true);
    expect(PLAN_GUARD_ABI.some((x) => x.type === "event" && x.name === "MandateStep")).toBe(true);
    expect(PLAN_GUARD_ABI.filter((x) => x.type === "error").length).toBe(full.filter((x) => x["type"] === "error").length);
  });

  it("normalizeOutputSet 按 uint160 升序去重，与 core outputSetHash / 合约 concat20 一致", () => {
    const a = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
    const b = "0x0d3db2d6a4ca2c2b6a2ae9d4e2c3f7e6a1b2c3d4";
    const set = normalizeOutputSet([a, b, a.toUpperCase().replace("0X", "0x")]);
    expect(set).toEqual([b, a]);
    expect(outputSetHash(set)).toBe(keccak256(encodePacked(["address", "address"], [b, a])));
    expect(() => normalizeOutputSet([])).toThrow();
  });
});
