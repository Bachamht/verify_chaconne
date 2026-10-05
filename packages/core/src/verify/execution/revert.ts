/**
 * 失败分类（v7 §2.5 失败分类表）：PlanGuard ABI 的全部自定义错误 + OZ v5 ERC20InsufficientAllowance / ERC20InsufficientBalance
 * + Error(string) + Panic(uint256)。选择器 = keccak256(签名) 前 4 字节，在本文件里由签名现算（测试断言 ABI 每个 error 都有显式归类）。
 *
 * | 类              | 处理                                                    |
 * |-----------------|---------------------------------------------------------|
 * | retry_new_cert  | 自动重签一次 → 再失败开 execution_failed 轮次                |
 * | wait_clock      | 时钟偏差：等 10 s 再预检，不重签；三次仍失败 → integrity_alert |
 * | replan          | 不重签；execution_failed 轮次（附 received / minOut）        |
 * | liquidity       | 退避 60 s；execution_failed 轮次                          |
 * | chain_ahead     | 跑链上回填；不重试                                         |
 * | scope           | 服务侧核验漏网 = 缺陷：integrity_alert + 轮次                 |
 * | terminal        | 停止该授权；交给撤销流程                                    |
 * | allowance / balance | needsOwner allowance_low / balance_low；不重试          |
 * | paused          | needs_operator contract_paused                           |
 * | bug             | 停止该授权签发；integrity_alert；告警运营者                    |
 * | unknown         | 不重试；轮次 + 告警                                         |
 */
import { keccak256Utf8 } from "../canonical";
import type { Hex, RevertClass } from "../contracts";

/** 错误签名 → 类别。PlanGuard 的每个 error 都必须在这里（未列出的视为缺陷，测试会失败） */
export const REVERT_ERROR_CLASSES: Readonly<Record<string, RevertClass>> = {
  // PlanGuard v2（abi/ChaconneVerifyPlanGuard.json）
  "CertificateExpired()": "retry_new_cert",
  "StepExpired()": "retry_new_cert",
  "CertificateNotYetValid()": "wait_clock",
  "InsufficientOutput(uint256,uint256)": "replan",
  "RecipientShortfall()": "replan",
  "RouterCallFailed(bytes)": "liquidity",
  "StepOutOfOrder(uint32,uint32)": "chain_ahead",
  "StepsExhausted()": "scope",
  "BudgetExceeded()": "scope",
  "PerStepCapExceeded()": "scope",
  "OutputNotInSet()": "scope",
  "MandateExpired()": "scope",
  "MandateNotYetValid()": "scope",
  "MandateRevokedError()": "terminal",
  "MandateNonceAlreadyUsed()": "terminal",
  "EnforcedPause()": "paused",
  "InputTransferShortfall()": "bug",
  "InputTransferExcess()": "bug",
  "OverSpent()": "bug",
  "CalldataMismatch()": "bug",
  "CertificateBindingMismatch()": "bug",
  "CertificateOutlivesStep()": "bug",
  "CertificateStepMismatch()": "bug",
  "CertificateTtlTooLong()": "bug",
  "EpochDisabled()": "bug",
  "ExpectedPause()": "bug",
  "InvalidCertificateSignature()": "bug",
  "InvalidMandateSignature()": "bug",
  "InvalidShortString()": "bug",
  "NonZeroValue()": "bug",
  "NotMandateOwner()": "bug",
  "OutputSetMismatch()": "bug",
  "OutputSetNotSorted()": "bug",
  "OwnableInvalidOwner(address)": "bug",
  "OwnableUnauthorizedAccount(address)": "bug",
  "PolicyDisabled()": "bug",
  "ReentrancyGuardReentrantCall()": "bug",
  "RegistryDisabled()": "bug",
  "RouteNotAllowed()": "bug",
  "SafeERC20FailedOperation(address)": "bug",
  "SameToken()": "bug",
  "SelectorNotAllowed()": "bug",
  "StepMandateMismatch()": "bug",
  "StringTooLong(string)": "bug",
  "TokenNotAllowed()": "bug",
  "ZeroAddress()": "bug",
  "ZeroAmount()": "bug",
  // OZ v5 ERC20（代币直接回退时冒泡）
  "ERC20InsufficientAllowance(address,uint256,uint256)": "allowance",
  "ERC20InsufficientBalance(address,uint256,uint256)": "balance",
  // 通用
  "Panic(uint256)": "bug",
};
const ERROR_STRING_SIG = "Error(string)";

