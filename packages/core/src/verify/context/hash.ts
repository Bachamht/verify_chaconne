/**
 * 上下文签名载荷与哈希（interfaces §11.3）：
 *   signingPayload = canonicalJson(ctx 去掉 signature)   —— canon-1，与 crowsnest（Python）对拍
 *   contextHash    = keccak256(utf8(signingPayload))      —— 进 MarketContextEvidence.contextHash
 * Ed25519 验签本身不在 core（浏览器无 node:crypto）：service 侧用 node:crypto 对 signingPayload 的 UTF-8 字节验签。
 */
import { canonicalJson, keccak256Utf8 } from "../canonical";
import type { Bytes32, MarketContext } from "../contracts";

/**
 * 签名载荷必须用 producer 给的**原始对象**（去掉 signature 键）算：签名覆盖原文里的全部键，
 * 包括本服务不认识、校验时会剥离的键（X-06）。所以先对原文验签，再用重建后的对象入库/响应。
 */
export function contextSigningPayload(raw: Record<string, unknown> | MarketContext): string {
  const { signature: _sig, ...rest } = raw as Record<string, unknown>;
  void _sig;
  return canonicalJson(rest);
}

export function contextHash(raw: Record<string, unknown> | MarketContext): Bytes32 {
  return keccak256Utf8(contextSigningPayload(raw));
}
