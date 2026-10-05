/** v7 Lane X · X1 执行纯函数：X-08 作业状态机、reconcileStep 全分支、签发闸门五条、回执归因（X-21 核心）、X-11 失败分类覆盖 ABI */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi, toFunctionSelector, type Hex } from "viem";
import {
  attributeStepEvent,
  canTransitionJob,
  classifyRevert,
  errorSelector,
  EXECUTION_JOB_STATES,
  isTerminalJobState,
  issuanceGate,
  reconcileStep,
  REVERT_CLASSES,
  REVERT_ERROR_CLASSES,
  sendCommitCheck,
  stepRowExpirable,
  sweepUnsentJob,
  type ExecutionJobState,
} from "../src/verify";

const LEGAL: Array<[ExecutionJobState, ExecutionJobState]> = [
  ["QUEUED", "CLAIMED"], ["QUEUED", "EXPIRED"], ["QUEUED", "CANCELLED"],
  ["CLAIMED", "QUEUED"], ["CLAIMED", "SENDING"], ["CLAIMED", "FAILED"], ["CLAIMED", "EXPIRED"], ["CLAIMED", "CANCELLED"],
  ["SENDING", "SENT"], ["SENDING", "CONFIRMED"], ["SENDING", "REVERTED"], ["SENDING", "EXPIRED"], ["SENDING", "FAILED"],
  ["SENT", "CONFIRMED"], ["SENT", "REVERTED"], ["SENT", "EXPIRED"], ["SENT", "FAILED"],
];

describe("X-08 作业状态机：只有表内转移合法，其余全部拒绝", () => {
  it("穷举 9×9", () => {
    let legal = 0;
    for (const from of EXECUTION_JOB_STATES) for (const to of EXECUTION_JOB_STATES) {
      const want = LEGAL.some(([f, t]) => f === from && t === to);
      expect(canTransitionJob(from, to), `${from} → ${to}`).toBe(want);
      if (want) legal += 1;
    }
    expect(legal).toBe(LEGAL.length);
    expect(canTransitionJob("QUEUED", "SENDING")).toBe(false); // 不能跳过领取
    expect(canTransitionJob("SENT", "QUEUED")).toBe(false); // 广播后绝不回队
    expect(canTransitionJob("NOPE", "QUEUED")).toBe(false);
    for (const s of ["CONFIRMED", "REVERTED", "EXPIRED", "FAILED", "CANCELLED"]) expect(isTerminalJobState(s)).toBe(true);
    expect(isTerminalJobState("SENT")).toBe(false);
  });
  it("发送提交点：暂停 / 步骤不活 / 非本作业取走 → CANCELLED；证书剩余 < 8 s → EXPIRED；旧 attempt → 409 不改状态", () => {
    const base = { jobState: "CLAIMED", attemptMatches: true, taskPaused: false, stepLive: true, pulledByJob: true, signedValidUntilSec: 1000, nowSec: 980, minRemainingS: 8 };
    expect(sendCommitCheck(base)).toEqual({ ok: true });
    expect(sendCommitCheck({ ...base, taskPaused: true })).toMatchObject({ ok: false, code: "task_paused", terminal: "CANCELLED" });
    expect(sendCommitCheck({ ...base, stepLive: false })).toMatchObject({ terminal: "CANCELLED" });
    expect(sendCommitCheck({ ...base, pulledByJob: false })).toMatchObject({ terminal: "CANCELLED" });
    expect(sendCommitCheck({ ...base, nowSec: 993 })).toMatchObject({ code: "cert_remaining_low", terminal: "EXPIRED" });
    expect(sendCommitCheck({ ...base, nowSec: 992 })).toEqual({ ok: true });
    expect(sendCommitCheck({ ...base, attemptMatches: false })).toMatchObject({ code: "stale_attempt", terminal: null });
    expect(sendCommitCheck({ ...base, jobState: "SENDING" })).toMatchObject({ code: "job_not_claimed", terminal: null });
  });
  it("清扫器：QUEUED 证书剩余 < 20 s → EXPIRED；租约过期回队或过期；permit 用 120 s", () => {
    expect(sweepUnsentJob({ kind: "execute_step", state: "QUEUED", leaseUntilSec: null, validUntilSec: 1000, nowSec: 981 })).toBe("EXPIRED");
    expect(sweepUnsentJob({ kind: "execute_step", state: "QUEUED", leaseUntilSec: null, validUntilSec: 1000, nowSec: 980 })).toBeNull();
    expect(sweepUnsentJob({ kind: "execute_step", state: "CLAIMED", leaseUntilSec: 900, validUntilSec: 1000, nowSec: 950 })).toBe("QUEUED");
    expect(sweepUnsentJob({ kind: "execute_step", state: "CLAIMED", leaseUntilSec: 900, validUntilSec: 1000, nowSec: 990 })).toBe("EXPIRED");
    expect(sweepUnsentJob({ kind: "execute_step", state: "CLAIMED", leaseUntilSec: 999, validUntilSec: 1000, nowSec: 950 })).toBeNull();
    expect(sweepUnsentJob({ kind: "permit", state: "QUEUED", leaseUntilSec: null, validUntilSec: 1000, nowSec: 881 })).toBe("EXPIRED");
    expect(sweepUnsentJob({ kind: "execute_step", state: "SENT", leaseUntilSec: 1, validUntilSec: 1, nowSec: 5000 })).toBeNull();
  });
});

