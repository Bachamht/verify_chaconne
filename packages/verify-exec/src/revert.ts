/**
 * 从 viem / RPC 错误里取出 revert data 或错误名，交给 core classifyRevert 分类（同一张失败分类表）。
 */
import { BaseError, ContractFunctionRevertedError } from "viem";
import { classifyRevert, type RevertClassification } from "@chaconne/core/verify";

function findData(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur; i++) {
    const c = cur as { data?: unknown; cause?: unknown };
    if (typeof c.data === "string" && /^0x[0-9a-fA-F]{8}/.test(c.data)) return c.data;
    if (c.data && typeof c.data === "object" && typeof (c.data as { data?: unknown }).data === "string") return (c.data as { data: string }).data;
    cur = c.cause;
  }
  return null;
}

export function decodeRevertError(err: unknown): RevertClassification & { message: string } {
  const message = err instanceof Error ? err.message.split("\n").slice(0, 4).join(" ").slice(0, 400) : String(err);
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = reverted?.data?.errorName ?? null;
    if (reverted?.raw) {
      const c = classifyRevert({ data: reverted.raw });
      if (c.cls !== "unknown") return { ...c, message };
    }
    if (name) {
      const c = classifyRevert({ errorName: name });
      if (c.cls !== "unknown") return { ...c, message };
    }
  }
  const data = findData(err);
  if (data) {
    const c = classifyRevert({ data });
    if (c.cls !== "unknown") return { ...c, message };
  }
  return { ...classifyRevert({ message: err instanceof Error ? err.message : String(err) }), message };
}

/** RPC 回「nonce too low / already known」→ 串行 nonce 管理器要重同步 */
export function isNonceError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /nonce too low|nonce has already been used|already known|replacement transaction underpriced/.test(m);
}
