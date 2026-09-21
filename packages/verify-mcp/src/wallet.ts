/**
 * agent-wallet 模式（CV-D08）：**用户自己的 Agent 钱包**，只在客户端进程里；不是服务密钥。
 * 三个变量必须同时给：AGENT_WALLET_PRIVATE_KEY / AGENT_WALLET_MAX_SPEND_USD / AGENT_WALLET_CHAIN_IDS；缺一即拒绝启用。
 * 启用后：x402 自动付款（累计额度硬上限）、可代签 TradeMandate、可发送 executeStep 交易（仅允许的链）。
 * 本模块从不打印私钥；错误信息里只出现地址。
 */
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createX402Payer, type X402Challenge, type X402Payer } from "@chaconne/verify-sdk";
import { PLAN_GUARD_ABI, toCertArg, toMandateArg, toStepArg } from "./planGuardAbi";

export interface AgentWalletConfig {
  privateKey: Hex;
  maxSpendUsd: string;
  chainIds: number[];
  rpcUrl: string;
}

export class AgentWalletError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const USD6 = 1_000_000n;
function usdToMicros(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new AgentWalletError("invalid_amount", `bad USD amount: ${s}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * USD6 + BigInt((f + "000000").slice(0, 6));
}
function microsToUsd(v: bigint): string {
  const frac = (v % USD6).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${v / USD6}.${frac}` : `${v / USD6}`;
}

/** 从环境读取配置；三项都缺 → null（模式关闭）；部分缺 → 抛错（防止半配置） */
export function agentWalletConfigFromEnv(env: NodeJS.ProcessEnv): AgentWalletConfig | null {
  const pk = env["AGENT_WALLET_PRIVATE_KEY"];
  const max = env["AGENT_WALLET_MAX_SPEND_USD"];
  const chains = env["AGENT_WALLET_CHAIN_IDS"];
  if (!pk && !max && !chains) return null;
  if (!pk || !max || !chains) throw new AgentWalletError("agent_wallet_partial_config", "agent-wallet mode needs AGENT_WALLET_PRIVATE_KEY, AGENT_WALLET_MAX_SPEND_USD and AGENT_WALLET_CHAIN_IDS together");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new AgentWalletError("agent_wallet_bad_key", "AGENT_WALLET_PRIVATE_KEY must be 0x + 64 hex");
  usdToMicros(max);
  const chainIds = chains.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (chainIds.length === 0) throw new AgentWalletError("agent_wallet_bad_chains", "AGENT_WALLET_CHAIN_IDS must be a csv of chain ids");
  return { privateKey: pk as Hex, maxSpendUsd: max, chainIds, rpcUrl: env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech" };
}

export interface StepTxArgs {
  chainId: number;
  planGuard: Hex;
  mandate: Record<string, string>;
  mandateSignature: Hex;
  outputSet: Hex[];
  step: Record<string, string>;
  certificate: Record<string, string>;
  certificateSignature: Hex;
  routerCalldata: Hex;
}
export interface StepTxResult {
  txHash: Hex;
  gas?: string;
  approveTxHash?: Hex | null;
  receipt?: { status: string; blockNumber: string; gasUsed: string; event: Record<string, unknown> | null; allowanceAfter: string } | null;
}
export type SendStepTx = (args: StepTxArgs, wallet: AgentWallet) => Promise<StepTxResult>;
/** 预授权发送器（可注入以便测试）：owner=agent 钱包时把 owner→PlanGuard 的授权提高到 amount */
export type SendApproveTx = (args: { chainId: number; token: Hex; spender: Hex; amount: bigint }, wallet: AgentWallet) => Promise<Hex>;
/** 链上读取（可注入以便测试）：mandateState.steps 与 owner→PlanGuard 授权额 */
export interface ChainReader {
  mandateSteps(chainId: number, planGuard: Hex, digest: Hex): Promise<{ steps: number; spent: string; revoked: boolean }>;
  allowance(chainId: number, token: Hex, owner: Hex, spender: Hex): Promise<bigint>;
}

export class AgentWallet {
  readonly account: PrivateKeyAccount;
  readonly address: Hex;
  readonly chainIds: number[];
  readonly payer: X402Payer;
  private spentMicros = 0n;
  private readonly maxMicros: bigint;
  readonly payments: X402Challenge[] = [];

  constructor(
    readonly cfg: AgentWalletConfig,
    private readonly sender: SendStepTx = defaultSendStepTx,
    readonly reader: ChainReader = defaultChainReader(cfg.rpcUrl),
    private readonly approver: SendApproveTx = defaultSendApproveTx,
  ) {
    this.account = privateKeyToAccount(cfg.privateKey);
    this.address = this.account.address;
    this.chainIds = cfg.chainIds;
    this.maxMicros = usdToMicros(cfg.maxSpendUsd);
    this.payer = createX402Payer({
      signer: this.account,
      networks: cfg.chainIds.map((id) => `eip155:${id}`),
      onBeforePayment: (c) => this.reserve(c.amountUsdEstimate),
      onPayment: (c) => this.payments.push(c),
    });
  }

  get spentUsd(): string {
    return microsToUsd(this.spentMicros);
  }
  get remainingUsd(): string {
    return microsToUsd(this.maxMicros - this.spentMicros);
  }
  /** 额度预留：超过 MAX_SPEND 拒绝（返回 false），否则累计 */
  reserve(amountUsd: string): boolean {
    const v = usdToMicros(amountUsd);
    if (this.spentMicros + v > this.maxMicros) return false;
    this.spentMicros += v;
    return true;
  }
  allowsChain(chainId: number): boolean {
    return this.chainIds.includes(chainId);
  }
  signTypedData(td: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex> {
    return this.account.signTypedData(td as never);
  }
  async sendStep(args: StepTxArgs): Promise<StepTxResult> {
    if (!this.allowsChain(args.chainId)) throw new AgentWalletError("chain_not_allowed", `chain ${args.chainId} not in AGENT_WALLET_CHAIN_IDS`);
    return this.sender(args, this);
  }
  /**
   * 预授权（在 prepare-step **之前**调用）：步骤证书只有 ~30 s，approve 若放在 prepare 之后会把证书耗到过期。
   * 只在 agent 钱包 = owner 时发 approve；第三方执行者只能检查 owner 现有授权。返回 approve tx（未发则 null）。
   */
  async ensureAllowance(a: { chainId: number; token: Hex; owner: Hex; spender: Hex; minAmount: bigint }): Promise<{ approveTxHash: Hex | null; allowance: bigint }> {
    if (!this.allowsChain(a.chainId)) throw new AgentWalletError("chain_not_allowed", `chain ${a.chainId} not in AGENT_WALLET_CHAIN_IDS`);
    const current = await this.reader.allowance(a.chainId, a.token, a.owner, a.spender);
    if (current >= a.minAmount) return { approveTxHash: null, allowance: current };
    if (a.owner.toLowerCase() !== this.address.toLowerCase()) throw new AgentWalletError("owner_allowance_insufficient", `mandate owner ${a.owner} has approved ${current} < ${a.minAmount} to PlanGuard; a third-party executor cannot approve on the owner's behalf`);
    const approveTxHash = await this.approver({ chainId: a.chainId, token: a.token, spender: a.spender, amount: a.minAmount }, this);
    return { approveTxHash, allowance: await this.reader.allowance(a.chainId, a.token, a.owner, a.spender) };
  }
  /** 授权钱包客户端（默认发送器与测试共用） */
  clients(chainId: number) {
    const chain = { id: chainId, name: `eip155:${chainId}`, nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [this.cfg.rpcUrl] } } } as const;
    return { pub: createPublicClient({ chain, transport: http(this.cfg.rpcUrl) }), wc: createWalletClient({ account: this.account, chain, transport: http(this.cfg.rpcUrl) }) };
  }
  summary() {
    return { address: this.address, chainIds: this.chainIds, maxSpendUsd: this.cfg.maxSpendUsd, spentUsd: this.spentUsd, remainingUsd: this.remainingUsd, payments: this.payments.length };
  }
}

export function defaultChainReader(rpcUrl: string): ChainReader {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  return {
    async mandateSteps(_chainId, planGuard, digest) {
      const [spent, steps, revoked] = await pub.readContract({ address: planGuard, abi: PLAN_GUARD_ABI, functionName: "mandateState", args: [digest] });
      return { steps: Number(steps), spent: spent.toString(), revoked };
    },
    allowance: (_chainId, token, owner, spender) => pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }),
  };
}