describe("reconcileStep 全分支（表驱动）", () => {
  const base = { stepIndex: 2, signedValidUntil: 1000, chainHeadTs: 900, chainSteps: 2, receipt: null };
  const cases: Array<[string, Partial<Parameters<typeof reconcileStep>[0]>, string]> = [
    ["回执成功且确认足 → CONFIRMED_BY_RECEIPT", { receipt: { status: "success", confirmations: 6 } }, "CONFIRMED_BY_RECEIPT"],
    ["回执成功确认不足 → WAIT", { receipt: { status: "success", confirmations: 5 } }, "WAIT"],
    ["回执成功优先于链上超前", { receipt: { status: "success", confirmations: 1 }, chainSteps: 3 }, "WAIT"],
    ["回执 reverted → REVERTED", { receipt: { status: "reverted", confirmations: 9 } }, "REVERTED"],
    ["链上步序超前 → EXECUTED_ELSEWHERE", { chainSteps: 3 }, "EXECUTED_ELSEWHERE"],
    ["链上超前优先于过期", { chainSteps: 3, chainHeadTs: 5000 }, "EXECUTED_ELSEWHERE"],
    ["链头时间 > validUntil + 15 → EXPIRED", { chainHeadTs: 1016 }, "EXPIRED"],
    ["恰在边界 → WAIT", { chainHeadTs: 1015 }, "WAIT"],
    ["其它 → WAIT", {}, "WAIT"],
    ["自定义确认数与 margin", { receipt: { status: "success", confirmations: 2 }, confirmationsRequired: 2 }, "CONFIRMED_BY_RECEIPT"],
    ["自定义 margin 0", { chainHeadTs: 1001, marginS: 0 }, "EXPIRED"],
  ];
  for (const [name, over, want] of cases) it(name, () => expect(reconcileStep({ ...base, ...over })).toBe(want));
});

