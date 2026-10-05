/**
 * EIP-2612 permit（v7 §2.3，D-091 / CV-D20）——独立实现，不依赖 viem；测试中与 viem hashTypedData / hashDomain 互检。
 *
 * 域（name / version）只从链上对拍得来（scripts/permitDomains.ts → config/permit-domains.xlayer.json，运营者批准后生效），
 * 本文件不含任何代币的域常量。`version: null` = 该代币的域不含 version 字段（EIP712Domain(string name,uint256 chainId,address verifyingContract)）。
 * deadline 只是签名可提交的截止时间（签名时刻 + 1800 s），不是额度有效期；额度上链后一直有效直到被改写。
 */
import { hexToBytes, keccak256Hex, keccak256Utf8 } from "../canonical";
import { PERMIT_DEADLINE_S, type Bytes32, type Eip712TypedData, type EvmAddress, type Hex, type RawAmount } from "../contracts";

export interface PermitDomain {
  name: string;
  /** null = 域里不含 version */
  version: string | null;
  chainId: number;
  verifyingContract: EvmAddress;
}
export interface PermitMessage {
  owner: EvmAddress;
  spender: EvmAddress;
  value: RawAmount;
  nonce: RawAmount;
  /** unix 秒（十进制串） */
  deadline: string;
}

export const PERMIT_TYPE = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)" as const;
export const PERMIT_TYPEHASH: Bytes32 = keccak256Utf8(PERMIT_TYPE);
/** permit(address,address,uint256,uint256,uint8,bytes32,bytes32) */
export const PERMIT_SELECTOR = "0xd505accf" as const;
export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const DOMAIN_TYPE_WITH_VERSION = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const DOMAIN_TYPE_NO_VERSION = "EIP712Domain(string name,uint256 chainId,address verifyingContract)";
const UINT256_MAX = (1n << 256n) - 1n;

function uintWord(v: string | bigint | number, label: string): Uint8Array {
  const b = BigInt(v);
  if (b < 0n || b > UINT256_MAX) throw new Error(`${label} 越界: ${v}`);
  return hexToBytes(b.toString(16).padStart(64, "0"));
}
function addressWord(a: string, label: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${label} 非法地址: ${a}`);
  const out = new Uint8Array(32);
  out.set(hexToBytes(a), 12);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** EIP-712 域分隔符（含 / 不含 version 两种域类型） */
export function permitDomainSeparator(domain: PermitDomain): Bytes32 {
  const withVersion = domain.version !== null;
  const typeHash = hexToBytes(keccak256Utf8(withVersion ? DOMAIN_TYPE_WITH_VERSION : DOMAIN_TYPE_NO_VERSION));
  const parts = [typeHash, hexToBytes(keccak256Utf8(domain.name))];
  if (withVersion) parts.push(hexToBytes(keccak256Utf8(domain.version as string)));
  parts.push(uintWord(domain.chainId, "chainId"), addressWord(domain.verifyingContract, "verifyingContract"));
  return keccak256Hex(concat(parts));
}

export function permitStructHash(m: PermitMessage): Bytes32 {
  return keccak256Hex(concat([hexToBytes(PERMIT_TYPEHASH), addressWord(m.owner, "owner"), addressWord(m.spender, "spender"), uintWord(m.value, "value"), uintWord(m.nonce, "nonce"), uintWord(m.deadline, "deadline")]));
}

/** 签名摘要 = keccak256(0x1901 ‖ domainSeparator ‖ structHash) */
export function permitDigest(domain: PermitDomain, m: PermitMessage): Bytes32 {
  return keccak256Hex(concat([new Uint8Array([0x19, 0x01]), hexToBytes(permitDomainSeparator(domain)), hexToBytes(permitStructHash(m))]));
}

/** 钱包 / viem signTypedData 直接可用的 typedData（domain 不含 version 时不写该字段） */
export function permitTypedData(domain: PermitDomain, m: PermitMessage): Eip712TypedData {
  return {
    domain: { name: domain.name, ...(domain.version !== null ? { version: domain.version } : {}), chainId: domain.chainId, verifyingContract: domain.verifyingContract.toLowerCase() as EvmAddress },
    types: { Permit: PERMIT_TYPES.Permit.map((f) => ({ ...f })) },
    primaryType: "Permit",
    message: { owner: m.owner.toLowerCase(), spender: m.spender.toLowerCase(), value: String(m.value), nonce: String(m.nonce), deadline: String(m.deadline) },
  };
}

/** 从 typedData 取回 PermitDomain / PermitMessage（服务端校验 POST /allowances 时用 ISSUED 的那份） */
export function permitFromTypedData(td: Eip712TypedData): { domain: PermitDomain; message: PermitMessage } {
  const d = td.domain;
  const m = td.message as Record<string, unknown>;
  if (td.primaryType !== "Permit" || typeof d.name !== "string" || typeof d.chainId !== "number" || !d.verifyingContract) throw new Error("不是 permit typedData");
  return {
    domain: { name: d.name, version: typeof d.version === "string" ? d.version : null, chainId: d.chainId, verifyingContract: d.verifyingContract },
    message: { owner: String(m["owner"]) as EvmAddress, spender: String(m["spender"]) as EvmAddress, value: String(m["value"]), nonce: String(m["nonce"]), deadline: String(m["deadline"]) },
  };
}

/** deadline = 签名时刻 + 1800 s */
export function permitDeadline(nowSec: number): string {
  return String(Math.floor(nowSec) + PERMIT_DEADLINE_S);
}

/**
 * 域候选（permitDomains.ts 用）：version ∈ {"1","2"}、不含 version，再加调用方从官方源码里读到的其它写法。
 * 只有重算结果与链上 DOMAIN_SEPARATOR() 完全相等的候选才被记录；本函数不判断哪个是对的。
 */
export function permitDomainCandidates(name: string, chainId: number, token: EvmAddress, extraVersions: readonly string[] = []): PermitDomain[] {
  const versions: Array<string | null> = ["1", "2", null, ...extraVersions.filter((v) => v !== "1" && v !== "2")];
  return versions.map((version) => ({ name, version, chainId, verifyingContract: token }));
}

/** 找出与链上 DOMAIN_SEPARATOR 完全相等的候选；没有 → null */
export function matchPermitDomain(candidates: readonly PermitDomain[], onchainSeparator: Bytes32): PermitDomain | null {
  const want = onchainSeparator.toLowerCase();
  return candidates.find((c) => permitDomainSeparator(c).toLowerCase() === want) ?? null;
}

export interface DecodedPermitCall {
  owner: EvmAddress;
  spender: EvmAddress;
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** 解码 permit(owner, spender, value, deadline, v, r, s) calldata；不是 permit 或长度不对 → null（执行身份白名单用） */
export function decodePermitCalldata(data: Hex): DecodedPermitCall | null {
  const h = data.toLowerCase();
  if (!h.startsWith(PERMIT_SELECTOR) || h.length !== 10 + 64 * 7) return null;
  const w = (i: number) => h.slice(10 + 64 * i, 10 + 64 * (i + 1));
  const addr = (i: number): EvmAddress | null => (/^0{24}/.test(w(i)) ? (`0x${w(i).slice(24)}` as EvmAddress) : null);
  const owner = addr(0);
  const spender = addr(1);
  const v = BigInt(`0x${w(4)}`);
  if (!owner || !spender || v > 255n) return null;
  return { owner, spender, value: BigInt(`0x${w(2)}`), deadline: BigInt(`0x${w(3)}`), v: Number(v), r: `0x${w(5)}` as Hex, s: `0x${w(6)}` as Hex };
}
