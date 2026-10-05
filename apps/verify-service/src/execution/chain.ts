/**
 * v7 服务侧链上只读（签发闸门第 1 条、链上回填、对账器、permit 校验与额度账本）。只读：永不发交易。
 * 测试注入假链（test/v7helpers.ts FakeChain）。
 */
import { createPublicClient, decodeEventLog, encodeEventTopics, http, parseAbi, type Hex } from "viem";
import { PLANGUARD_ABI } from "./planGuardAbi";
import { feeFieldsOf, findMandateStep, type ChainReceipt, type MandateStepSummary } from "./receipts";

export interface StepLog {
  txHash: Hex;
  blockNumber: bigint;
  event: MandateStepSummary;
}
export interface ServiceChain {
  mandateState(planGuard: Hex, digest: Hex): Promise<{ spent: bigint; steps: number; revoked: boolean }>;
  mandateStepLogs(planGuard: Hex, owner: Hex, digest: Hex, fromBlock: bigint, toBlock: bigint): Promise<StepLog[]>;
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint>;
  balanceOf(token: Hex, owner: Hex): Promise<bigint>;
  nonces(token: Hex, owner: Hex): Promise<bigint>;
  domainSeparator(token: Hex): Promise<Hex>;
  getReceipt(txHash: Hex): Promise<ChainReceipt | null>;
}

const TOKEN_ABI = parseAbi([
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const MANDATE_STATE_ABI = parseAbi(["function mandateState(bytes32 digest) view returns (uint256 spent, uint32 steps, bool revoked)"]);

export function viemServiceChain(rpcUrl: string): ServiceChain {
  const pub = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  return {
    async mandateState(planGuard, digest) {
      const [spent, steps, revoked] = await pub.readContract({ address: planGuard, abi: MANDATE_STATE_ABI, functionName: "mandateState", args: [digest] });
      return { spent, steps: Number(steps), revoked };
    },
    async mandateStepLogs(planGuard, owner, digest, fromBlock, toBlock) {
      const topics = encodeEventTopics({ abi: PLANGUARD_ABI, eventName: "MandateStep", args: { owner, mandateDigest: digest } });
      const out: StepLog[] = [];
      // 2 000 块分页（RPC 区间上限）
      for (let from = fromBlock; from <= toBlock; from += 2000n) {
        const to = from + 1999n > toBlock ? toBlock : from + 1999n;
        const logs = await pub.request({ method: "eth_getLogs", params: [{ address: planGuard, topics: topics as Hex[], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] });
        for (const l of logs as Array<{ data: Hex; topics: Hex[]; transactionHash: Hex; blockNumber: Hex; address: string }>) {
          try {
            decodeEventLog({ abi: PLANGUARD_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
            const ev = findMandateStep({ status: "success", blockNumber: BigInt(l.blockNumber), blockHash: "", gasUsed: 0n, logs: [{ address: l.address, data: l.data, topics: l.topics as [Hex, ...Hex[]] }] }, planGuard);
            if (ev) out.push({ txHash: l.transactionHash, blockNumber: BigInt(l.blockNumber), event: ev });
          } catch {
            /* 非 MandateStep */
          }
        }
      }
      return out;
    },
    async head() {
      const b = await pub.getBlock();
      return { number: b.number, timestamp: b.timestamp };
    },
    allowance: (token, owner, spender) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "allowance", args: [owner, spender] }),
    balanceOf: (token, owner) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [owner] }),
    nonces: (token, owner) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "nonces", args: [owner] }),
    domainSeparator: (token) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR" }),
    async getReceipt(txHash) {
      try {
        const r = await pub.getTransactionReceipt({ hash: txHash });
        return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, gasUsed: r.gasUsed, ...feeFieldsOf(r as unknown as { effectiveGasPrice?: unknown; l1Fee?: unknown }), logs: r.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })) };
      } catch (e) {
        if (e instanceof Error && /not (be )?found|could not be found/i.test(e.message)) return null;
        throw e;
      }
    },
  };
}
