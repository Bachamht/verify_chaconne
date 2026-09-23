/**
 * crowsnest Ed25519 公钥（env `CROWSNEST_PUBKEY_ED25519`，按 publicKeyId 选）与验签。
 * 只用 node:crypto（Node 22 原生 Ed25519，RFC 8032 pure；与 PyNaCl SigningKey.sign 兼容），不新增依赖。
 * 这里只有公钥：不是私钥，不受 assertOnlyAttestationKey 护栏约束（变量名也不含 PRIVATE/SECRET）。
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

/** SubjectPublicKeyInfo 前缀（Ed25519，RFC 8410）：`302a300506032b6570032100` + 32 字节原始公钥 */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function decodeKeyBytes(s: string): Buffer {
  const t = s.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t.replace(/^0x/, ""), "hex");
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(t)) return Buffer.from(t.replace(/^0x/, ""), "hex");
  const b = Buffer.from(t, "base64");
  if (b.length === 32 || b.length === 64) return b;
  throw new Error("Ed25519 key/signature must be 32/64 bytes as hex or base64");
}

export function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export interface CrowsnestKeyring {
  /** null = 未配置该 id 的公钥 */
  get(publicKeyId: string): KeyObject | null;
  readonly ids: string[];
}

/** 解析 `id=key,id2=key2` 或单个裸 key（对任何 publicKeyId 生效，记为 "*"） */
export function parseKeyring(raw: string): CrowsnestKeyring {
  const map = new Map<string, KeyObject>();
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const id = eq > 0 ? part.slice(0, eq).trim() : "*";
    const key = eq > 0 ? part.slice(eq + 1) : part;
    map.set(id, ed25519PublicKeyFromRaw(decodeKeyBytes(key)));
  }
  return { get: (id) => map.get(id) ?? map.get("*") ?? null, ids: [...map.keys()] };
}

export function verifyEd25519(pub: KeyObject, message: string, signature: string): boolean {
  try {
    const sig = decodeKeyBytes(signature);
    if (sig.length !== 64) return false;
    return cryptoVerify(null, Buffer.from(message, "utf8"), pub, sig);
  } catch {
    return false;
  }
}
