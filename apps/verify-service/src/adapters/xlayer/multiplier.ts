/**
 * xStocks EVM 代币链上乘数读取（W5 / CV-D06 单位证据）。
 * 函数名来自**已验证源码**（不猜）：OKLink verify-contract-info（chainShortName=xlayer）
 *   代理 0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a = BackedTokenProxy，implementation 0x65c40d624af3b18c109fbf87b7deff34cdc5f19b
 *   = BackedAutoFeeTokenImplementation（solc v0.8.9+commit.e5eed63a），源码片段：
 *     uint256 public multiplier;   // "Defines ratio between a single share of a token to balance of a token. Defined in 1e18 precision."
 *     function getCurrentMultiplier() public view virtual returns (uint256 newMultiplier, uint256 periodsPassed, uint256 newMultiplierNonce)
 *     function sharesOf(address account) public view virtual returns (uint256)
 *     balanceOf(account) = _getUnderlyingAmountByShares(sharesOf(account), newMultiplier)
 *   NVDAx 0xc845…849d 与 SPYx 0x90a2…dd48 指向同一 implementation（EIP-1967 槽位读取，2026-09-21）。
 * 详见 docs/devday-2026/the address-approval log (internal) #12。
 */
import type { PublicClient } from "viem";
import { getAddress } from "viem";

export const XSTOCKS_MULTIPLIER_ABI = [
  {
    type: "function",
    name: "getCurrentMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "newMultiplier", type: "uint256" },
      { name: "periodsPassed", type: "uint256" },
      { name: "newMultiplierNonce", type: "uint256" },
    ],
  },
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "sharesOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** 1e18 精度 → 十进制串（保留全部 18 位小数，不做四舍五入） */
export function multiplierToDecimal(raw: bigint): string {
  const whole = raw / 10n ** 18n;
  const frac = (raw % 10n ** 18n).toString().padStart(18, "0");
  return `${whole}.${frac}`;
}

export interface OnchainMultiplier {
  raw: bigint;
  decimal: string;
  nonce: bigint;
  periodsPassed: bigint;
}

/** 读取当前乘数；合约不实现该函数（非 xStocks 代币）或调用失败 → null */
export async function readCurrentMultiplier(rpc: PublicClient, tokenAddress: string): Promise<OnchainMultiplier | null> {
  try {
    const r = (await rpc.readContract({ address: getAddress(tokenAddress), abi: XSTOCKS_MULTIPLIER_ABI, functionName: "getCurrentMultiplier" })) as unknown;
    if (!Array.isArray(r) || r.length < 3 || typeof r[0] !== "bigint") return null;
    const [raw, periodsPassed, nonce] = r as [bigint, bigint, bigint];
    if (raw <= 0n) return null;
    return { raw, decimal: multiplierToDecimal(raw), nonce, periodsPassed };
  } catch {
    return null;
  }
}

/** 链上乘数 vs OKX 列表 ratio（ratio 只有 6 位小数）：|a−b|/b ≤ toleranceBps → 一致 */
export function multiplierMatchesRatio(onchainDecimal: string, ratio: string | null | undefined, toleranceBps = 1): boolean | null {
  if (!ratio || !/^\d+(\.\d+)?$/.test(ratio) || !/^\d+(\.\d+)?$/.test(onchainDecimal)) return null;
  const a = Number(onchainDecimal);
  const b = Number(ratio);
  if (!(a > 0) || !(b > 0)) return null;
  return Math.abs(a - b) / b <= toleranceBps / 10_000;
}
