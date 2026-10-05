/**
 * v7 R2 · 轮次记录读取（开发计划 §2.6「轮次记录」/ §2.8 `GET /v1/tasks/:id/runs`、`…/runs/:runId`）。
 * 只读 `verify_agent_runs` / `verify_agent_run_steps`；**永不**读取或返回 `messages_json`（续跑用的完整模型消息）与 `run_token_hash`。
 * 工具调用只给名字、哈希与预览；预览再过一遍密钥形态脱敏（纵深防御，写入方 Lane A 已做 SEC-05 扫描）；
 * 模型步骤不返回 argsPreview（可能是原始提示词，R-02）。
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyAgentRuns, verifyAgentRunSteps } from "@chaconne/db";
import type { AgentRunState, AgentRunStep, AgentRunSummary, Bytes32 } from "@chaconne/core/verify";

export type AgentRunRow = typeof verifyAgentRuns.$inferSelect;
export type AgentRunStepRow = typeof verifyAgentRunSteps.$inferSelect;

/** 只选摘要需要的列（不含 messages_json / run_token_hash） */
const RUN_COLUMNS = {
  id: verifyAgentRuns.id,
  taskId: verifyAgentRuns.taskId,
  turnVersion: verifyAgentRuns.turnVersion,
  reason: verifyAgentRuns.reason,
  mode: verifyAgentRuns.mode,
  state: verifyAgentRuns.state,
  attempt: verifyAgentRuns.attempt,
  model: verifyAgentRuns.model,
  promptHash: verifyAgentRuns.promptHash,
  actionJson: verifyAgentRuns.actionJson,
  decisionSummary: verifyAgentRuns.decisionSummary,
  nextCheckAt: verifyAgentRuns.nextCheckAt,
  invalidation: verifyAgentRuns.invalidation,
  usageJson: verifyAgentRuns.usageJson,
  costUsdMicros: verifyAgentRuns.costUsdMicros,
  prevRunHash: verifyAgentRuns.prevRunHash,
  runHash: verifyAgentRuns.runHash,
  startedAt: verifyAgentRuns.startedAt,
  endedAt: verifyAgentRuns.endedAt,
  createdAt: verifyAgentRuns.createdAt,
} as const;
export type RunSummaryRow = { [K in keyof typeof RUN_COLUMNS]: AgentRunRow[K] };

const PREVIEW_MAX = 2048;
const ZERO32 = `0x${"0".repeat(64)}` as Bytes32;

/** 密钥形态脱敏：32 字节十六进制（私钥形态）、常见 API key 前缀、Bearer 令牌 */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, (m) => (m.startsWith("0x") && m.length === 66 ? m : "[redacted:hex32]"))
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted:key]")
    .replace(/\bvk_(live|test)_[A-Za-z0-9_-]{8,}/g, "[redacted:key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]");
}
function preview(s: string | null): string | undefined {
  if (s === null || s === undefined) return undefined;
  return redactSecrets(s).slice(0, PREVIEW_MAX);
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function usageOf(row: Pick<RunSummaryRow, "usageJson" | "costUsdMicros">): AgentRunSummary["usage"] {
  // usage_json = { attempts: { "<n>": usage }, total }（AgentRuntime.mergeUsage）；旧形状（平铺）照旧可读
  const raw = (row.usageJson ?? {}) as Record<string, unknown>;
  const u = (raw["total"] && typeof raw["total"] === "object" ? raw["total"] : raw) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);
  return { inputTokens: n(u["inputTokens"]), outputTokens: n(u["outputTokens"]), cacheReadTokens: n(u["cacheReadTokens"]), costUsdMicros: row.costUsdMicros ?? (typeof u["costUsdMicros"] === "string" ? u["costUsdMicros"] : "0") };
}

