/**
 * 资产登记（allowlist）：assetKey 规范、查找与 registryHash（技术设计 §4.1）。
 * 登记内容由 Lane B 提供并经运营者批准（硬约束①）；本模块只做纯校验与哈希。
 */
import { hashCanonical } from "./canonical";
import type { AssetRegistry, Bytes32, EvmAddress, RegistryEntry } from "./contracts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ASSET_KEY_RE = /^eip155:(\d+):(0x[0-9a-f]{40})$/;

export function isEvmAddress(s: unknown): s is EvmAddress {
  return typeof s === "string" && ADDRESS_RE.test(s);
}

export function normalizeAddress(addr: string): EvmAddress {
  if (!isEvmAddress(addr)) throw new Error(`非法 EVM 地址: ${addr}`);
  return addr.toLowerCase() as EvmAddress;
}

export function makeAssetKey(chainId: number, address: string): string {
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`非法 chainId: ${chainId}`);
  return `eip155:${chainId}:${normalizeAddress(address)}`;
}

export function parseAssetKey(key: string): { chainId: number; address: EvmAddress } | null {
  const m = ASSET_KEY_RE.exec(key);
  if (!m) return null;
  return { chainId: Number(m[1]), address: m[2] as EvmAddress };
}

export function isZeroAddress(addr: string): boolean {
  return /^0x0{40}$/i.test(addr);
}

/** 登记表哈希：对条目按 assetKey 排序后的规范化内容计算（不含 provenance 之外的可变展示字段）。 */
export function registryHash(reg: AssetRegistry): Bytes32 {
  const entries = [...reg.entries]
    .sort((a, b) => (a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0))
    .map((e) => ({
      assetKey: e.assetKey,
      chainId: e.chainId,
      tokenAddress: e.tokenAddress,
      tokenDecimals: e.tokenDecimals,
      issuerId: e.issuerId,
      underlyingId: e.underlyingId,
      tokenForm: e.tokenForm,
      role: e.role,
      sharesPerToken: e.sharesPerToken,
      usdPegSource: e.usdPegSource,
      executionAllowed: e.executionAllowed,
    }));
  return hashCanonical({ version: reg.version, chainId: reg.chainId, entries });
}

export function findEntry(reg: AssetRegistry, assetKey: string): RegistryEntry | null {
  return reg.entries.find((e) => e.assetKey === assetKey) ?? null;
}

/** 校验登记表内部一致性（assetKey 与 chainId/地址一致、小写、无重复）。 */
export function validateRegistry(reg: AssetRegistry): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const e of reg.entries) {
    const parsed = parseAssetKey(e.assetKey);
    if (!parsed) errs.push(`assetKey 非法: ${e.assetKey}`);
    else {
      if (parsed.chainId !== e.chainId) errs.push(`${e.assetKey}: chainId 不一致`);
      if (parsed.address !== e.tokenAddress) errs.push(`${e.assetKey}: tokenAddress 不一致/未小写`);
      if (parsed.chainId !== reg.chainId) errs.push(`${e.assetKey}: 与登记表 chainId 不一致`);
    }
    if (seen.has(e.assetKey)) errs.push(`重复 assetKey: ${e.assetKey}`);
    seen.add(e.assetKey);
    if (!Number.isInteger(e.tokenDecimals) || e.tokenDecimals < 0 || e.tokenDecimals > 36) {
      errs.push(`${e.assetKey}: decimals 非法`);
    }
    if (e.role === "stock_output" && e.sharesPerToken === null) {
      errs.push(`${e.assetKey}: 股票代币缺 sharesPerToken`);
    }
    if (e.role === "stable_input" && e.usdPegSource === null) {
      errs.push(`${e.assetKey}: 稳定币缺 usdPegSource`);
    }
    if (e.registryVersion !== reg.version) errs.push(`${e.assetKey}: registryVersion 不一致`);
  }
  return errs;
}
