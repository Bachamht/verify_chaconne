/**
 * 链 IO 接口（执行进程与测试共用；测试注入假链）+ viem 实现。只读调用与原始交易广播，签名在 sender.ts 里本地完成。
 */
import { createPublicClient, http, keccak256, type Hex, type PublicClient } from "viem";
import { MANDATE_STATE_ABI, TOKEN_ABI } from "./abi";

export interface ChainReceiptLite {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: Array<{ address: string; data: Hex; topics: Hex[] }>;
}
export interface ChainIO {
  chainId: number;
  estimateGas(a: { from: Hex; to: Hex; data: Hex; value: bigint }): Promise<bigint>;
  /** EIP-1559 费用；不支持时返回 gasPrice */
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint }>;
  pendingNonce(address: Hex): Promise<number>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
  getReceipt(hash: Hex): Promise<ChainReceiptLite | null>;
  /** 交易在节点上可见（含 pending）→ true */
  hasTransaction(hash: Hex): Promise<boolean>;
  mandateState(planGuard: Hex, digest: Hex): Promise<{ spent: bigint; steps: number; revoked: boolean }>;
  allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint>;
  balanceOf(token: Hex, owner: Hex): Promise<bigint>;
  nonces(token: Hex, owner: Hex): Promise<bigint>;
  /** permit 干跑：eth_call 不回退 → null；回退 → 错误 */
  call(a: { from: Hex; to: Hex; data: Hex }): Promise<unknown | null>;
  nativeBalance(address: Hex): Promise<bigint>;
  head(): Promise<{ number: bigint; timestamp: bigint }>;
}

export function viemChainIO(rpcUrl: string, chainId: number): ChainIO {
  const chain = { id: chainId, name: `eip155:${chainId}`, nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const pub = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000 }) }) as PublicClient;
  return {
    chainId,
    estimateGas: (a) => pub.estimateGas({ account: a.from, to: a.to, data: a.data, value: a.value }),
    async fees() {
      try {
        const f = await pub.estimateFeesPerGas();
        if (f.maxFeePerGas !== undefined && f.maxPriorityFeePerGas !== undefined) return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
      } catch {
        /* 退回 legacy */
      }
      return { gasPrice: await pub.getGasPrice() };
    },
    pendingNonce: (address) => pub.getTransactionCount({ address, blockTag: "pending" }),
    sendRawTransaction: (raw) => pub.sendRawTransaction({ serializedTransaction: raw }),
    async getReceipt(hash) {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, logs: r.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics as Hex[] })) };
      } catch (e) {
        if (e instanceof Error && /not (be )?found|could not be found/i.test(e.message)) return null;
        throw e;
      }
    },
    async hasTransaction(hash) {
      try {
        await pub.getTransaction({ hash });
        return true;
      } catch (e) {
        if (e instanceof Error && /not (be )?found|could not be found/i.test(e.message)) return false;
        throw e;
      }
    },
    async mandateState(planGuard, digest) {
      const [spent, steps, revoked] = await pub.readContract({ address: planGuard, abi: MANDATE_STATE_ABI, functionName: "mandateState", args: [digest] });
      return { spent, steps: Number(steps), revoked };
    },
    allowance: (token, owner, spender) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "allowance", args: [owner, spender] }),
    balanceOf: (token, owner) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [owner] }),
    nonces: (token, owner) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "nonces", args: [owner] }),
    async call(a) {
      await pub.call({ account: a.from, to: a.to, data: a.data });
      return null;
    },
    nativeBalance: (address) => pub.getBalance({ address }),
    async head() {
      const b = await pub.getBlock();
      return { number: b.number, timestamp: b.timestamp };
    },
  };
}

export const rawTxHash = (raw: Hex): Hex => keccak256(raw);