export const errorSelector = (signature: string): Hex => keccak256Utf8(signature).slice(0, 10) as Hex;
const BY_SELECTOR = new Map<string, { signature: string; cls: RevertClass }>(Object.entries(REVERT_ERROR_CLASSES).map(([sig, cls]) => [errorSelector(sig), { signature: sig, cls }]));
const ERROR_STRING_SELECTOR = errorSelector(ERROR_STRING_SIG);
const NAMES = new Map<string, { signature: string; cls: RevertClass }>(Object.entries(REVERT_ERROR_CLASSES).map(([sig, cls]) => [sig.slice(0, sig.indexOf("(")), { signature: sig, cls }]));

/** 预检（本地 / 链上读取）得出的失败，与链上 revert 同一套类别 */
export type PreflightFailure = "cert_remaining_low" | "quote_too_old" | "allowance_low" | "balance_low" | "step_index_mismatch" | "mandate_revoked";
const PREFLIGHT: Record<PreflightFailure, RevertClass> = { cert_remaining_low: "retry_new_cert", quote_too_old: "retry_new_cert", allowance_low: "allowance", balance_low: "balance", step_index_mismatch: "chain_ahead", mandate_revoked: "terminal" };

export interface RevertClassification {
  cls: RevertClass;
  /** 错误名（如 "CertificateExpired"）或预检码；解不出 = null */
  error: string | null;
  /** Error(string) 的文案（截断） */
  reason?: string;
}

function classifyErrorString(s: string): RevertClass {
  const t = s.toLowerCase();
  if (/allowance/.test(t)) return "allowance";
  if (/balance/.test(t)) return "balance";
  if (/paused/.test(t)) return "paused";
  return "unknown";
}

function decodeErrorString(data: string): string | null {
  // Error(string)：selector ‖ offset ‖ length ‖ bytes
  const h = data.slice(10);
  if (h.length < 128) return null;
  const len = Number(BigInt(`0x${h.slice(64, 128)}`));
  const hex = h.slice(128, 128 + len * 2);
  if (hex.length !== len * 2) return null;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * 输入任选：revert data（优先）、错误名、RPC / viem 的错误文案（从中找已知错误名或 Error(string) 文案）、预检码。
 */
export function classifyRevert(input: { data?: Hex | string | null; errorName?: string | null; message?: string | null; preflight?: PreflightFailure | null }): RevertClassification {
  if (input.preflight) return { cls: PREFLIGHT[input.preflight], error: input.preflight };
  const data = typeof input.data === "string" && /^0x[0-9a-fA-F]{8}/.test(input.data) ? input.data.toLowerCase() : null;
  if (data) {
    const sel = data.slice(0, 10);
    const hit = BY_SELECTOR.get(sel);
    if (hit) return { cls: hit.cls, error: hit.signature.slice(0, hit.signature.indexOf("(")) };
    if (sel === ERROR_STRING_SELECTOR) {
      const reason = decodeErrorString(data);
      if (reason !== null) return { cls: classifyErrorString(reason), error: "Error", reason: reason.slice(0, 200) };
    }
  }
  if (input.errorName) {
    const hit = NAMES.get(input.errorName);
    if (hit) return { cls: hit.cls, error: input.errorName };
  }
  if (input.message) {
    const m = input.message;
    for (const [name, hit] of NAMES) if (new RegExp(`\\b${name}\\b`).test(m)) return { cls: hit.cls, error: name };
    const reason = /reverted with (?:the following )?reason:?\s*([^\n]+)/i.exec(m)?.[1] ?? /execution reverted:?\s*([^\n]+)/i.exec(m)?.[1] ?? null;
    if (reason) {
      const cls = classifyErrorString(reason);
      if (cls !== "unknown") return { cls, error: "Error", reason: reason.trim().slice(0, 200) };
    }
  }
  return { cls: "unknown", error: null };
}