describe("签发闸门五条 + 步骤行到期", () => {
  const row = (over: Partial<{ id: string; state: string; pulled: boolean; signedValidUntil: number }>) => ({ id: "s1", state: "PREPARED", pulled: false, signedValidUntil: 1000, ...over });
  it("1 链上超前 → 先回填", () => expect(issuanceGate({ chainSteps: 3, stepsDone: 2, rows: [], jobs: [], nowSec: 0, marginS: 15 })).toEqual({ action: "backfill" }));
  it("2 SUBMITTED / REORG_PENDING → STEP_AWAITING_CONFIRMATION", () => {
    expect(issuanceGate({ chainSteps: 2, stepsDone: 2, rows: [row({ state: "SUBMITTED", pulled: true })], jobs: [], nowSec: 5000, marginS: 15 })).toMatchObject({ action: "wait", code: "STEP_AWAITING_CONFIRMATION" });
    expect(issuanceGate({ chainSteps: null, stepsDone: 2, rows: [row({ state: "REORG_PENDING" })], jobs: [], nowSec: 5000, marginS: 15 })).toMatchObject({ code: "STEP_AWAITING_CONFIRMATION" });
  });
  it("3 任意状态被取走过且在窗口内 → EXECUTION_IN_FLIGHT，nextCheckAt = validUntil + margin", () => {
    expect(issuanceGate({ chainSteps: 2, stepsDone: 2, rows: [row({ state: "EXPIRED", pulled: true, signedValidUntil: 1000 })], jobs: [], nowSec: 1015, marginS: 15 })).toEqual({ action: "wait", code: "EXECUTION_IN_FLIGHT", nextCheckAtSec: 1015 });
    expect(issuanceGate({ chainSteps: 2, stepsDone: 2, rows: [row({ state: "SUPERSEDED", pulled: true, signedValidUntil: 1000 })], jobs: [], nowSec: 900, marginS: 15 })).toMatchObject({ code: "EXECUTION_IN_FLIGHT" });
  });
  it("4 作业 SENDING / SENT → EXECUTION_IN_FLIGHT", () => {
    expect(issuanceGate({ chainSteps: 2, stepsDone: 2, rows: [row({ pulled: true, signedValidUntil: 100 })], jobs: [{ state: "SENT" }], nowSec: 5000, marginS: 15 })).toMatchObject({ code: "EXECUTION_IN_FLIGHT", nextCheckAtSec: null });
  });
  it("5 否则：未取走的旧行删除，取走过的旧行标 SUPERSEDED，然后重签", () => {
    const d = issuanceGate({ chainSteps: 2, stepsDone: 2, rows: [row({ id: "a", state: "PREPARED", pulled: false }), row({ id: "b", state: "EXPIRED", pulled: true, signedValidUntil: 100 }), row({ id: "c", state: "SUPERSEDED", pulled: true, signedValidUntil: 50 }), row({ id: "d", state: "EXPIRED", pulled: false })], jobs: [{ state: "EXPIRED" }, { state: "CANCELLED" }], nowSec: 5000, marginS: 15 });
    expect(d).toEqual({ action: "issue", deleteIds: ["a", "d"], supersedeIds: ["b"] });
  });
  it("被取走过的行在 validUntil + margin 之后才能转 EXPIRED；有在途作业时不转", () => {
    expect(stepRowExpirable({ pulled: true, signedValidUntil: 1000, nowSec: 1010, marginS: 15, hasInflightJob: false })).toBe(false);
    expect(stepRowExpirable({ pulled: true, signedValidUntil: 1000, nowSec: 1016, marginS: 15, hasInflightJob: false })).toBe(true);
    expect(stepRowExpirable({ pulled: false, signedValidUntil: 1000, nowSec: 1001, marginS: 15, hasInflightJob: false })).toBe(true);
    expect(stepRowExpirable({ pulled: true, signedValidUntil: 1000, nowSec: 9999, marginS: 15, hasInflightJob: true })).toBe(false);
  });
});

describe("回执归因（同 index 新旧证书）", () => {
  const live = { id: "new", state: "PREPARED", evidenceHash: "0xaa", amountIn: "200", outputToken: "0xT1" };
  const old = { id: "old", state: "SUPERSEDED", evidenceHash: "0xbb", amountIn: "100", outputToken: "0xT2" };
  it("匹配活行 → live；匹配旧证书 → superseded（成交记旧意图名下）；都不匹配 → integrity_alert", () => {
    expect(attributeStepEvent({ evidenceHash: "0xAA", amountIn: "200", outputToken: "0xt1" }, live, [old])).toEqual({ kind: "live", id: "new" });
    expect(attributeStepEvent({ evidenceHash: "0xbb", amountIn: "100", outputToken: "0xT2" }, live, [old])).toEqual({ kind: "superseded", id: "old", liveId: "new" });
    expect(attributeStepEvent({ evidenceHash: "0xbb", amountIn: "101", outputToken: "0xT2" }, live, [old])).toEqual({ kind: "integrity_alert" });
    expect(attributeStepEvent({ evidenceHash: "0xbb", amountIn: "100", outputToken: "0xT2" }, null, [old])).toEqual({ kind: "superseded", id: "old", liveId: null });
  });
});

