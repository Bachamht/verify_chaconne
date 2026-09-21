/**
 * 链上回执核实器（同进程定时）：把已提交 tx hash 的执行尝试按 X Layer RPC 回执推进状态。
 * 服务不信任客户端的“成功”声明（interfaces §5）：只有回执成功 + Guard 事件 intentDigest 与本尝试一致 + 达到确认数才记 CONFIRMED。
 *   SUBMITTED ──回执缺失超时──▶ UNKNOWN（继续核实，48 h 内找到仍可推进）
 *   SUBMITTED / UNKNOWN ──回执 reverted──▶ REVERTED
 *   SUBMITTED / UNKNOWN ──回执成功但事件缺失/摘要不符──▶ UNKNOWN(reason)
 *   SUBMITTED / UNKNOWN ──回执成功 + 事件匹配，确认数不足──▶ REORG_PENDING ──足够──▶ CONFIRMED
 *   REORG_PENDING ──回执消失（重组）──▶ SUBMITTED
 * 只推进状态，绝不发起链上交易；CONFIRMED / REVERTED 为终态不再复查。
 */
import { createPublicClient, decodeEventLog, http, type Hex } from "viem";
import { log } from "../log";
import { GUARD_ABI } from "./guardAbi";
import { PLANGUARD_ABI } from "./planGuardAbi";

export interface ReceiptLog {
  address: string;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
}
export interface ChainReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  gasUsed: bigint;
  logs: ReceiptLog[];
}
export interface ReceiptSource {
  /** 未上链 / 未知 hash → null */
  getReceipt(txHash: Hex): Promise<ChainReceipt | null>;
  headBlock(): Promise<bigint>;
}

export function rpcReceiptSource(rpcUrl: string): ReceiptSource {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async getReceipt(txHash) {
      try {
        const r = await client.getTransactionReceipt({ hash: txHash });
        return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, gasUsed: r.gasUsed, logs: r.logs.map((l) => ({ address: l.address, data: l.data, topics: l.topics })) };
      } catch (e) {
        if (e instanceof Error && /not (be )?found|could not be found/i.test(e.message)) return null;
        throw e;
      }
    },
    headBlock: () => client.getBlockNumber(),
  };
}

export interface ReceiptAttempt {
  id: string;
  state: string;
  txHash: string | null;
  intentDigest: string;
  updatedAt: Date;
  receiptJson: unknown;
}
export interface ReceiptStore {
  pendingExecutionAttempts(): Promise<ReceiptAttempt[]>;
  applyReceipt(attemptId: string, state: "CONFIRMED" | "REVERTED" | "UNKNOWN" | "REORG_PENDING" | "SUBMITTED", receipt: Record<string, unknown>): Promise<void>;
}
export interface ReceiptVerifierOptions {
  guard: string;
  confirmations: number;
  unknownAfterMs: number;
  now?: () => Date;
  /** v2：事件匹配器；默认 GuardedExecution（v1 Guard）。PlanGuard 用 findMandateStepEvent */
  matcher?: EventMatcher;
}
/** 从回执里找本合约事件并给出用于比对的摘要（v1: intentDigest；v2: stepDigest 由 mandateDigest+stepIndex 关联，比对 attempt.intentDigest 存 stepDigest 时用 stepDigestOf） */
export type EventMatcher = (receipt: ChainReceipt, guard: string) => { digest: string; event: Record<string, unknown> } | null;

export interface GuardedExecutionSummary {
  owner: string;
  recipient: string;
  nonce: string;
  intentDigest: string;
  evidenceHash: string;
  router: string;
  amountIn: string;
  spent: string;
  received: string;
  refunded: string;
}

export function findGuardedExecution(receipt: ChainReceipt, guard: string): GuardedExecutionSummary | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== guard.toLowerCase() || l.topics.length === 0) continue;
    try {
      const d = decodeEventLog({ abi: GUARD_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName !== "GuardedExecution") continue;
      const a = d.args as Record<string, unknown>;
      const s = (k: string) => String(a[k]);
      return { owner: s("owner").toLowerCase(), recipient: s("recipient").toLowerCase(), nonce: s("nonce"), intentDigest: s("intentDigest").toLowerCase(), evidenceHash: s("evidenceHash").toLowerCase(), router: s("router").toLowerCase(), amountIn: s("amountIn"), spent: s("spent"), received: s("received"), refunded: s("refunded") };
    } catch {
      /* 非本合约事件 */
    }
  }
  return null;
}

export interface MandateStepSummary {
  owner: string;
  mandateDigest: string;
  stepIndex: string;
  outputToken: string;
  amountIn: string;
  spent: string;
  received: string;
  refunded: string;
  evidenceHash: string;
  executor: string;
}

