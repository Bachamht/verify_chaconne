/**
 * 交易构建：executeStep / permit / approve。只构建 {to, data, value}，发送前一律经 allowlist.ts 复核。
 */
import { encodeFunctionData, parseSignature, toFunctionSelector, type AbiFunction, type Hex } from "viem";
import { PLANGUARD_ABI, TOKEN_ABI, toCertArg, toMandateArg, toStepArg } from "./abi";

export interface UnsignedTx {
  to: Hex;
  data: Hex;
  value: bigint;
}

const EXECUTE_STEP_ITEM = PLANGUARD_ABI.find((x): x is AbiFunction => x.type === "function" && x.name === "executeStep");
if (!EXECUTE_STEP_ITEM) throw new Error("PlanGuard ABI 缺少 executeStep");
/** 由 ABI 现算（不手写） */
export const EXECUTE_STEP_SELECTOR: Hex = toFunctionSelector(EXECUTE_STEP_ITEM);

export interface ExecuteStepArgs {
  planGuard: Hex;
  mandate: Record<string, string>;
  mandateSignature: Hex;
  outputSet: Hex[];
  step: Record<string, string>;
  certificate: Record<string, string>;
  certificateSignature: Hex;
  routerCalldata: Hex;
}

export function buildExecuteStepTx(a: ExecuteStepArgs): UnsignedTx {
  const data = encodeFunctionData({ abi: PLANGUARD_ABI, functionName: "executeStep", args: [toMandateArg(a.mandate), a.mandateSignature, a.outputSet, toStepArg(a.step), toCertArg(a.certificate), a.certificateSignature, a.routerCalldata] });
  return { to: a.planGuard, data, value: 0n };
}

/** permit(owner, spender, value, deadline, v, r, s)：owner 的 65 字节签名拆成 v / r / s */
export function buildPermitTx(a: { token: Hex; owner: Hex; spender: Hex; value: bigint; deadline: bigint; signature: Hex }): UnsignedTx {
  const { v, r, s, yParity } = parseSignature(a.signature);
  const vv = v !== undefined ? Number(v) : 27 + (yParity ?? 0);
  const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "permit", args: [a.owner, a.spender, a.value, a.deadline, vv, r, s] });
  return { to: a.token, data, value: 0n };
}

export function buildApproveTx(a: { token: Hex; spender: Hex; amount: bigint }): UnsignedTx {
  return { to: a.token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [a.spender, a.amount] }), value: 0n };
}
