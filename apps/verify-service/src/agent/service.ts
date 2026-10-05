/**
 * 托管 Chaconne Agent 的服务端运行时（v7 Lane A，开发计划 §2.6 / §3.3 A2；D-090 / D-093 / CV-D23 / CV-D25）。
 *
 *  - 轮次队列：claim 只领「agent_mode=hosted、运行中、当前轮次 awaiting_agent / no_response、没有活跃轮次」的任务；
 *    节流（低优先级原因 600 s）、观察模式（每任务 ≤ 6 轮）、三个日成本上限分开；一次性 runToken（只存 sha256），租约 240 s；
 *  - checkpoint / complete 带 attempt 围栏；complete 用服务端记录的终结动作计算 runHash 链（prevRunHash = 同任务上一条带动作的轮次）；
 *  - 成本：按 verify-service 的价格变量把 usage 折算为微美元；价格缺失 → 托管 Agent 不启用并告警；
 *  - 决策上下文（GET /v1/tasks/:id/agent-context）、可执行报价（POST /v1/tasks/:id/quotes）、任务记忆；
 *  - 轮次调度钩子（其它 lane 调）：onAssigned / onAuthorized / onExecutionFailed / onEventDataArrived，以及 scheduledTick（nextCheckAt 到点）。
 * 全部受 cfg.v7.hostedAgent 控制；关闭时 claim 回 503 hosted_disabled，钩子什么也不做。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyAgentMemory, verifyAgentRunSteps, verifyAgentRuns, verifyAgentWorkers, verifyTaskIntents, verifyTasks } from "@chaconne/db";
import {
  buildReport,
  findEntry,
  findPolicy,
  isBytes32,
  nextRegularCloseMs,
  nextRegularOpenMs,
  resolveParams,
  sessionLabelAtMs,
  TASK_RUNNING_STATUSES,
  type AgentRunState,
  type AgentRunSummary,
  type AgentTurn,
  type AgentTurnReason,
  type AssetRegistry,
  type Blocker,
  type Bytes32,
  type EvidenceRecord,
  type MarketEventV7,
  type NeedsOperatorCode,
  type NormalizedJob,
  type PlanGoal,
  type TaskBrief,
  type TaskScope,
  type VerifyReport,
} from "@chaconne/core/verify";
import {
  addUsage,
  appendMemory,
  claimSkipReason,
  clipSummary,
  costUsdMicros,
  isBudgetSkip,
  parseAgentPrices,
  previewOf,
  runHash,
  runTokenHash,
  sanitizeUsage,
  truncateMessages,
  usdCapMicros,
  validateMemoryText,
  ACTIVE_RUN_STATES,
  RUN_LEASE_MS,
  type AgentPrices,
  type AgentUsage,
  type CostToday,
  type MemoryNote,
  type RecordedTurnAction,
  type StoredMessage,
} from "@chaconne/core/verify/agent/index";
import type { VerifyConfig } from "../config";
import type { ContextService } from "../context/service";
import type { EvidenceProvider } from "../evidence/provider";
import { HttpError } from "../jobs/service";
import { log } from "../log";
import { policyWithConditions } from "../mandates/service";
import type { ThesesService } from "../theses/service";
import { bindingHashOf, scopeOf, type TaskRow, type TasksService } from "../tasks/service";
import { callerActsFor } from "../http/auth";
import { notificationPayload, type TaskNotifier } from "../tasks/notify";
import { observedAtOf, recordTaskEvidence } from "./evidence";
import { parseRunToken, type RunBinding } from "./runContext";

export type RunRow = typeof verifyAgentRuns.$inferSelect;

/** 其它 lane 的可选数据源（Lane X：持仓、额度、作业状态、卖出上限）；缺省 = 空 / 未知 */
export interface AgentRuntimeProviders {
  positions?: (taskId: string) => Promise<Array<Record<string, unknown>>>;
  budgetExtras?: (taskId: string) => Promise<{ allowanceRaw?: Record<string, string>; sellReady?: Record<string, boolean> }>;
  jobForIntent?: (intentId: string) => Promise<{ state: string; errorCode: string | null } | null>;
  /** 卖出报价的每笔上限（卖出授权的 perStepCap，股票最小单位）；null = 没有卖出授权 */
  sellCapRaw?: (taskId: string, assetKey: string) => Promise<string | null>;
}

export interface AgentRuntimeDeps {
  db: Db;
  cfg: VerifyConfig;
  tasks: TasksService;
  theses: ThesesService;
  context: ContextService;
  evidence: EvidenceProvider;
  registry: AssetRegistry;
  notifier?: TaskNotifier | null;
  /** 运营者频道（NotifyService.operatorAlert） */
  operatorAlert?: ((code: string, text: string) => Promise<unknown>) | null;
  providers?: AgentRuntimeProviders;
  now?: () => Date;
}

export interface ClaimedRun {
  runId: string;
  runToken: string;
  taskId: string;
  turnVersion: number;
  reason: string;
  attempt: number;
  leaseUntil: string;
  mode: "LIVE" | "SIMULATION";
  resume?: { messages: unknown[] | null; action: RecordedTurnAction | null; completedTools: Array<{ attempt: number; seq: number; name: string | null; argsHash: string | null; resultHash: string | null }>; previousAttempt: number };
}

