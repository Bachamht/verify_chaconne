/**
 * verify-service 内置 GUARD_ABI 必须与 Foundry 产物一致（选择器 / 事件签名 / 结构字段顺序）。
 * 合约改了接口而没同步 TS 侧 → 这里先红。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from "viem";
import { GUARD_ABI } from "../src/execution/guardAbi";

const ABI_FILE = join(__dirname, "..", "..", "..", "packages", "verify-contracts", "abi", "ChaconneVerifyGuard.json");

describe("GUARD_ABI 与 Foundry 产物一致", () => {
  const skip = !existsSync(ABI_FILE);
  it.skipIf(skip)("execute/cancelNonce/nonceUsed 选择器与 GuardedExecution 事件签名一致", () => {
    const artifact = JSON.parse(readFileSync(ABI_FILE, "utf8")) as { abi: Array<AbiFunction | AbiEvent> };
    const fnSel = (abi: readonly unknown[], name: string) => {
      const f = abi.find((x) => (x as AbiFunction).type === "function" && (x as AbiFunction).name === name) as AbiFunction | undefined;
      if (!f) throw new Error(`missing function ${name}`);
      return toFunctionSelector(f);
    };
    const evSel = (abi: readonly unknown[], name: string) => {
      const e = abi.find((x) => (x as AbiEvent).type === "event" && (x as AbiEvent).name === name) as AbiEvent | undefined;
      if (!e) throw new Error(`missing event ${name}`);
      return toEventSelector(e);
    };
    for (const name of ["execute", "cancelNonce", "nonceUsed"]) {
      expect(fnSel(GUARD_ABI, name), name).toBe(fnSel(artifact.abi, name));
    }
    expect(evSel(GUARD_ABI, "GuardedExecution")).toBe(evSel(artifact.abi, "GuardedExecution"));
  });
});