/** 行 + 本 attempt 的工具步骤 → AgentRunSummary（§2.6 冻结形状） */
export function runSummaryOf(row: RunSummaryRow, steps: Array<Pick<AgentRunStepRow, "attempt" | "kind" | "name" | "argsHash" | "resultHash" | "seq">>): AgentRunSummary {
  // 与 AgentRuntime.complete 计算 runHash 时完全同一口径（否则证据包的 run_hash_chain 复算不过）：
  // 全部 attempt 里 argsHash 与 resultHash 都有的工具步骤，按 (attempt, seq) 排序；name 缺失记 "unknown"
  const toolCalls = steps
    .filter((s) => s.kind === "tool" && s.argsHash && s.resultHash)
    .sort((a, b) => a.attempt - b.attempt || a.seq - b.seq)
    .map((s) => ({ name: s.name ?? "unknown", argsHash: s.argsHash as Bytes32, resultHash: s.resultHash as Bytes32 }));
  // 冻结形状 action = { kind, ref, status }（库里的 action_json 另带 clientRequestId，不进摘要、不进哈希）
  const a = (row.actionJson as { kind?: string; ref?: string; status?: string } | null) ?? null;
  const action: AgentRunSummary["action"] = a && (a.kind === "intent" || a.kind === "status") ? { kind: a.kind, ref: String(a.ref ?? ""), status: String(a.status ?? "") } : null;
  return {
    runId: row.id,
    taskId: row.taskId,
    turnVersion: row.turnVersion,
    attempt: row.attempt,
    turnReason: row.reason,
    mode: row.mode === "SIMULATION" ? "SIMULATION" : "LIVE",
    model: row.model ?? "",
    promptHash: (row.promptHash ?? ZERO32) as Bytes32,
    startedAt: iso(row.startedAt) ?? row.createdAt.toISOString(),
    endedAt: iso(row.endedAt),
    state: row.state as AgentRunState,
    action,
    decisionSummary: row.decisionSummary ?? "",
    nextCheckAt: iso(row.nextCheckAt),
    invalidation: row.invalidation ?? null,
    toolCalls,
    usage: usageOf(row),
    prevRunHash: (row.prevRunHash as Bytes32 | null) ?? null,
    runHash: (row.runHash ?? ZERO32) as Bytes32,
  };
}

export function runStepView(s: AgentRunStepRow): AgentRunStep & { attempt: number } {
  const out: AgentRunStep & { attempt: number } = { attempt: s.attempt, seq: s.seq, kind: s.kind === "model" ? "model" : "tool", latencyMs: s.latencyMs, at: s.at.toISOString() };
  if (s.name) out.name = s.name;
  if (s.argsHash) out.argsHash = s.argsHash as Bytes32;
  if (s.resultHash) out.resultHash = s.resultHash as Bytes32;
  // 模型步骤的入参预览可能是原始提示词 → 不返回（R-02）
  if (s.kind !== "model") {
    const a = preview(s.argsPreview);
    if (a !== undefined) out.argsPreview = a;
  }
  const r = preview(s.resultPreview);
  if (r !== undefined) out.resultPreview = r;
  if (s.tokensIn !== null) out.tokensIn = s.tokensIn;
  if (s.tokensOut !== null) out.tokensOut = s.tokensOut;
  if (s.error) out.error = preview(s.error)!;
  return out;
}

/** 任务的全部轮次摘要（按 turnVersion 升序） */
export async function listRunSummaries(db: Db, taskId: string): Promise<AgentRunSummary[]> {
  const runs = await db.select(RUN_COLUMNS).from(verifyAgentRuns).where(eq(verifyAgentRuns.taskId, taskId)).orderBy(asc(verifyAgentRuns.turnVersion));
  if (runs.length === 0) return [];
  const steps = await db
    .select({ runId: verifyAgentRunSteps.runId, attempt: verifyAgentRunSteps.attempt, seq: verifyAgentRunSteps.seq, kind: verifyAgentRunSteps.kind, name: verifyAgentRunSteps.name, argsHash: verifyAgentRunSteps.argsHash, resultHash: verifyAgentRunSteps.resultHash })
    .from(verifyAgentRunSteps)
    .innerJoin(verifyAgentRuns, eq(verifyAgentRuns.id, verifyAgentRunSteps.runId))
    .where(eq(verifyAgentRuns.taskId, taskId));
  return runs.map((r) => runSummaryOf(r, steps.filter((s) => s.runId === r.id)));
}

/** 单轮详情：摘要 + 全部 attempt 的步骤（预览已脱敏） */
export async function runDetail(db: Db, taskId: string, runId: string): Promise<{ run: AgentRunSummary; steps: Array<AgentRunStep & { attempt: number }> } | null> {
  const row = (await db.select(RUN_COLUMNS).from(verifyAgentRuns).where(and(eq(verifyAgentRuns.id, runId), eq(verifyAgentRuns.taskId, taskId))).limit(1))[0];
  if (!row) return null;
  const steps = await db.select().from(verifyAgentRunSteps).where(eq(verifyAgentRunSteps.runId, runId)).orderBy(asc(verifyAgentRunSteps.attempt), asc(verifyAgentRunSteps.seq));
  return { run: runSummaryOf(row, steps), steps: steps.map(runStepView) };
}
