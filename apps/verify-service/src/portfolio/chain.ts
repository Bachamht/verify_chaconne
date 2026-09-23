/**
 * 链上组合读取（C4，Q-01）：登记表全部资产的 balanceOf + 区块号，一次快照钉在同一个区块。
 * 实现：viem JSON-RPC 批量（http batch）+ 每个 eth_call 传同一 blockNumber —— 不依赖 Multicall3 合约地址
 * （外部地址需双源核验 + 运营者批准，见 addresses-pending；批准后可换成 multicall 一次调用，接口不变）。
 * rebasing xStocks 代币同时读 getCurrentMultiplier()（已验证源码，adapters/xlayer/multiplier.ts）作为乘数证据。
 */
import { createPublicClient, erc20Abi, getAddress, http, type PublicClient } from "viem";
import type { AssetRegistry, RegistryEntry, RawAmount } from "@chaconne/core/verify";
import { XSTOCKS_MULTIPLIER_ABI, multiplierToDecimal } from "../adapters/xlayer/multiplier";

/** 真实链上余额读取（B-05）：资金组现金下限检查用；测试注入内存实现 */
export interface BalanceReader {
  balanceOf(owner: string, assetKey: string): Promise<{ balanceRaw: RawAmount; blockNumber: string }>;
}

export interface ChainBalance {
  assetKey: string;
  balanceRaw: RawAmount;
  /** rebasing xStocks：链上乘数（1e18 → 十进制串）；其它 null */
  multiplier: string | null;
  /** 读取失败（RPC 错误）→ true，balanceRaw 置 "0" 且不可当作真实 0 */
  unavailable: boolean;
}
export interface ChainSnapshot {
  chainId: number;
  blockNumber: string;
  blockHash: string | null;
  blockTimestamp: string | null;
  requestedAt: string;
  receivedAt: string;
  balances: ChainBalance[];
}

export interface PortfolioReader extends BalanceReader {
  snapshot(owner: string, registry: AssetRegistry): Promise<ChainSnapshot>;
}

export class ChainPortfolioReader implements PortfolioReader {
  private readonly rpc: PublicClient;
  private readonly now: () => Date;
  constructor(d: { rpcUrl?: string; rpc?: PublicClient; now?: () => Date }) {
    this.rpc = d.rpc ?? createPublicClient({ transport: http(d.rpcUrl ?? "https://rpc.xlayer.tech", { batch: true }) });
    this.now = d.now ?? (() => new Date());
  }

  async snapshot(owner: string, registry: AssetRegistry): Promise<ChainSnapshot> {
    const requestedAt = this.now().toISOString();
    const block = await this.rpc.getBlock();
    const account = getAddress(owner);
    const balances = await Promise.all(
      registry.entries.map(async (e: RegistryEntry): Promise<ChainBalance> => {
        const addr = getAddress(e.tokenAddress);
        const wantMultiplier = e.tokenForm === "rebasing" && e.issuerId === "xstocks";
        const [bal, mult] = await Promise.all([
          this.rpc.readContract({ address: addr, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: block.number }).then((v) => (typeof v === "bigint" ? v : null)).catch(() => null),
          wantMultiplier ? this.rpc.readContract({ address: addr, abi: XSTOCKS_MULTIPLIER_ABI, functionName: "getCurrentMultiplier", blockNumber: block.number }).then((r) => (Array.isArray(r) && typeof r[0] === "bigint" && r[0] > 0n ? multiplierToDecimal(r[0]) : null)).catch(() => null) : Promise.resolve(null),
        ]);
        return { assetKey: e.assetKey, balanceRaw: bal === null ? "0" : bal.toString(), multiplier: mult, unavailable: bal === null };
      }),
    );
    return { chainId: registry.chainId, blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), requestedAt, receivedAt: this.now().toISOString(), balances };
  }

  async balanceOf(owner: string, assetKey: string): Promise<{ balanceRaw: RawAmount; blockNumber: string }> {
    const parts = assetKey.split(":");
    const token = parts[2];
    if (!token) throw new Error(`非法 assetKey ${assetKey}`);
    const block = await this.rpc.getBlockNumber();
    const bal = await this.rpc.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)], blockNumber: block });
    return { balanceRaw: (bal as bigint).toString(), blockNumber: block.toString() };
  }
}

/** 测试 / 无 RPC 时的内存实现：余额可随时改（B-06 外部余额下降） */
export class MemoryPortfolioReader implements PortfolioReader {
  blockNumber = 1000n;
  readonly balances = new Map<string, bigint>();
  readonly multipliers = new Map<string, string>();
  constructor(private readonly chainId = 196, private readonly now: () => Date = () => new Date()) {}
  set(owner: string, assetKey: string, balanceRaw: string): void {
    this.balances.set(`${owner.toLowerCase()}|${assetKey.toLowerCase()}`, BigInt(balanceRaw));
  }
  get(owner: string, assetKey: string): bigint {
    return this.balances.get(`${owner.toLowerCase()}|${assetKey.toLowerCase()}`) ?? 0n;
  }
  async snapshot(owner: string, registry: AssetRegistry): Promise<ChainSnapshot> {
    const at = this.now().toISOString();
    this.blockNumber += 1n;
    return { chainId: this.chainId, blockNumber: this.blockNumber.toString(), blockHash: ("0x" + this.blockNumber.toString(16).padStart(64, "0")) as `0x${string}`, blockTimestamp: at, requestedAt: at, receivedAt: at, balances: registry.entries.map((e) => ({ assetKey: e.assetKey, balanceRaw: this.get(owner, e.assetKey).toString(), multiplier: this.multipliers.get(e.assetKey.toLowerCase()) ?? null, unavailable: false })) };
  }
  async balanceOf(owner: string, assetKey: string): Promise<{ balanceRaw: RawAmount; blockNumber: string }> {
    this.blockNumber += 1n;
    return { balanceRaw: this.get(owner, assetKey).toString(), blockNumber: this.blockNumber.toString() };
  }
}