const RUN_TOKEN_PREFIX = "rt1";
const QUOTE_CACHE_MS = 30_000;
const QUOTE_MAX_PER_HOUR = 20;
const QUOTE_MAX_ITEMS = 3;
const STEP_MAX_PER_CALL = 64;
const RUNNING_STATUSES = ["ACTIVE", "WAITING", "STEP_PREPARED", "PARTIAL"] as const;

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}
function nonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export class AgentRuntime {
  private readonly now: () => Date;
  readonly prices: AgentPrices | null;
  private readonly budgetExhausted = new Map<string, string>();
  private quoteChain: Promise<unknown> = Promise.resolve();
  private readonly quoteCache = new Map<string, { at: number; value: Record<string, unknown> }>();
  private readonly quoteCalls = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: AgentRuntimeDeps) {
    this.now = d.now ?? (() => new Date());
    this.prices = parseAgentPrices({ input: d.cfg.AGENT_PRICE_INPUT_PER_MTOK_USD, output: d.cfg.AGENT_PRICE_OUTPUT_PER_MTOK_USD, cacheRead: d.cfg.AGENT_PRICE_CACHE_READ_PER_MTOK_USD, cacheWrite: d.cfg.AGENT_PRICE_CACHE_WRITE_PER_MTOK_USD });
    if (d.cfg.v7.hostedAgent && !this.prices) {
      log.warn("HOSTED_AGENT_ENABLED=true 但模型价格变量缺失：托管 Agent 不启用（否则成本上限形同虚设）", { missing: ["AGENT_PRICE_INPUT_PER_MTOK_USD", "AGENT_PRICE_OUTPUT_PER_MTOK_USD", "AGENT_PRICE_CACHE_READ_PER_MTOK_USD"] });
      void this.alert("agent_prices_missing", "HOSTED_AGENT_ENABLED=true but model price env vars are missing; the hosted agent stays disabled");
    }
  }

  /** 开关打开且价格齐全才启用 */
  get enabled(): boolean {
    return this.d.cfg.v7.hostedAgent && this.prices !== null;
  }

  private async alert(code: string, text: string): Promise<void> {
    try {
      await this.d.operatorAlert?.(code, text);
    } catch (err) {
      log.warn("运营者告警发送失败", { code, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new HttpError(503, "hosted_disabled", this.d.cfg.v7.hostedAgent ? "hosted agent is disabled: model price env vars are missing" : "hosted agent is disabled (HOSTED_AGENT_ENABLED=false)");
  }

  /* ================================================================ */
  /* 轮次令牌                                                           */
  /* ================================================================ */

  /** x-agent-run-token 校验：未知 / 不匹配 → 403；旧 attempt / 租约过期 / 轮次已结束 → 409 */
  async validateToken(token: string): Promise<{ ok: true; binding: RunBinding } | { ok: false; status: 403 | 409; code: string }> {
    const parsed = parseRunToken(token);
    if (!parsed) return { ok: false, status: 403, code: "run_token_invalid" };
    const row = (await this.d.db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.id, parsed.runId)).limit(1))[0];
    if (!row) return { ok: false, status: 403, code: "run_token_invalid" };
    if (parsed.attempt !== row.attempt) return parsed.attempt < row.attempt ? { ok: false, status: 409, code: "run_token_stale_attempt" } : { ok: false, status: 403, code: "run_token_invalid" };
    const want = row.runTokenHash ? Buffer.from(row.runTokenHash, "hex") : null;
    const got = Buffer.from(runTokenHash(token), "hex");
    if (!want || want.length !== got.length || !timingSafeEqual(want, got)) return row.runTokenHash ? { ok: false, status: 403, code: "run_token_invalid" } : { ok: false, status: 409, code: "run_token_expired" };
    if (!ACTIVE_RUN_STATES.has(row.state as AgentRunState) || !row.leaseUntil || row.leaseUntil.getTime() <= this.now().getTime()) return { ok: false, status: 409, code: "run_token_expired" };
    return { ok: true, binding: { runId: row.id, taskId: row.taskId, turnVersion: row.turnVersion, attempt: row.attempt, leaseUntil: row.leaseUntil } };
  }

  /* ================================================================ */
  /* 轮次队列                                                           */
  /* ================================================================ */

  private caps() {
    return { perTaskMicros: usdCapMicros(this.d.cfg.AGENT_DAILY_USD_CAP_PER_TASK), liveTotalMicros: usdCapMicros(this.d.cfg.AGENT_DAILY_USD_CAP_LIVE_TOTAL), simTotalMicros: usdCapMicros(this.d.cfg.AGENT_DAILY_USD_CAP_SIM_TOTAL) };
  }

  /** 今日（UTC）成本：按任务与模式汇总（FAILED 的尝试也花了钱，一并计入） */
  async costToday(): Promise<{ byTask: Map<string, bigint>; live: bigint; sim: bigint }> {
    const rows = await this.d.db.select({ taskId: verifyAgentRuns.taskId, mode: verifyAgentRuns.mode, cost: verifyAgentRuns.costUsdMicros }).from(verifyAgentRuns).where(and(gte(verifyAgentRuns.updatedAt, utcDayStart(this.now())), isNotNull(verifyAgentRuns.costUsdMicros)));
    const byTask = new Map<string, bigint>();
    let live = 0n;
    let sim = 0n;
    for (const r of rows) {
      const c = BigInt(r.cost ?? "0");
      byTask.set(r.taskId, (byTask.get(r.taskId) ?? 0n) + c);
      if (r.mode === "LIVE") live += c;
      else sim += c;
    }
    return { byTask, live, sim };
  }

  async claim(worker: string, maxRaw: unknown): Promise<{ runs: ClaimedRun[] }> {
    this.requireEnabled();
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(worker)) throw new HttpError(400, "invalid_request", "worker must be 1-64 chars [A-Za-z0-9_.:-]");
    const max = Math.min(5, Math.max(1, nonNegInt(maxRaw) ?? 1));
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    await this.sweepStaleRuns(nowDate).catch((e: unknown) => log.warn("agent run sweep failed", { error: String(e) }));
    const tasks = await this.d.db.select().from(verifyTasks).where(and(eq(verifyTasks.agentMode, "hosted"), inArray(verifyTasks.status, [...RUNNING_STATUSES]))).limit(500);
    const open = tasks
      .map((t) => ({ t, turn: (t.agentTurnJson as AgentTurn | null) ?? null }))
      .filter((x): x is { t: TaskRow; turn: AgentTurn } => !!x.turn && (x.turn.state === "awaiting_agent" || x.turn.state === "no_response") && !!scopeOf(x.t))
      .sort((a, b) => (a.turn.requestedAt < b.turn.requestedAt ? -1 : 1));
    if (open.length === 0) return { runs: [] };
    const cost = await this.costToday();
    const caps = this.caps();
    const minIntervalMs = this.d.cfg.AGENT_MIN_RUN_INTERVAL_S * 1000;
    const out: ClaimedRun[] = [];
    for (const { t, turn } of open) {
      if (out.length >= max) break;
      const runs = await this.d.db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.taskId, t.id));
      if (runs.some((r) => ACTIVE_RUN_STATES.has(r.state as AgentRunState) && r.turnVersion !== turn.version && r.leaseUntil && r.leaseUntil.getTime() > nowMs)) continue;
      const existing = runs.find((r) => r.turnVersion === turn.version) ?? null;
      const lastStarted = runs.reduce<number | null>((m, r) => (r.startedAt && (m === null || r.startedAt.getTime() > m) ? r.startedAt.getTime() : m), null);
      const today: CostToday = { taskMicros: cost.byTask.get(t.id) ?? 0n, liveTotalMicros: cost.live, simTotalMicros: cost.sim };
      const skip = claimSkipReason({ mode: t.mode as "LIVE" | "SIMULATION", reason: turn.reason, lastRunStartedMs: lastStarted, runsForTask: runs.length, existing: existing ? { state: existing.state as AgentRunState, attempt: existing.attempt, leaseUntilMs: existing.leaseUntil?.getTime() ?? null, updatedMs: existing.updatedAt.getTime() } : null }, today, caps, nowMs, minIntervalMs);
      if (isBudgetSkip(skip)) {
        if (!this.budgetExhausted.has(t.id)) void this.alert("agent_budget_exhausted", `daily agent cost cap reached (${skip}) for task ${t.id}; no new turns are claimed today`);
        this.budgetExhausted.set(t.id, utcDayStart(nowDate).toISOString());
        continue;
      }
      if (skip) continue;
      this.budgetExhausted.delete(t.id);
      const claimed = await this.claimOne(t, turn, existing, worker, nowDate);
      if (claimed) out.push(claimed);
    }
    return { runs: out };
  }

  /**
   * 收尾卡死的轮次（10/3 线上：complete 被 413 拒后轮次永远停在 RUNNING，运行态一直显示「正在工作」）：
   * 租约已过期、且这一轮不会再被续跑（任务已不在运行态，或该轮次已被回答 / 已有更新的轮次）→ INCOMPLETE 并收尾。
   * 轮次还在等回答的不碰：claim 会按 existing 续跑它。没有 runHash（不计入「上次决策」），保留已有的对话与用量。
   */
  async sweepStaleRuns(nowDate: Date = this.now()): Promise<number> {
    const stale = await this.d.db.select().from(verifyAgentRuns).where(and(inArray(verifyAgentRuns.state, [...ACTIVE_RUN_STATES]), lte(verifyAgentRuns.leaseUntil, nowDate))).limit(100);
    let closed = 0;
    for (const r of stale) {
      const task = (await this.d.db.select().from(verifyTasks).where(eq(verifyTasks.id, r.taskId)).limit(1))[0];
      const turn = (task?.agentTurnJson as AgentTurn | null) ?? null;
      const resumable = !!task && (RUNNING_STATUSES as readonly string[]).includes(task.status) && !!turn && turn.version === r.turnVersion && (turn.state === "awaiting_agent" || turn.state === "no_response");
      if (resumable) continue;
      const [u] = await this.d.db.update(verifyAgentRuns)
        .set({ state: "INCOMPLETE", leaseUntil: null, runTokenHash: null, endedAt: nowDate, decisionSummary: r.decisionSummary ?? clipSummary("lease expired after the turn closed; run closed by the sweeper (its completion was never recorded)"), updatedAt: nowDate })
        .where(and(eq(verifyAgentRuns.id, r.id), inArray(verifyAgentRuns.state, [...ACTIVE_RUN_STATES])))
        .returning({ id: verifyAgentRuns.id });
      if (u) closed += 1;
    }
    if (closed) log.info("agent runs swept", { closed });
    return closed;
  }

  private async claimOne(t: TaskRow, turn: AgentTurn, existing: RunRow | null, worker: string, nowDate: Date): Promise<ClaimedRun | null> {
    const leaseUntil = new Date(nowDate.getTime() + RUN_LEASE_MS);
    const runId = existing?.id ?? `run_${randomBytes(12).toString("hex")}`;
    const attempt = (existing?.attempt ?? 0) + 1;
    const token = `${RUN_TOKEN_PREFIX}.${runId}.${attempt}.${randomBytes(32).toString("hex")}`;
    const tokenHash = runTokenHash(token);
    if (existing) {
      const r = await this.d.db
        .update(verifyAgentRuns)
        .set({ state: "CLAIMED", attempt, runTokenHash: tokenHash, leaseUntil, worker, startedAt: existing.startedAt ?? nowDate, updatedAt: nowDate })
        .where(and(eq(verifyAgentRuns.id, existing.id), eq(verifyAgentRuns.attempt, existing.attempt)))
        .returning({ id: verifyAgentRuns.id });
      if (r.length === 0) return null;
    } else {
      const r = await this.d.db
        .insert(verifyAgentRuns)
        .values({ id: runId, taskId: t.id, turnVersion: turn.version, reason: turn.reason, mode: t.mode, state: "CLAIMED", attempt, runTokenHash: tokenHash, leaseUntil, worker, startedAt: nowDate, createdAt: nowDate, updatedAt: nowDate })
        .onConflictDoNothing()
        .returning({ id: verifyAgentRuns.id });
      if (r.length === 0) return null;
    }
    let resume: ClaimedRun["resume"];
    if (existing) {
      const steps = await this.d.db.select().from(verifyAgentRunSteps).where(and(eq(verifyAgentRunSteps.runId, runId), eq(verifyAgentRunSteps.kind, "tool"), isNotNull(verifyAgentRunSteps.resultHash))).orderBy(asc(verifyAgentRunSteps.attempt), asc(verifyAgentRunSteps.seq));
      resume = { messages: (existing.messagesJson as unknown[] | null) ?? null, action: (existing.actionJson as RecordedTurnAction | null) ?? null, completedTools: steps.map((s) => ({ attempt: s.attempt, seq: s.seq, name: s.name, argsHash: s.argsHash, resultHash: s.resultHash })), previousAttempt: existing.attempt };
    }
    log.info("托管 Agent 轮次已领取", { runId, taskId: t.id, turnVersion: turn.version, attempt, worker });
    return { runId, runToken: token, taskId: t.id, turnVersion: turn.version, reason: turn.reason, attempt, leaseUntil: leaseUntil.toISOString(), mode: t.mode as "LIVE" | "SIMULATION", ...(resume ? { resume } : {}) };
  }

  private async requireRun(binding: RunBinding, runId: string, attemptRaw: unknown): Promise<RunRow> {
    if (binding.runId !== runId) throw new HttpError(403, "run_token_run_mismatch", "the run token is bound to another run");
    const row = (await this.d.db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.id, runId)).limit(1))[0];
    if (!row) throw new HttpError(404, "run_not_found");
    if (nonNegInt(attemptRaw) !== row.attempt) throw new HttpError(409, "stale_attempt", `run ${runId} is on attempt ${row.attempt}`, { attempt: row.attempt });
    if (!ACTIVE_RUN_STATES.has(row.state as AgentRunState) || !row.leaseUntil || row.leaseUntil.getTime() <= this.now().getTime()) throw new HttpError(409, "lease_expired", "the run lease has expired; another worker may resume it");
    return row;
  }

  /** 写步骤（预览在服务端再过一遍密钥扫描，≤ 2 KB）；同 (runId, attempt, seq) 幂等 */
  private async writeSteps(row: RunRow, raw: unknown): Promise<number> {
    if (raw === undefined) return 0;
    if (!Array.isArray(raw) || raw.length > STEP_MAX_PER_CALL) throw new HttpError(400, "invalid_request", `steps must be an array of ≤ ${STEP_MAX_PER_CALL}`);
    let n = 0;
    for (const s of raw as Array<Record<string, unknown>>) {
      const seq = nonNegInt(s?.["seq"]);
      const kind = s?.["kind"] === "model" || s?.["kind"] === "tool" ? (s["kind"] as string) : null;
      if (seq === null || !kind) throw new HttpError(400, "invalid_request", "each step needs seq (int ≥ 0) and kind (model|tool)");
      const at = typeof s["at"] === "string" && Number.isFinite(Date.parse(s["at"])) ? new Date(Date.parse(s["at"])) : this.now();
      const r = await this.d.db
        .insert(verifyAgentRunSteps)
        .values({ runId: row.id, attempt: row.attempt, seq, kind, name: str(s["name"], 64), argsHash: isBytes32(s["argsHash"]) ? (s["argsHash"] as string) : null, resultHash: isBytes32(s["resultHash"]) ? (s["resultHash"] as string) : null, argsPreview: s["argsPreview"] === undefined ? null : previewOf(s["argsPreview"]), resultPreview: s["resultPreview"] === undefined ? null : previewOf(s["resultPreview"]), tokensIn: nonNegInt(s["tokensIn"]), tokensOut: nonNegInt(s["tokensOut"]), latencyMs: nonNegInt(s["latencyMs"]) ?? 0, error: s["error"] === undefined ? null : previewOf(s["error"], 500), at })
        .onConflictDoNothing()
        .returning({ id: verifyAgentRunSteps.id });
      n += r.length;
    }
    return n;
  }

  /** usage_json = { attempts: { "<n>": usage }, total }；每次上报的是本 attempt 的累计值 */
  private mergeUsage(row: RunRow, raw: unknown): { usageJson: Record<string, unknown>; total: AgentUsage } | null {
    if (raw === undefined) return null;
    const u = sanitizeUsage(raw);
    const prev = (row.usageJson as { attempts?: Record<string, AgentUsage> } | null)?.attempts ?? {};
    const attempts = { ...prev, [String(row.attempt)]: u };
    const total = Object.values(attempts).reduce((a, b) => addUsage(a, sanitizeUsage(b)), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    return { usageJson: { attempts, total }, total };
  }

  async checkpoint(binding: RunBinding, runId: string, body: Record<string, unknown>): Promise<{ ok: true; runId: string; attempt: number; leaseUntil: string; stepsWritten: number }> {
    const row = await this.requireRun(binding, runId, body["attempt"]);
    const stepsWritten = await this.writeSteps(row, body["steps"]);
    const usage = this.mergeUsage(row, body["usage"]);
    const messages = Array.isArray(body["messages"]) ? truncateMessages(body["messages"] as StoredMessage[]).messages : undefined;
    const leaseUntil = new Date(this.now().getTime() + RUN_LEASE_MS);
    await this.d.db
      .update(verifyAgentRuns)
      .set({ state: "RUNNING", leaseUntil, ...(messages ? { messagesJson: messages } : {}), ...(usage ? { usageJson: usage.usageJson, ...(this.prices ? { costUsdMicros: costUsdMicros(usage.total, this.prices) } : {}) } : {}), ...(str(body["model"], 100) ? { model: str(body["model"], 100) } : {}), ...(isBytes32(body["promptHash"]) ? { promptHash: body["promptHash"] as string } : {}), updatedAt: this.now() })
      .where(and(eq(verifyAgentRuns.id, row.id), eq(verifyAgentRuns.attempt, row.attempt)));
    return { ok: true, runId: row.id, attempt: row.attempt, leaseUntil: leaseUntil.toISOString(), stepsWritten };
  }

  /** 收尾：COMPLETED / INCOMPLETE 必须已有服务端记录的终结动作；FAILED 可在 5 分钟后被再次领取（同一行 attempt + 1，最多 3 次） */
  async complete(binding: RunBinding, runId: string, body: Record<string, unknown>): Promise<AgentRunSummary> {
    const row = await this.requireRun(binding, runId, body["attempt"]);
    const state = body["state"];
    if (state !== "COMPLETED" && state !== "INCOMPLETE" && state !== "FAILED") throw new HttpError(400, "invalid_request", "state must be COMPLETED | INCOMPLETE | FAILED");
    await this.writeSteps(row, body["steps"]);
    const usage = this.mergeUsage(row, body["usage"]) ?? { usageJson: (row.usageJson as Record<string, unknown> | null) ?? { attempts: {}, total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }, total: sanitizeUsage((row.usageJson as { total?: unknown } | null)?.total) };
    const cost = this.prices ? costUsdMicros(usage.total, this.prices) : null;
    const messages = Array.isArray(body["messages"]) ? truncateMessages(body["messages"] as StoredMessage[]).messages : undefined;
    const model = str(body["model"], 100) ?? row.model;
    const promptHash = isBytes32(body["promptHash"]) ? (body["promptHash"] as string) : row.promptHash;
    const nowDate = this.now();
    const fresh = (await this.d.db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.id, row.id)).limit(1))[0]!;
    if (state === "FAILED") {
      const error = body["error"] === undefined ? "model_error" : previewOf(body["error"], 300);
      const [u] = await this.d.db.update(verifyAgentRuns).set({ state: "FAILED", leaseUntil: null, runTokenHash: null, usageJson: usage.usageJson, costUsdMicros: cost, ...(messages ? { messagesJson: messages } : {}), model, promptHash, decisionSummary: clipSummary(`attempt ${row.attempt} failed: ${error}`), updatedAt: nowDate }).where(eq(verifyAgentRuns.id, row.id)).returning();
      log.warn("托管 Agent 轮次失败", { runId, taskId: row.taskId, attempt: row.attempt, error });
      if (row.attempt >= 3) void this.alert("model_unavailable", `run ${runId} (task ${row.taskId}) failed ${row.attempt} times: ${error}`);
      return this.summaryOf(u!, []);
    }
    const action = (fresh.actionJson as RecordedTurnAction | null) ?? null;
    if (!action) throw new HttpError(409, "no_terminal_action", "a COMPLETED / INCOMPLETE run needs exactly one terminal action (submit_trade_intent or report_agent_status) recorded for its turn");
    if (!model || !isBytes32(promptHash)) throw new HttpError(400, "invalid_request", "model and promptHash (bytes32) are required to complete a run");
    const toolCalls = (await this.d.db.select().from(verifyAgentRunSteps).where(and(eq(verifyAgentRunSteps.runId, row.id), eq(verifyAgentRunSteps.kind, "tool"), isNotNull(verifyAgentRunSteps.argsHash), isNotNull(verifyAgentRunSteps.resultHash))).orderBy(asc(verifyAgentRunSteps.attempt), asc(verifyAgentRunSteps.seq))).map((s) => ({ name: s.name ?? "unknown", argsHash: s.argsHash as Bytes32, resultHash: s.resultHash as Bytes32 }));
    const prev = (await this.d.db.select({ runHash: verifyAgentRuns.runHash }).from(verifyAgentRuns).where(and(eq(verifyAgentRuns.taskId, row.taskId), isNotNull(verifyAgentRuns.runHash))).orderBy(desc(verifyAgentRuns.endedAt)).limit(1))[0];
    const decisionSummary = clipSummary(typeof body["decisionSummary"] === "string" && body["decisionSummary"].trim() ? body["decisionSummary"] : `${action.kind} ${action.status}`);
    const nextCheckAt = typeof body["nextCheckAt"] === "string" && Number.isFinite(Date.parse(body["nextCheckAt"])) ? new Date(Date.parse(body["nextCheckAt"])).toISOString() : null;
    const invalidation = typeof body["invalidation"] === "string" && body["invalidation"].trim() ? body["invalidation"].trim().slice(0, 500) : null;
    const actionView = { kind: action.kind, ref: action.ref, status: action.status };
    const hash = runHash({ prevRunHash: (prev?.runHash as Bytes32 | undefined) ?? null, taskId: row.taskId, turnVersion: row.turnVersion, attempt: row.attempt, model, promptHash: promptHash as Bytes32, toolCalls, action: actionView, decisionSummary, nextCheckAt });
    const [u] = await this.d.db
      .update(verifyAgentRuns)
      .set({ state, leaseUntil: null, runTokenHash: null, model, promptHash, usageJson: usage.usageJson, costUsdMicros: cost, ...(messages ? { messagesJson: messages } : {}), decisionSummary, nextCheckAt: nextCheckAt ? new Date(nextCheckAt) : null, invalidation, prevRunHash: prev?.runHash ?? null, runHash: hash, endedAt: nowDate, updatedAt: nowDate })
      .where(and(eq(verifyAgentRuns.id, row.id), eq(verifyAgentRuns.attempt, row.attempt)))
      .returning();
    const task = await this.d.tasks.byId(row.taskId);
    if (task && this.d.notifier) await this.d.notifier.emit(notificationPayload("agent.run_completed", row.taskId, row.turnVersion, `agent turn ${row.turnVersion} ${state}: ${decisionSummary}`.slice(0, 500), `/agent/tasks/${row.taskId}`, nowDate.toISOString()), task.ownerAddress);
    log.info("托管 Agent 轮次完成", { runId, taskId: row.taskId, state, action: `${action.kind}:${action.status}`, costUsdMicros: cost });
    return this.summaryOf(u!, toolCalls);
  }

  summaryOf(r: RunRow, toolCalls: AgentRunSummary["toolCalls"]): AgentRunSummary {
    const total = sanitizeUsage((r.usageJson as { total?: unknown } | null)?.total);
    const a = (r.actionJson as RecordedTurnAction | null) ?? null;
    return {
      runId: r.id,
      taskId: r.taskId,
      turnVersion: r.turnVersion,
      attempt: r.attempt,
      turnReason: r.reason,
      mode: r.mode as "LIVE" | "SIMULATION",
      model: r.model ?? "",
      promptHash: (r.promptHash ?? `0x${"0".repeat(64)}`) as Bytes32,
      startedAt: (r.startedAt ?? r.createdAt).toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      state: r.state as AgentRunState,
      action: a ? { kind: a.kind, ref: a.ref, status: a.status } : null,
      decisionSummary: r.decisionSummary ?? "",
      nextCheckAt: r.nextCheckAt?.toISOString() ?? null,
      invalidation: r.invalidation,
      toolCalls,
      usage: { ...total, costUsdMicros: r.costUsdMicros ?? "0" },
      prevRunHash: (r.prevRunHash as Bytes32 | null) ?? null,
      runHash: (r.runHash ?? `0x${"0".repeat(64)}`) as Bytes32,
    };
  }

  /** 轮次摘要列表（Lane R 的 GET /v1/tasks/:id/runs 与证据包 v3 用；工具调用只给名字与哈希） */
  async listRunSummaries(taskId: string, limit = 50): Promise<AgentRunSummary[]> {
    const rows = await this.d.db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.taskId, taskId)).orderBy(desc(verifyAgentRuns.createdAt)).limit(Math.min(200, limit));
    const out: AgentRunSummary[] = [];
    for (const r of rows) {
      const steps = await this.d.db.select().from(verifyAgentRunSteps).where(and(eq(verifyAgentRunSteps.runId, r.id), eq(verifyAgentRunSteps.kind, "tool"), isNotNull(verifyAgentRunSteps.argsHash), isNotNull(verifyAgentRunSteps.resultHash))).orderBy(asc(verifyAgentRunSteps.attempt), asc(verifyAgentRunSteps.seq));
      out.push(this.summaryOf(r, steps.map((s) => ({ name: s.name ?? "unknown", argsHash: s.argsHash as Bytes32, resultHash: s.resultHash as Bytes32 }))));
    }
    return out;
  }

  async heartbeat(worker: string, body: Record<string, unknown>): Promise<void> {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(worker)) throw new HttpError(400, "invalid_request", "worker must be 1-64 chars [A-Za-z0-9_.:-]");
    const now = this.now();
    await this.d.db
      .insert(verifyAgentWorkers)
      .values({ worker, version: str(body["version"], 40), model: str(body["model"], 100), lastHeartbeatAt: now })
      .onConflictDoUpdate({ target: verifyAgentWorkers.worker, set: { version: str(body["version"], 40), model: str(body["model"], 100), lastHeartbeatAt: now } });
  }

  /** needs_operator（运行态合成用）：最近一轮 FAILED → model_unavailable；今日成本上限 → agent_budget_exhausted */
  async needsOperatorFor(taskId: string): Promise<NeedsOperatorCode[]> {
    const out: NeedsOperatorCode[] = [];
    const last = (await this.d.db.select({ state: verifyAgentRuns.state }).from(verifyAgentRuns).where(eq(verifyAgentRuns.taskId, taskId)).orderBy(desc(verifyAgentRuns.updatedAt)).limit(1))[0];
    if (last?.state === "FAILED") out.push("model_unavailable");
    const day = this.budgetExhausted.get(taskId);
    if (day && day === utcDayStart(this.now()).toISOString()) out.push("agent_budget_exhausted");
    return out;
  }

  /** /healthz 的 agent 段与 /v1/ops/status 用 */
  async status(): Promise<{ enabled: boolean; pricesConfigured: boolean; lastHeartbeatAt: string | null; lastRunAt: string | null; costTodayUsdMicros: string; costTodayLiveUsdMicros: string; costTodaySimUsdMicros: string; runsToday: number; workers: Array<{ worker: string; version: string | null; model: string | null; lastHeartbeatAt: string }>; budgetExhaustedTasks: string[] }> {
    const workers = await this.d.db.select().from(verifyAgentWorkers).orderBy(desc(verifyAgentWorkers.lastHeartbeatAt)).limit(10);
    const lastRun = (await this.d.db.select({ at: verifyAgentRuns.endedAt }).from(verifyAgentRuns).where(isNotNull(verifyAgentRuns.endedAt)).orderBy(desc(verifyAgentRuns.endedAt)).limit(1))[0];
    const cost = await this.costToday();
    const runsToday = (await this.d.db.select({ id: verifyAgentRuns.id }).from(verifyAgentRuns).where(gte(verifyAgentRuns.createdAt, utcDayStart(this.now())))).length;
    return { enabled: this.enabled, pricesConfigured: this.prices !== null, lastHeartbeatAt: workers[0]?.lastHeartbeatAt.toISOString() ?? null, lastRunAt: lastRun?.at?.toISOString() ?? null, costTodayUsdMicros: (cost.live + cost.sim).toString(), costTodayLiveUsdMicros: cost.live.toString(), costTodaySimUsdMicros: cost.sim.toString(), runsToday, workers: workers.map((w) => ({ worker: w.worker, version: w.version, model: w.model, lastHeartbeatAt: w.lastHeartbeatAt.toISOString() })), budgetExhaustedTasks: [...this.budgetExhausted.keys()] };
  }

  /* ================================================================ */
  /* 轮次调度钩子（其它 lane 调用）                                       */
  /* ================================================================ */

  private async hostedRunning(taskId: string): Promise<TaskRow | null> {
    const row = await this.d.tasks.byId(taskId);
    if (!row || row.agentMode !== "hosted" || !TASK_RUNNING_STATUSES.has(row.status as never)) return null;
    return row;
  }
  private async open(taskId: string, reason: AgentTurnReason, summary: string, triggerKey: string): Promise<AgentTurn | null> {
    if (!this.d.cfg.v7.hostedAgent) return null;
    if (!(await this.hostedRunning(taskId))) return null;
    return this.d.tasks.openAgentTurn(taskId, reason, summary, triggerKey);
  }

  /** SIMULATION 托管任务创建时、或运行中任务切换为托管 Agent 时（Lane X 的建任务 / handover 调） */
  onAssigned(taskId: string): Promise<AgentTurn | null> {
    return this.open(taskId, "assigned", "you were assigned to this task: read the context, decide whether to act now, and set your next check", `assigned:${taskId}`);
  }
  /** LIVE 委托任务 buyReady 首次为真（Lane X 调） */
  onAuthorized(taskId: string): Promise<AgentTurn | null> {
    return this.open(taskId, "authorized", "the delegation is complete (buy authorization and allowance in place): you can act inside the signed scope", `authorized:${taskId}`);
  }
  /** 执行作业 EXPIRED / FAILED / REVERTED 且未被自动重签消化（Lane X 的作业终态回调调） */
  onExecutionFailed(taskId: string, info: { jobId: string; intentId?: string | null; errorCode?: string | null; revertClass?: string | null; consecutivePaidFailures?: number; autoRetryPaused?: boolean }): Promise<AgentTurn | null> {
    const paused = info.autoRetryPaused ? `; ${info.consecutivePaidFailures ?? "several"} paid attempts for this step failed in a row, so automatic retries are paused — re-check the quote, allowance and strategy before a new intent` : "";
    return this.open(taskId, "execution_failed", `execution of ${info.intentId ? `intent ${info.intentId}` : `job ${info.jobId}`} failed (${info.revertClass ?? "unknown"}${info.errorCode ? `: ${info.errorCode}` : ""})${paused}; re-evaluate the size or wait — do not resubmit unchanged`, `exec:${info.jobId}`);
  }
  /** 关注事件的实际值入库（Lane D 的变更回调调）：对所有关注该类事件、标的相关的托管运行任务开 data_arrived 轮次 */
  async onEventDataArrived(ev: { id: string; kind: string; name: string; revision: number; underlyingIds: readonly string[] }, revised: { reason: "event"; outcomeRevision: number } | null = null): Promise<string[]> {
    if (!this.d.cfg.v7.hostedAgent) return [];
    const rows = await this.d.db.select().from(verifyTasks).where(and(eq(verifyTasks.agentMode, "hosted"), inArray(verifyTasks.status, [...RUNNING_STATUSES]))).limit(500);
    const opened: string[] = [];
    for (const r of rows) {
      const kinds = ((r.briefJson as TaskBrief | null)?.watch.kinds ?? []) as string[];
      if (!kinds.includes(ev.kind)) continue;
      const scope = scopeOf(r);
      const underlying = (scope?.outputAssetKeys ?? []).map((k) => findEntry(this.d.registry, k)?.underlyingId).filter((u): u is string => !!u);
      if (ev.underlyingIds.length > 0 && !ev.underlyingIds.some((u) => underlying.includes(u))) continue;
      const t = revised
        ? await this.d.tasks.openAgentTurn(r.id, "event", `the official value of ${ev.name} (${ev.kind}) was revised (outcome revision ${revised.outcomeRevision}): re-check your thesis in get_turn_context`, `rev:${ev.id}@${revised.outcomeRevision}`)
        : await this.d.tasks.openAgentTurn(r.id, "data_arrived", `actual value arrived for ${ev.name} (${ev.kind}, rev ${ev.revision}): read it in get_turn_context before deciding`, `data:${ev.id}@${ev.revision}`);
      if (t) opened.push(r.id);
    }
    return opened;
  }
  /**
   * 接上 Lane D 的实际值回调（OutcomeHookRegistry：crowsnest 的 events.outcomeHooks 与财报的 laneD.outcomeHooks）。
   * 首次入库 → data_arrived 轮次；官方修订 → event 轮次（triggerKey 带 outcomeRevision，同一修订不重复开）。只在 cfg.v7.outcomes 开时会被触发。
   */
  attachOutcomeHooks(registry: { set(h: { onDataArrived?: (id: string, info: { revision: number; outcomeRevision: number }) => Promise<void>; onOutcomeRevised?: (id: string, info: { revision: number; outcomeRevision: number }) => Promise<void> }): void }, lookup: (id: string) => Promise<{ id: string; kind: string; name: string; revision: number; underlyingIds: readonly string[] } | null>): void {
    registry.set({
      onDataArrived: async (id) => {
        const ev = await lookup(id);
        if (ev) await this.onEventDataArrived(ev);
      },
      onOutcomeRevised: async (id, info) => {
        const ev = await lookup(id);
        if (ev) await this.onEventDataArrived(ev, { reason: "event", outcomeRevision: info.outcomeRevision });
      },
    });
  }

  /** monitor tick：next_agent_check_at 到点 → scheduled 轮次（观察键 sched:<iso>） */
  async scheduledTick(): Promise<string[]> {
    if (!this.d.cfg.v7.hostedAgent) return [];
    const nowDate = this.now();
    const rows = await this.d.db.select().from(verifyTasks).where(and(eq(verifyTasks.agentMode, "hosted"), inArray(verifyTasks.status, [...RUNNING_STATUSES]), isNotNull(verifyTasks.nextAgentCheckAt), lte(verifyTasks.nextAgentCheckAt, nowDate))).limit(200);
    const opened: string[] = [];
    for (const r of rows) {
      const iso = r.nextAgentCheckAt!.toISOString();
      const t = await this.d.tasks.openAgentTurn(r.id, "scheduled", `your scheduled check (${iso}) is due`, `sched:${iso}`);
      if (t) opened.push(r.id);
      else await this.d.db.update(verifyTasks).set({ nextAgentCheckAt: null }).where(eq(verifyTasks.id, r.id));
    }
    return opened;
  }

  /** 后台：每 30 s 跑一次 scheduledTick（index.ts 启动；关闭开关时不启动） */
  start(intervalMs = 30_000): void {
    if (this.timer || !this.d.cfg.v7.hostedAgent) return;
    this.timer = setInterval(() => {
      this.scheduledTick().catch((err) => log.warn("scheduled 轮次调度失败", { error: err instanceof Error ? err.message : String(err) }));
    }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ================================================================ */
  /* 决策上下文 / 报价 / 记忆                                            */
  /* ================================================================ */

  private static summaryOfEvidence(r: EvidenceRecord): string {
    const p = r.payload as unknown as Record<string, unknown>;
    if (p["kind"] === "market_event") return `${String(p["eventKind"])} ${String(p["eventId"])} rev ${String(p["revision"])}`;
    if (p["kind"] === "market_context") return `market context packaged ${String(p["packagedAt"] ?? "?")}`;
    if (p["kind"] === "okx_quote") return `executable quote ${String(p["fromToken"] ?? "")} → ${String(p["toToken"] ?? "")}`;
    return String(p["kind"] ?? "evidence");
  }

  async agentContext(callerId: string, taskId: string, binding: RunBinding | null): Promise<Record<string, unknown>> {
    const row = await this.d.tasks.requireTask(callerId, taskId, "read");
    const scope = scopeOf(row);
    if (!scope) throw new HttpError(409, "scope_required", "this task has no signed scope (created before CV-D16)");
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const st = await this.d.tasks.taskState(row);
    const base = await this.d.tasks.conditionEvidence(row, st, null);
    await recordTaskEvidence(this.d.db, row.id, "agent_context", base.records, nowDate);
    const label = sessionLabelAtMs(nowMs);
    const turn = (row.agentTurnJson as AgentTurn | null) ?? null;
    const brief = (row.briefJson as TaskBrief | null) ?? null;
    // 预算：LIVE = 当前买入授权的剩余；SIMULATION = 范围本身（不花钱）
    let buyRemainingRaw = scope.budgetCapRaw;
    let buyStepsLeft = Math.max(0, scope.maxSteps - row.stepsConfirmed);
    if (row.mode === "LIVE") {
      const m = await this.d.tasks.currentMandate(row);
      if (m) {
        buyRemainingRaw = (BigInt(m.budgetCap) - BigInt(m.spent)).toString();
        buyStepsLeft = Math.max(0, m.maxSteps - m.stepsDone);
      }
    }
    const extras = (await this.d.providers?.budgetExtras?.(row.id).catch(() => null)) ?? {};
    const positions = (await this.d.providers?.positions?.(row.id).catch(() => null)) ?? [];
    const lastIntentRow = (await this.d.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.taskId, row.id)).orderBy(desc(verifyTaskIntents.createdAt)).limit(1))[0];
    const job = lastIntentRow ? ((await this.d.providers?.jobForIntent?.(lastIntentRow.id).catch(() => null)) ?? null) : null;
    const recent = await this.d.db.select().from(verifyAgentRuns).where(and(eq(verifyAgentRuns.taskId, row.id), isNotNull(verifyAgentRuns.runHash))).orderBy(desc(verifyAgentRuns.endedAt)).limit(5);
    const memory = await this.memoryNotes(row.id);
    const thesisRow = row.thesisId ? await this.d.theses.byId(row.thesisId) : null;
    const card = thesisRow ? this.d.theses.card(thesisRow) : null;
    const events = base.evidence.events
      .map(({ event, evidenceId }) => ({ ev: event as MarketEventV7, evidenceId }))
      .map(({ ev, evidenceId }) => ({ id: ev.id, name: ev.name, kind: ev.kind, scheduledAtUtc: ev.scheduledAtUtc ?? null, dateLocal: ev.dateLocal, status: ev.status, revision: ev.revision, ...(ev.dataStatus ? { dataStatus: ev.dataStatus } : {}), ...(ev.outcome ? { outcome: ev.outcome } : {}), evidenceId }))
      .sort((a, b) => ((a.scheduledAtUtc ?? a.dateLocal) < (b.scheduledAtUtc ?? b.dateLocal) ? -1 : 1))
      .slice(0, 30);
    return {
      now: nowDate.toISOString(),
      session: { label: label === "US_REGULAR" ? "US_REGULAR" : label === "US_PRE" ? "PRE" : label === "US_POST" ? "POST" : "CLOSED", nextOpen: new Date(nextRegularOpenMs(nowMs)).toISOString(), nextClose: new Date(nextRegularCloseMs(nowMs)).toISOString() },
      task: {
        id: row.id,
        mode: row.mode,
        status: row.status,
        objective: scope.objective,
        strategy: brief?.strategy ? { version: brief.strategy.version, text: brief.strategy.text, by: brief.strategy.by } : null,
        currentPlan: brief?.currentPlan?.text ?? null,
        scope: { inputAssetKey: scope.inputAssetKey, outputAssetKeys: scope.outputAssetKeys, budgetCapRaw: scope.budgetCapRaw, perStepCapRaw: scope.perStepCapRaw, maxSteps: scope.maxSteps, deadline: scope.deadline, allowSell: scope.allowSell, trustTier: scope.trustTier, hardConditions: scope.hardConditions },
        assets: [scope.inputAssetKey, ...scope.outputAssetKeys].map((k) => {
          const e = findEntry(this.d.registry, k);
          return { assetKey: k, symbol: e?.displaySymbol ?? null, decimals: e?.tokenDecimals ?? null, role: e?.role ?? null };
        }),
      },
      turn: turn ? { version: turn.version, reason: turn.reason, state: turn.state, summary: turn.summary, requestedAt: turn.requestedAt, blockers: ((row.blockersJson as Blocker[]) ?? []).map((b) => ({ code: b.code, text: b.text, nextCheckAt: b.nextCheckAt, userActionRequired: b.userActionRequired })) } : null,
      ...(binding ? { run: { runId: binding.runId, turnVersion: binding.turnVersion, attempt: binding.attempt, note: binding.turnVersion !== turn?.version ? "a newer turn opened while this run was running; your action is recorded on your own turn version" : undefined } } : {}),
      budget: { buyRemainingRaw, buyStepsLeft, allowanceRaw: extras.allowanceRaw ?? {}, sellReady: extras.sellReady ?? {} },
      positions,
      lastIntent: lastIntentRow ? { id: lastIntentRow.id, status: lastIntentRow.status, kind: lastIntentRow.kind, assetKey: lastIntentRow.assetKey ?? lastIntentRow.outputAssetKey, amountInRaw: lastIntentRow.amountInRaw, createdAt: lastIntentRow.createdAt.toISOString(), job } : null,
      recentRuns: recent.map((r) => ({ at: r.endedAt?.toISOString() ?? null, turnVersion: r.turnVersion, action: (r.actionJson as RecordedTurnAction | null) ? `${(r.actionJson as RecordedTurnAction).kind}:${(r.actionJson as RecordedTurnAction).status}` : null, decisionSummary: r.decisionSummary, nextCheckAt: r.nextCheckAt?.toISOString() ?? null })),
      memory: memory.map((n) => ({ at: n.at, text: n.text })),
      thesis: card ? { id: card.id, status: card.status, premises: card.premises.map((p) => ({ id: p.id, kind: p.kind, text: p.text, status: p.status })) } : null,
      events,
      evidence: base.records.map((r) => ({ evidenceId: r.evidenceId, kind: r.payload.kind, observedAt: observedAtOf(r), summary: AgentRuntime.summaryOfEvidence(r) })),
      notes: { evidence: "evidenceIds above stay citable as platform_fact for 15 minutes (CV-D23)", amounts: "all amounts are raw smallest-unit decimal strings" },
    };
  }

  /** 可执行报价（§2.6）：items ≤ 3；串行 + 30 s 缓存 + 每任务每小时 ≤ 20 次上游取价；不签发、不落授权评估；证据写进 verify_task_evidence */
  async quotes(callerId: string, taskId: string, body: Record<string, unknown>): Promise<{ items: Array<Record<string, unknown>>; quotaRemaining: number }> {
    const row = await this.d.tasks.requireTask(callerId, taskId, "agent_write");
    const scope = scopeOf(row);
    if (!scope) throw new HttpError(409, "scope_required", "this task has no signed scope (created before CV-D16)");
    const items = Array.isArray(body["items"]) ? (body["items"] as Array<Record<string, unknown>>) : null;
    if (!items || items.length === 0 || items.length > QUOTE_MAX_ITEMS) throw new HttpError(400, "invalid_request", `items must be 1-${QUOTE_MAX_ITEMS} quote requests`, [{ field: "items", code: `expected_1_to_${QUOTE_MAX_ITEMS}` }]);
    const parsed: Array<{ side: "buy" | "sell"; assetKey: string; amountInRaw: string }> = [];
    for (const [i, it] of items.entries()) {
      const side = it?.["side"] === "sell" ? "sell" : it?.["side"] === "buy" || it?.["side"] === undefined ? "buy" : null;
      const assetKey = typeof it?.["assetKey"] === "string" ? it["assetKey"].toLowerCase() : "";
      const amountInRaw = typeof it?.["amountInRaw"] === "string" && /^[1-9]\d*$/.test(it["amountInRaw"]) ? it["amountInRaw"] : null;
      if (!side) throw new HttpError(400, "invalid_request", "side must be buy|sell", [{ field: `items[${i}].side`, code: "expected_buy|sell" }]);
      if (!scope.outputAssetKeys.includes(assetKey)) throw new HttpError(400, "invalid_request", "assetKey must be in scope.outputAssetKeys", [{ field: `items[${i}].assetKey`, code: "not_in_scope" }]);
      if (!amountInRaw) throw new HttpError(400, "invalid_request", "amountInRaw must be a positive raw amount", [{ field: `items[${i}].amountInRaw`, code: "expected_positive_raw_amount" }]);
      if (side === "buy" && BigInt(amountInRaw) > BigInt(scope.perStepCapRaw)) throw new HttpError(400, "invalid_request", `amountInRaw exceeds scope.perStepCapRaw ${scope.perStepCapRaw}`, [{ field: `items[${i}].amountInRaw`, code: "exceeds_per_step_cap" }]);
      if (side === "sell") {
        if (!scope.allowSell) throw new HttpError(400, "invalid_request", "scope.allowSell is false", [{ field: `items[${i}].side`, code: "sell_not_allowed" }]);
        const cap = (await this.d.providers?.sellCapRaw?.(row.id, assetKey).catch(() => null)) ?? null;
        if (cap !== null && BigInt(amountInRaw) > BigInt(cap)) throw new HttpError(400, "invalid_request", `amountInRaw exceeds the sell authorization per-step cap ${cap}`, [{ field: `items[${i}].amountInRaw`, code: "exceeds_sell_per_step_cap" }]);
      }
      parsed.push({ side, assetKey, amountInRaw });
    }
    const run = async () => {
      const out: Array<Record<string, unknown>> = [];
      for (const q of parsed) out.push(await this.quoteOne(row, scope, q));
      return out;
    };
    const p = this.quoteChain.then(run, run);
    this.quoteChain = p.catch(() => undefined);
    const out = await p;
    return { items: out, quotaRemaining: Math.max(0, QUOTE_MAX_PER_HOUR - this.recentQuoteCalls(row.id).length) };
  }

  private recentQuoteCalls(taskId: string): number[] {
    const cutoff = this.now().getTime() - 3600_000;
    const list = (this.quoteCalls.get(taskId) ?? []).filter((t) => t > cutoff);
    this.quoteCalls.set(taskId, list);
    return list;
  }

  private async quoteOne(row: TaskRow, scope: TaskScope, q: { side: "buy" | "sell"; assetKey: string; amountInRaw: string }): Promise<Record<string, unknown>> {
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const key = `${row.id}|${q.side}|${q.assetKey}|${q.amountInRaw}`;
    const hit = this.quoteCache.get(key);
    if (hit && nowMs - hit.at < QUOTE_CACHE_MS) return { ...hit.value, cached: true };
    const calls = this.recentQuoteCalls(row.id);
    if (calls.length >= QUOTE_MAX_PER_HOUR) {
      const retry = Math.max(1, Math.ceil((calls[0]! + 3600_000 - nowMs) / 1000));
      throw new HttpError(429, "quote_rate_limited", `at most ${QUOTE_MAX_PER_HOUR} quotes per task per hour`, { retryAfterSeconds: retry });
    }
    calls.push(nowMs);
    const goal = row.goalJson as PlanGoal;
    const pdef = findPolicy(goal.policyId, goal.policyVersion);
    if (!pdef) throw new HttpError(500, "policy_missing");
    const resolved = resolveParams(pdef, { maxSlippageBps: goal.maxSlippageBps, maxPriceImpactBps: goal.maxPriceImpactBps, maxReferenceDeviationBps: goal.policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new HttpError(400, "policy_param_out_of_range");
    const policy = policyWithConditions(pdef, resolved.params, bindingHashOf(row));
    const tol = BigInt(this.d.cfg.SELL_INPUT_TOLERANCE_WEI);
    const routed = q.side === "sell" && BigInt(q.amountInRaw) > tol ? (BigInt(q.amountInRaw) - tol).toString() : q.amountInRaw;
    const job: NormalizedJob = { clientRequestId: `${row.id}:quote:${nowMs}`, ownerAddress: goal.ownerAddress, recipientAddress: goal.recipientAddress, executionChainId: goal.executionChainId, inputAssetKey: q.side === "buy" ? scope.inputAssetKey : q.assetKey, outputAssetKey: q.side === "buy" ? q.assetKey : scope.inputAssetKey, amountInRaw: routed, mode: "exactIn", policyId: goal.policyId, policyVersion: goal.policyVersion, params: policy.params, ...(q.side === "sell" ? { side: "sell" as const } : {}) };
    const nowIso = nowDate.toISOString();
    const collected = await this.d.evidence.collect(job, this.d.registry, nowIso);
    const report: VerifyReport = buildReport({ jobId: row.id, reportVersion: 1, job, policy, registry: this.d.registry, evidence: collected.evidence, evaluatedAt: nowIso });
    await recordTaskEvidence(this.d.db, row.id, "quotes", collected.evidence, nowDate);
    const ref = report.reference;
    const value: Record<string, unknown> = {
      side: q.side,
      assetKey: q.assetKey,
      amountInRaw: q.amountInRaw,
      routedAmountInRaw: routed,
      verdict: report.verdict,
      executionEligible: report.executionEligible,
      executableUsdPerShare: report.normalizedQuote?.executableUsdPerShare ?? null,
      priceImpactBps: report.normalizedQuote?.adverseImpactBps ?? null,
      expectedOutRaw: report.normalizedQuote?.expectedOutRaw ?? null,
      minOutRaw: report.normalizedQuote?.minOutRaw ?? null,
      reference: ref ? { priceUsd: ref.priceUsd, kind: ref.kind, ageS: ref.sourcePublishedAt ? Math.max(0, Math.floor((nowMs - Date.parse(ref.sourcePublishedAt)) / 1000)) : null } : null,
      deviationBps: ref?.deviationBps ?? null,
      session: report.marketSession,
      blockingReasons: report.reasons.filter((r) => r.severity === "block").map((r) => r.code),
      evidenceIds: report.evidenceIds,
      observedAt: nowIso,
      note: "quote only: no certificate was signed and no authorization was evaluated",
    };
    this.quoteCache.set(key, { at: nowMs, value });
    if (this.quoteCache.size > 500) for (const [k, v] of this.quoteCache) if (nowMs - v.at >= QUOTE_CACHE_MS) this.quoteCache.delete(k);
    return { ...value, cached: false };
  }

  async memoryNotes(taskId: string): Promise<MemoryNote[]> {
    const row = (await this.d.db.select().from(verifyAgentMemory).where(eq(verifyAgentMemory.taskId, taskId)).limit(1))[0];
    return ((row?.notesJson as MemoryNote[] | undefined) ?? []).slice();
  }
  async memoryList(callerId: string, taskId: string): Promise<{ taskId: string; notes: MemoryNote[] }> {
    await this.d.tasks.requireTask(callerId, taskId, "read");
    return { taskId, notes: await this.memoryNotes(taskId) };
  }
  /** 任务记忆（≤ 20 条 × 2 KB，先进先出）；按 clientRequestId 去重；不要记录任何密钥或个人信息（文本过密钥扫描） */
  async memoryAdd(callerId: string, taskId: string, body: Record<string, unknown>): Promise<{ taskId: string; note: MemoryNote; duplicate: boolean; dropped: number; notes: number }> {
    const row = await this.d.tasks.requireTask(callerId, taskId, "agent_write");
    const v = validateMemoryText(body["text"]);
    if (!v.ok) throw new HttpError(400, "invalid_request", "memory note text invalid", [{ field: "text", code: v.code }]);
    const crid = typeof body["clientRequestId"] === "string" && /^[A-Za-z0-9_\-:.]{1,128}$/.test(body["clientRequestId"]) ? body["clientRequestId"] : null;
    if (!crid) throw new HttpError(400, "invalid_request", "clientRequestId is required", [{ field: "clientRequestId", code: "required" }]);
    const by: MemoryNote["by"] = callerId === "agent:hosted" ? "agent:hosted" : callerActsFor(callerId, row.ownerAddress) ? "owner" : "agent:byo";
    const now = this.now();
    const note: MemoryNote = { at: now.toISOString(), text: previewOf(v.text), clientRequestId: crid, by };
    const cur = await this.memoryNotes(row.id);
    const r = appendMemory(cur, note);
    if (!r.duplicate) {
      await this.d.db
        .insert(verifyAgentMemory)
        .values({ taskId: row.id, notesJson: r.notes, updatedAt: now })
        .onConflictDoUpdate({ target: verifyAgentMemory.taskId, set: { notesJson: r.notes, updatedAt: now } });
    }
    return { taskId: row.id, note: r.duplicate ? cur.find((n) => n.clientRequestId === crid)! : note, duplicate: r.duplicate, dropped: r.dropped, notes: r.notes.length };
  }
}