export function findMandateStep(receipt: ChainReceipt, planGuard: string): MandateStepSummary | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== planGuard.toLowerCase() || l.topics.length === 0) continue;
    try {
      const d = decodeEventLog({ abi: PLANGUARD_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName !== "MandateStep") continue;
      const a = d.args as Record<string, unknown>;
      const s = (k: string) => String(a[k]);
      return { owner: s("owner").toLowerCase(), mandateDigest: s("mandateDigest").toLowerCase(), stepIndex: s("stepIndex"), outputToken: s("outputToken").toLowerCase(), amountIn: s("amountIn"), spent: s("spent"), received: s("received"), refunded: s("refunded"), evidenceHash: s("evidenceHash").toLowerCase(), executor: s("executor").toLowerCase() };
    } catch {
      /* 非本合约事件 */
    }
  }
  return null;
}

/** v1 默认匹配器 */
export const guardedExecutionMatcher: EventMatcher = (receipt, guard) => {
  const ev = findGuardedExecution(receipt, guard);
  return ev ? { digest: ev.intentDigest, event: ev as unknown as Record<string, unknown> } : null;
};
/** v2：attempt.intentDigest 存的是 `${mandateDigest}:${stepIndex}` 关联键 */
export const mandateStepMatcher: EventMatcher = (receipt, planGuard) => {
  const ev = findMandateStep(receipt, planGuard);
  return ev ? { digest: `${ev.mandateDigest}:${ev.stepIndex}`, event: ev as unknown as Record<string, unknown> } : null;
};

export type ReceiptDecision = { state: "CONFIRMED" | "REVERTED" | "UNKNOWN" | "REORG_PENDING" | "SUBMITTED"; receipt: Record<string, unknown> } | null;

/** 纯决策：给定尝试 + 回执（或 null）+ 链头，返回要写入的状态；null = 不变 */
export function decideReceipt(attempt: ReceiptAttempt, receipt: ChainReceipt | null, head: bigint, opts: ReceiptVerifierOptions): ReceiptDecision {
  const now = (opts.now ?? (() => new Date()))();
  const checkedAt = now.toISOString();
  const txHash = attempt.txHash!;
  if (!receipt) {
    if (attempt.state === "REORG_PENDING") return { state: "SUBMITTED", receipt: { txHash, reason: "receipt_vanished_after_reorg", checkedAt, previous: attempt.receiptJson ?? null } };
    if (attempt.state === "SUBMITTED" && now.getTime() - attempt.updatedAt.getTime() >= opts.unknownAfterMs) return { state: "UNKNOWN", receipt: { txHash, reason: "receipt_not_found", checkedAt } };
    return null;
  }
  const base = { txHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString(), checkedAt };
  if (receipt.status === "reverted") return { state: "REVERTED", receipt: { ...base, status: "reverted" } };
  const matched = (opts.matcher ?? guardedExecutionMatcher)(receipt, opts.guard);
  if (!matched) return attempt.state === "UNKNOWN" && (attempt.receiptJson as { reason?: string } | null)?.reason === "guard_event_missing" ? null : { state: "UNKNOWN", receipt: { ...base, status: "success", reason: "guard_event_missing" } };
  const ev = matched.event;
  if (matched.digest !== attempt.intentDigest.toLowerCase()) return attempt.state === "UNKNOWN" && (attempt.receiptJson as { reason?: string } | null)?.reason === "intent_digest_mismatch" ? null : { state: "UNKNOWN", receipt: { ...base, status: "success", reason: "intent_digest_mismatch", event: ev } };
  const confirmations = Number(head - receipt.blockNumber + 1n);
  if (confirmations < opts.confirmations) return { state: "REORG_PENDING", receipt: { ...base, status: "success", confirmations, requiredConfirmations: opts.confirmations, event: ev } };
  return { state: "CONFIRMED", receipt: { ...base, status: "success", confirmations, requiredConfirmations: opts.confirmations, event: ev, confirmedAt: checkedAt } };
}

export async function verifyReceiptsOnce(store: ReceiptStore, source: ReceiptSource, opts: ReceiptVerifierOptions): Promise<{ checked: number; updated: number }> {
  const pending = await store.pendingExecutionAttempts();
  if (pending.length === 0) return { checked: 0, updated: 0 };
  const head = await source.headBlock();
  let updated = 0;
  for (const a of pending) {
    if (!a.txHash) continue;
    let receipt: ChainReceipt | null;
    try {
      receipt = await source.getReceipt(a.txHash as Hex);
    } catch (err) {
      log.warn("回执查询失败，下轮重试", { attemptId: a.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const decision = decideReceipt(a, receipt, head, opts);
    if (!decision) continue;
    await store.applyReceipt(a.id, decision.state, decision.receipt);
    updated += 1;
    log.info("执行回执推进", { attemptId: a.id, from: a.state, to: decision.state, txHash: a.txHash });
  }
  return { checked: pending.length, updated };
}

export function startReceiptVerifier(store: ReceiptStore, source: ReceiptSource, opts: ReceiptVerifierOptions, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    verifyReceiptsOnce(store, source, opts)
      .catch((err) => log.error("回执核实失败", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
