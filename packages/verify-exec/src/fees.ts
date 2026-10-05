/**
 * 每笔交易费用上限（D-089 修订，运营者确认 2026-10-02 14:00：主要保护是费用而不是笔数）。
 * 签名前强制：gas 用量（估算 ×1.3 后）、maxFeePerGas（legacy 时为 gasPrice）、maxPriorityFeePerGas、gas × maxFeePerGas 四项任一超上限
 * → ExecTxError("fee_cap_exceeded")，不取 nonce、不签名；执行进程把它作为 preflight_failed 上报。
 *
 * 缺省值的依据（只读 RPC 实测，2026-10-02，https://rpc.xlayer.tech，区块 72145255）：baseFeePerGas = 20 000 000 wei（0.02 gwei）、
 * eth_maxPriorityFeePerGas = 1 wei、OP Stack 回执 l1Fee = 0；executeStep 一笔约 61 万 gas（运营者简报 / 分叉实测口径，未在此重测）。
 *   maxGasLimit       1 500 000            ≈ 61 万 × 1.3 估算余量后再留约 2 倍
 *   maxFeePerGas      200 000 000 wei      = 实测 baseFee 的 10 倍（0.2 gwei）
 *   maxPriorityFee    20 000 000 wei       （实测 1 wei）
 *   maxFeePerTx       200 000 000 000 000  = 0.0002 OKB；正常一笔 ≈ 79 万 gas × 0.024 gwei ≈ 0.000019 OKB
 * 这些是保守的护栏，不是对未来费率的保证；链上费率上涨超过上限时执行身份会拒绝发送（作业 FAILED fee_cap_exceeded，运营者处理）。
 */
import { parseTransaction, type Hex } from "viem";
import { ExecTxError } from "./allowlist";

export interface FeeCaps {
  maxGasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerTx: bigint;
}

export const DEFAULT_FEE_CAPS: Readonly<FeeCaps> = Object.freeze({
  maxGasLimit: 1_500_000n,
  maxFeePerGas: 200_000_000n,
  maxPriorityFeePerGas: 20_000_000n,
  maxFeePerTx: 200_000_000_000_000n,
});

export const FEE_CAP_ENV = {
  maxGasLimit: "EXECUTOR_MAX_GAS_LIMIT",
  maxFeePerGas: "EXECUTOR_MAX_FEE_PER_GAS_WEI",
  maxPriorityFeePerGas: "EXECUTOR_MAX_PRIORITY_FEE_PER_GAS_WEI",
  maxFeePerTx: "EXECUTOR_MAX_FEE_PER_TX_WEI",
} as const;

/** 从 env 读上限：缺省用 DEFAULT_FEE_CAPS；给了就必须是正整数（wei / gas） */
export function parseFeeCaps(env: Record<string, string | undefined>): FeeCaps {
  const out = { ...DEFAULT_FEE_CAPS };
  const problems: string[] = [];
  for (const [k, name] of Object.entries(FEE_CAP_ENV) as Array<[keyof FeeCaps, string]>) {
    const raw = (env[name] ?? "").trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) problems.push(`${name} 必须是正整数`);
    else out[k] = BigInt(raw);
  }
  if (problems.length) throw new Error(problems.join("；"));
  return out;
}

export type TxFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };

/** 超任一上限 → ExecTxError("fee_cap_exceeded")；返回这笔交易可能的最大费用 gas × maxFeePerGas */
export function assertFeeCaps(gas: bigint, fees: TxFees, caps: FeeCaps): bigint {
  const perGas = "gasPrice" in fees ? fees.gasPrice : fees.maxFeePerGas;
  const over = (what: string, v: bigint, cap: bigint) => new ExecTxError("fee_cap_exceeded", `fee cap exceeded: ${what} ${v} > cap ${cap}`);
  if (gas > caps.maxGasLimit) throw over("gas_limit", gas, caps.maxGasLimit);
  if (perGas > caps.maxFeePerGas) throw over("max_fee_per_gas", perGas, caps.maxFeePerGas);
  if (!("gasPrice" in fees) && fees.maxPriorityFeePerGas > caps.maxPriorityFeePerGas) throw over("max_priority_fee_per_gas", fees.maxPriorityFeePerGas, caps.maxPriorityFeePerGas);
  const total = gas * perGas;
  if (total > caps.maxFeePerTx) throw over("tx_fee", total, caps.maxFeePerTx);
  return total;
}

/** 解析已签名的原始交易：最大可能费用 = gas × maxFeePerGas（legacy = gasPrice）；解析不了 → null（服务端按每笔上限预留） */
export function maxFeeOfRawTx(raw: Hex): { gas: bigint; maxFeePerGas: bigint; maxFeeWei: bigint } | null {
  try {
    const t = parseTransaction(raw);
    const gas = t.gas;
    const perGas = t.maxFeePerGas ?? t.gasPrice;
    if (gas === undefined || perGas === undefined) return null;
    return { gas, maxFeePerGas: perGas, maxFeeWei: gas * perGas };
  } catch {
    return null;
  }
}
