/**
 * 按调用方配置的交易白名单（v7 §1.2 第 3 条，X-17）——签名前强制，违者抛 ExecTxError，绝不签、绝不发：
 *   hosted（平台执行身份）：to == PlanGuard ∧ selector == executeStep；
 *                          或 to ∈ 登记表代币 ∧ selector == permit(0xd505accf)，解码后 owner == 作业 owner、spender == PlanGuard；
 *   agent_wallet（用户自己的 MCP Agent 钱包，沿用现有行为）：executeStep；或 approve(PlanGuard, …)。
 *   两者 value 必须为 0。执行身份不能 approve、不能转账、不能调任何其它合约（防止被当作通用 relayer）。
 */
import { decodeFunctionData, type Hex } from "viem";
import { decodePermitCalldata, PERMIT_SELECTOR } from "@chaconne/core/verify";
import { TOKEN_ABI, APPROVE_SELECTOR } from "./abi";
import { EXECUTE_STEP_SELECTOR, type UnsignedTx } from "./txBuild";

export class ExecTxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TxPolicy =
  | { profile: "hosted"; planGuard: Hex; tokens: ReadonlySet<string> }
  | { profile: "agent_wallet"; planGuard: Hex };

export interface TxContext {
  /** hosted permit：作业 owner（解码出的 owner 必须相等） */
  jobOwner?: Hex | null;
}

const lc = (s: string) => s.toLowerCase();

export function assertTxAllowed(tx: UnsignedTx, policy: TxPolicy, ctx: TxContext = {}): "execute_step" | "permit" | "approve" {
  if (tx.value !== 0n) throw new ExecTxError("tx_value_not_zero", "value must be 0");
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new ExecTxError("tx_to_invalid", "bad to address");
  const sel = lc(tx.data.slice(0, 10));
  const to = lc(tx.to);
  const pg = lc(policy.planGuard);
  if (to === pg) {
    if (sel === lc(EXECUTE_STEP_SELECTOR)) return "execute_step";
    throw new ExecTxError("tx_selector_not_allowed", `selector ${sel} on PlanGuard is not allowed`);
  }
  if (policy.profile === "hosted") {
    if (!policy.tokens.has(to)) throw new ExecTxError("tx_to_not_allowed", `to ${to} is neither PlanGuard nor a registry token`);
    if (sel !== PERMIT_SELECTOR) throw new ExecTxError("tx_selector_not_allowed", `selector ${sel} on token is not allowed (only permit)`);
    const d = decodePermitCalldata(tx.data);
    if (!d) throw new ExecTxError("permit_calldata_invalid", "permit calldata does not decode");
    if (lc(d.spender) !== pg) throw new ExecTxError("permit_spender_not_planguard", `permit spender ${d.spender} is not PlanGuard`);
    if (!ctx.jobOwner || lc(d.owner) !== lc(ctx.jobOwner)) throw new ExecTxError("permit_owner_mismatch", `permit owner ${d.owner} is not the job owner`);
    return "permit";
  }
  // agent_wallet：approve(PlanGuard, …)
  if (sel !== APPROVE_SELECTOR) throw new ExecTxError("tx_selector_not_allowed", `selector ${sel} is not allowed in agent-wallet mode`);
  const d = decodeFunctionData({ abi: TOKEN_ABI, data: tx.data });
  if (d.functionName !== "approve" || lc((d.args as readonly [Hex, bigint])[0]) !== pg) throw new ExecTxError("approve_spender_not_planguard", "approve spender must be PlanGuard");
  return "approve";
}
