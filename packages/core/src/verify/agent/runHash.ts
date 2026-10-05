/**
 * 托管 Agent 轮次哈希链（开发计划 §2.6，CV-D25）。
 * runHash = hashCanonical({ v: "agent-run/1", prevRunHash, taskId, turnVersion, attempt, model, promptHash, toolCalls, action, decisionSummary, nextCheckAt })
 * 哈希链覆盖所有带动作的轮次（COMPLETED 与 INCOMPLETE），按完成时间串接；FAILED / CANCELLED 不进链。
 * 只证明「记录一致、未被改写」，不证明判断正确。
 */
import { hashCanonical } from "../canonical";
import { agentRunHash } from "../tasks/verify";
import type { AgentRunState, AgentRunSummary, Bytes32, IsoUtc } from "../contracts";

export const RUN_HASH_VERSION = "agent-run/1" as const;
/** 进哈希链的轮次状态 */
export const CHAINED_RUN_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["COMPLETED", "INCOMPLETE"]);
/** decisionSummary 上限（字符） */
export const DECISION_SUMMARY_MAX_CHARS = 280;

export interface RunAction {
  kind: "intent" | "status";
  ref: string;
  status: string;
}

export interface RunHashInput {
  prevRunHash: Bytes32 | null;
  taskId: string;
  turnVersion: number;
  attempt: number;
  model: string;
  promptHash: Bytes32;
  toolCalls: Array<{ name: string; argsHash: Bytes32; resultHash: Bytes32 }>;
  action: RunAction | null;
  decisionSummary: string;
  nextCheckAt: IsoUtc | null;
}

/** 冻结公式只有一份：委托给 core tasks/verify.ts 的 agentRunHash（Lane R 证据包 v3 验证器用同一个函数） */
export function runHash(i: RunHashInput): Bytes32 {
  return agentRunHash({ ...i, toolCalls: i.toolCalls.map((t) => ({ name: t.name, argsHash: t.argsHash, resultHash: t.resultHash })), action: i.action ? { kind: i.action.kind, ref: i.action.ref, status: i.action.status } : null });
}

/** 工具参数 / 结果的哈希（canon-1；含浮点等不可规范化的值时退回对 JSON 文本求哈希） */
export function payloadHash(v: unknown): Bytes32 {
  try {
    return hashCanonical(v ?? null);
  } catch {
    return hashCanonical(JSON.stringify(v ?? null));
  }
}

/** 截断决策摘要（≤ 280 字，按码点截，不切坏代理对） */
export function clipSummary(s: string, max = DECISION_SUMMARY_MAX_CHARS): string {
  const cps = Array.from(s.trim());
  return cps.length <= max ? cps.join("") : `${cps.slice(0, max - 1).join("")}…`;
}

export interface ChainCheck {
  ok: boolean;
  /** 第一处不一致的下标（按传入顺序）；ok 时为 null */
  brokenAt: number | null;
  reason: string | null;
}

/** 离线复算哈希链：传入同一任务、带动作的轮次（按完成时间升序） */
export function verifyRunChain(runs: readonly AgentRunSummary[]): ChainCheck {
  let prev: Bytes32 | null = null;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (r.prevRunHash !== prev) return { ok: false, brokenAt: i, reason: "prev_run_hash_mismatch" };
    const h = runHash({ prevRunHash: r.prevRunHash, taskId: r.taskId, turnVersion: r.turnVersion, attempt: r.attempt, model: r.model, promptHash: r.promptHash, toolCalls: r.toolCalls, action: r.action, decisionSummary: r.decisionSummary, nextCheckAt: r.nextCheckAt });
    if (h !== r.runHash) return { ok: false, brokenAt: i, reason: "run_hash_mismatch" };
    prev = r.runHash;
  }
  return { ok: true, brokenAt: null, reason: null };
}
