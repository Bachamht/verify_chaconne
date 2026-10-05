/**
 * 发送器：白名单复核 → estimateGas（失败 = 会回退，解码后不广播）→ ×1.3 → 费用上限（fees.ts）→ 本地签名（拿到 rawTx / rawTxHash / nonce，
 * 供「发送提交点」上报）→ 由调用方在服务端同意后再 broadcast。签名与广播分两步，是防重复成交的关键。
 */
import type { Hex, LocalAccount } from "viem";
import type { ChainIO } from "./chain";
import { rawTxHash } from "./chain";
import { assertTxAllowed, ExecTxError, type TxContext, type TxPolicy } from "./allowlist";
import { SerialNonceManager } from "./nonce";
import { decodeRevertError, isNonceError } from "./revert";
import type { UnsignedTx } from "./txBuild";
import { assertFeeCaps, DEFAULT_FEE_CAPS, type FeeCaps } from "./fees";
import type { RevertClassification } from "@chaconne/core/verify";

export class WouldRevertError extends ExecTxError {
  constructor(readonly revert: RevertClassification & { message: string }) {
    super("would_revert", `transaction would revert: ${revert.error ?? "unknown"} (${revert.cls})`);
  }
}

export interface SignedTx {
  kind: "execute_step" | "permit" | "approve";
  rawTx: Hex;
  rawTxHash: Hex;
  nonce: number;
  gas: bigint;
  /** gas × maxFeePerGas（legacy：gasPrice）：这笔交易最多可能花的 OKB wei（服务端在发送提交点按它预留费用预算） */
  maxFeeWei: bigint;
}

export class ExecSender {
  readonly nonces: SerialNonceManager;
  constructor(
    readonly account: LocalAccount,
    readonly chain: ChainIO,
    readonly policy: TxPolicy,
    opts: { gasMultiplierPct?: number; feeCaps?: FeeCaps } = {},
  ) {
    this.nonces = new SerialNonceManager({ pendingNonce: () => chain.pendingNonce(account.address) });
    this.gasPct = BigInt(opts.gasMultiplierPct ?? 130);
    this.feeCaps = opts.feeCaps ?? { ...DEFAULT_FEE_CAPS };
  }
  private readonly gasPct: bigint;
  readonly feeCaps: FeeCaps;

  get address(): Hex {
    return this.account.address;
  }

  /** 白名单 + 预估；失败抛 ExecTxError / WouldRevertError（不消耗 nonce） */
  async preflight(tx: UnsignedTx, ctx: TxContext = {}): Promise<{ kind: SignedTx["kind"]; gas: bigint }> {
    const kind = assertTxAllowed(tx, this.policy, ctx);
    try {
      const est = await this.chain.estimateGas({ from: this.account.address, to: tx.to, data: tx.data, value: tx.value });
      return { kind, gas: (est * this.gasPct) / 100n };
    } catch (e) {
      throw new WouldRevertError(decodeRevertError(e));
    }
  }

  /** 预检通过、费用在上限内后本地签名（不广播）；费用超上限 → ExecTxError("fee_cap_exceeded")，不取 nonce */
  async sign(tx: UnsignedTx, ctx: TxContext = {}): Promise<SignedTx> {
    const { kind, gas } = await this.preflight(tx, ctx);
    const fees = await this.chain.fees();
    const maxFeeWei = assertFeeCaps(gas, fees, this.feeCaps);
    const nonce = await this.nonces.take();
    const base = { to: tx.to, data: tx.data, value: 0n, gas, nonce, chainId: this.chain.chainId };
    const rawTx = await this.account.signTransaction("gasPrice" in fees ? { ...base, gasPrice: fees.gasPrice, type: "legacy" } : { ...base, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, type: "eip1559" });
    return { kind, rawTx, rawTxHash: rawTxHash(rawTx), nonce, gas, maxFeeWei };
  }

  /** 服务端拒绝发送提交点 → 退回 nonce（没广播） */
  abandon(signed: SignedTx): void {
    this.nonces.release(signed.nonce);
  }

  /** 广播；「nonce too low / already known」→ 按哈希查：已在链上即视为成功，否则重同步后抛错 */
  async broadcast(signed: SignedTx): Promise<Hex> {
    try {
      return await this.chain.sendRawTransaction(signed.rawTx);
    } catch (e) {
      if (isNonceError(e)) {
        if (await this.chain.hasTransaction(signed.rawTxHash).catch(() => false)) return signed.rawTxHash;
        await this.nonces.sync();
      }
      throw e;
    }
  }
}