describe("X-11 失败分类：PlanGuard ABI 每个 error 都有显式归类", () => {
  const abiPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "verify-contracts", "abi", "ChaconneVerifyPlanGuard.json");
  const raw = JSON.parse(readFileSync(abiPath, "utf8")) as { abi?: unknown[] } | unknown[];
  const abi = (Array.isArray(raw) ? raw : raw.abi!) as Array<{ type: string; name: string; inputs?: Array<{ type: string; components?: unknown[] }> }>;
  const errors = abi.filter((x) => x.type === "error");
  it("ABI 有 error，且每个都在 REVERT_ERROR_CLASSES 里、选择器与 viem 一致、按 data 分类不为 unknown", () => {
    expect(errors.length).toBeGreaterThan(40);
    for (const e of errors) {
      const sig = `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`;
      expect(REVERT_ERROR_CLASSES[sig], sig).toBeDefined();
      expect(REVERT_CLASSES).toContain(REVERT_ERROR_CLASSES[sig]);
      expect(errorSelector(sig)).toBe(toFunctionSelector(`function ${sig}`));
      const c = classifyRevert({ data: errorSelector(sig) + "00".repeat(64) });
      expect(c.cls, sig).toBe(REVERT_ERROR_CLASSES[sig]);
      expect(c.error).toBe(e.name);
    }
  });
  it("表内各类代表", () => {
    const by = (name: string) => classifyRevert({ errorName: name }).cls;
    expect(by("CertificateExpired")).toBe("retry_new_cert");
    expect(by("StepExpired")).toBe("retry_new_cert");
    expect(by("CertificateNotYetValid")).toBe("wait_clock");
    expect(by("InsufficientOutput")).toBe("replan");
    expect(by("RecipientShortfall")).toBe("replan");
    expect(by("RouterCallFailed")).toBe("liquidity");
    expect(by("StepOutOfOrder")).toBe("chain_ahead");
    for (const n of ["StepsExhausted", "BudgetExceeded", "PerStepCapExceeded", "OutputNotInSet", "MandateExpired", "MandateNotYetValid"]) expect(by(n)).toBe("scope");
    expect(by("MandateRevokedError")).toBe("terminal");
    expect(by("MandateNonceAlreadyUsed")).toBe("terminal");
    expect(by("EnforcedPause")).toBe("paused");
    for (const n of ["InputTransferShortfall", "InputTransferExcess", "OverSpent", "InvalidCertificateSignature"]) expect(by(n)).toBe("bug");
    expect(classifyRevert({ preflight: "cert_remaining_low" }).cls).toBe("retry_new_cert");
    expect(classifyRevert({ preflight: "quote_too_old" }).cls).toBe("retry_new_cert");
    expect(classifyRevert({ preflight: "allowance_low" }).cls).toBe("allowance");
    expect(classifyRevert({ preflight: "balance_low" }).cls).toBe("balance");
  });
  it("OZ v5 ERC20 错误、Error(string) 额度 / 余额文案、Panic、viem 文案、解不出", () => {
    const oz = parseAbi(["error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)", "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)", "error Error(string)", "error Panic(uint256)", "error InsufficientOutput(uint256 received, uint256 minOut)"]);
    const A = "0x1111111111111111111111111111111111111111";
    expect(classifyRevert({ data: encodeErrorResult({ abi: oz, errorName: "ERC20InsufficientAllowance", args: [A, 1n, 2n] }) }).cls).toBe("allowance");
    expect(classifyRevert({ data: encodeErrorResult({ abi: oz, errorName: "ERC20InsufficientBalance", args: [A, 1n, 2n] }) }).cls).toBe("balance");
    expect(classifyRevert({ data: encodeErrorResult({ abi: oz, errorName: "Error", args: ["ERC20: transfer amount exceeds allowance"] }) })).toMatchObject({ cls: "allowance", error: "Error" });
    expect(classifyRevert({ data: encodeErrorResult({ abi: oz, errorName: "Error", args: ["ERC20: transfer amount exceeds balance"] }) }).cls).toBe("balance");
    expect(classifyRevert({ data: encodeErrorResult({ abi: oz, errorName: "Error", args: ["something else"] }) }).cls).toBe("unknown");
    expect(classifyRevert({ data: encodeErrorResult({ abi: oz, errorName: "Panic", args: [0x11n] }) }).cls).toBe("bug");
    expect(classifyRevert({ data: encodeErrorResult({ abi: oz, errorName: "InsufficientOutput", args: [1n, 2n] }) })).toMatchObject({ cls: "replan", error: "InsufficientOutput" });
    expect(classifyRevert({ message: 'The contract function "executeStep" reverted.\n\nError: CertificateExpired()' }).cls).toBe("retry_new_cert");
    expect(classifyRevert({ message: "execution reverted: ERC20: insufficient allowance" }).cls).toBe("allowance");
    expect(classifyRevert({ data: "0xdeadbeef" as Hex })).toEqual({ cls: "unknown", error: null });
    expect(classifyRevert({})).toEqual({ cls: "unknown", error: null });
  });
});
