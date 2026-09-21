/**
 * 确定性规范化与哈希（技术设计 §5.3）。
 *
 * canonicalJson 规则（版本 `canon-1`）：
 *  - 对象键按 UTF-16 code unit 升序；
 *  - undefined 字段丢弃；null 保留；
 *  - number 只允许安全整数（其它数值必须先转十进制串）；
 *  - 数组保持原顺序（调用方负责排序语义）；
 *  - 字符串按 JSON 标准转义；无空白。
 * 哈希 = keccak256(utf8(canonicalJson))，返回 `0x` + 64 hex。
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Bytes32 } from "./contracts";

export const CANONICAL_VERSION = "canon-1";

export type Canonical = string | number | boolean | null | Canonical[] | { [k: string]: Canonical | undefined };

export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(v: unknown, path: string): string {
  if (v === null) return "null";
  if (v === undefined) throw new Error(`canonical: 顶层/数组元素不得为 undefined (${path})`);
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(v)) throw new Error(`canonical: 非安全整数 number 必须转为字符串 (${path}=${v})`);
      return String(v);
    case "bigint":
      throw new Error(`canonical: bigint 必须转为十进制字符串 (${path})`);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v.map((x, i) => encode(x, `${path}[${i}]`)).join(",")}]`;
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonical: 不支持的类型 ${typeof v} (${path})`);
  }
}

export function keccak256Hex(bytes: Uint8Array): Bytes32 {
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

export function keccak256Utf8(s: string): Bytes32 {
  return keccak256Hex(utf8ToBytes(s));
}

/** 任意可规范化对象 → keccak256(canonicalJson)。 */
export function hashCanonical(value: unknown): Bytes32 {
  return keccak256Utf8(canonicalJson(value));
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`非法 hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function isBytes32(s: unknown): s is Bytes32 {
  return typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s);
}