/**
 * 默认发送器（I2 执行者规则）：
 *  1. 输入代币授权：合约从 m.owner 拉款 → 若 agent 钱包 = owner，先精确 approve(PlanGuard, amountIn)（已相等则跳过）；
 *     若 agent 钱包 ≠ owner，只检查 owner 现有授权 ≥ amountIn，不足则拒绝（第三方执行者无法替 owner 授权）。
 *  2. estimateGas ×1.3（失败 = 合约会 revert，不广播）→ 发 executeStep。
 *  3. 等回执（≤120 s）：解码 MandateStep 事件；检查 owner→PlanGuard 授权已归零。
 */
export const defaultSendStepTx: SendStepTx = async (a, w) => {
  const { pub, wc } = w.clients(a.chainId);
  const owner = a.mandate["owner"]!.toLowerCase() as Hex;
  const inputToken = a.mandate["inputToken"] as Hex;
  const amountIn = BigInt(a.step["amountIn"]!);
  let approveTxHash: Hex | null = null;
  const current = await w.reader.allowance(a.chainId, inputToken, owner, a.planGuard);
  if (owner === w.address.toLowerCase()) {
    // 正常情况下 ensureAllowance 已在 prepare-step 之前授权到位；这里只兜底补足（避免在证书窗口内多发一笔）
    if (current < amountIn) {
      approveTxHash = await wc.sendTransaction({ to: inputToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.planGuard, amountIn] }), value: 0n });
      await pub.waitForTransactionReceipt({ hash: approveTxHash, timeout: 120_000 });
    }
  } else if (current < amountIn) {
    throw new AgentWalletError("owner_allowance_insufficient", `mandate owner ${owner} has approved ${current} < amountIn ${amountIn} to PlanGuard; a third-party executor cannot approve on the owner's behalf`);
  }
  const data = encodeFunctionData({ abi: PLAN_GUARD_ABI, functionName: "executeStep", args: [toMandateArg(a.mandate), a.mandateSignature, a.outputSet, toStepArg(a.step), toCertArg(a.certificate), a.certificateSignature, a.routerCalldata] });
  let gas: bigint;
  try {
    gas = ((await pub.estimateGas({ account: w.account, to: a.planGuard, data, value: 0n })) * 13n) / 10n;
  } catch (e) {
    throw new AgentWalletError("execute_would_revert", `executeStep would revert: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
  }
  const txHash = await wc.sendTransaction({ to: a.planGuard, data, value: 0n, gas });
  let receipt: StepTxResult["receipt"] = null;
  try {
    const rcpt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    let event: Record<string, unknown> | null = null;
    for (const l of rcpt.logs) {
      try {
        const dec = decodeEventLog({ abi: PLAN_GUARD_ABI, data: l.data, topics: l.topics });
        if (dec.eventName === "MandateStep") event = Object.fromEntries(Object.entries(dec.args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
      } catch {
        /* other logs */
      }
    }
    const allowanceAfter = await w.reader.allowance(a.chainId, inputToken, owner, a.planGuard);
    receipt = { status: rcpt.status, blockNumber: rcpt.blockNumber.toString(), gasUsed: rcpt.gasUsed.toString(), event, allowanceAfter: allowanceAfter.toString() };
  } catch {
    receipt = null; // 回执超时：交由服务端核实器；tx hash 已提交
  }
  return { txHash, gas: gas.toString(), approveTxHash, receipt };
};

/** 默认预授权发送器：真实链上 approve(spender, amount) 并等回执 */
export const defaultSendApproveTx: SendApproveTx = async (a, w) => {
  const { pub, wc } = w.clients(a.chainId);
  const hash = await wc.sendTransaction({ to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.spender, a.amount] }), value: 0n });
  await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return hash;
};
