/**
 * Lane E · 决策实验服务（C9）：
 *  - GET  /v1/tasks/:id/explain-wait      等待诊断（owner 鉴权；全部阻塞项）
 *  - POST /v1/tasks/:id/compare-policies  同输入对照（固定快照；SIMULATION；不写授权、不改真实任务）
 *  - POST /v1/replays · GET /v1/replays/:id  决策回放（无前视；缺口如实；不输出收益）
 * 条件求值与任务读取都是注入的（Lane B 合并后替换）。
 */
import { PLAYBOOK_IDS, buildEvidenceSnapshot, comparePolicies, conditionSetHash, explainWait, findEntry, runReplay, type AssetRegistry, type Condition, type ConditionEvaluator, type ConditionEvidenceInput, type ConditionSet, type ConditionTaskState, type EvidenceSnapshot, type LabLocale, type LabTaskRecord, type PlaybookId, type TaskReader } from "@chaconne/core/verify";
import type { Db } from "@chaconne/db";
import type { VerifyConfig } from "../config";
import { HttpError } from "../jobs/service";
import { newId } from "../ids";
import type { ReplayArchiveReader } from "./archive";
import { LabStore } from "./store";
import { plannerFromSnapshot } from "./planner";

export interface LabDeps {
  db: Db;
  cfg: VerifyConfig;
  registry: AssetRegistry;
  evaluator: ConditionEvaluator;
  taskReader: TaskReader;
  archive: ReplayArchiveReader;
  now?: () => Date;
}

const CONDITION_TYPES = new Set<string>(["session", "avoid_event_window", "earnings_window", "not_in_fed_blackout", "max_vix", "max_move", "premium_bps_lte", "min_gap_trading_days", "max_steps_per_trading_day", "require_cross_asset_confirmation", "target_price_gte", "target_price_lte", "tracked_cost_pnl_pct_gte", "cash_floor", "thesis_holds"]);
const EMPTY_STATE: ConditionTaskState = { lastConfirmedStepAt: null, stepsConfirmedToday: 0, stepsConfirmed: 0 };
const EMPTY_EVIDENCE: ConditionEvidenceInput = { records: [], context: null, events: [] };
/** 回放区间上限：31 天 */
const REPLAY_MAX_RANGE_MS = 31 * 86_400_000;
const REPLAY_MAX_POINTS = 2000;

export class LabService {
  readonly store: LabStore;
  private readonly now: () => Date;
  constructor(private readonly d: LabDeps) {
    this.store = new LabStore(d.db);
    this.now = d.now ?? (() => new Date());
  }

  get evaluatorId(): string {
    return this.d.evaluator.id;
  }

  /* ---------- 鉴权：callerId 相同，或调用方是 web:<owner> 且地址等于任务 owner ---------- */
  private ownerFromCaller(callerId: string): string | null {
    const m = callerId.match(/(0x[0-9a-f]{40})$/);
    return m ? m[1]! : null;
  }
  private async requireTask(callerId: string, taskId: string): Promise<LabTaskRecord> {
    const rec = await this.d.taskReader.readTask(taskId);
    if (!rec) throw new HttpError(404, "task_not_found", "任务不存在（或 Lane B 任务表尚未接入）");
    const owner = this.ownerFromCaller(callerId);
    const allowed = rec.callerId === callerId || (owner !== null && owner === rec.task.owner.toLowerCase());
    if (!allowed) throw new HttpError(403, "forbidden", "只有任务 owner 可读取等待诊断与对照");
    return rec;
  }

  private static locale(v: unknown): LabLocale {
    return v === "zh" ? "zh" : "en";
  }

  /* ---------- 条件集合校验（只校验形态；语义由求值器决定） ---------- */
  private parseConditionSet(raw: unknown, field: string): ConditionSet {
    const b = (raw ?? {}) as Record<string, unknown>;
    const items = Array.isArray(b["items"]) ? (b["items"] as unknown[]) : null;
    if (!items || items.length === 0 || items.length > 12) throw new HttpError(400, "invalid_request", `${field}.items 需为 1–12 个条件`, [{ field: `${field}.items`, code: "expected_1_to_12" }]);
    for (const it of items) {
      const o = (it ?? {}) as Record<string, unknown>;
      if (typeof o["type"] !== "string" || !CONDITION_TYPES.has(o["type"])) throw new HttpError(400, "invalid_request", `${field}.items 含未知条件类型`, [{ field: `${field}.items.type`, code: "unknown_condition_type" }]);
    }
    const typed = items as Condition[];
    const hash = conditionSetHash(typed);
    if (typeof b["hash"] === "string" && b["hash"] !== hash) throw new HttpError(400, "invalid_request", `${field}.hash 与 items 不一致（应为 keccak256(canonical({version, items}))）`, [{ field: `${field}.hash`, code: "hash_mismatch", expected: hash }]);
    return { version: "conditions/1", items: typed, hash };
  }

  private snapshotOf(rec: LabTaskRecord): { snapshot: EvidenceSnapshot; evaluatedAt: string } | null {
    if (!rec.latestEvaluation) return null;
    const at = rec.latestEvaluation.evaluatedAt;
    return { snapshot: buildEvidenceSnapshot(rec.task.id, at, rec.latestEvaluation.evidence), evaluatedAt: at };
  }

  /* ---------- 等待诊断 ---------- */
  async explainWait(callerId: string, taskId: string, localeRaw: unknown) {
    const rec = await this.requireTask(callerId, taskId);
    const locale = LabService.locale(localeRaw);
    const state = rec.taskState ?? EMPTY_STATE;
    const nowIso = this.now().toISOString();
    const evidence = rec.latestEvaluation?.evidence ?? EMPTY_EVIDENCE;
    const evaluation = rec.latestEvaluation?.evaluation ?? this.d.evaluator.evaluate(rec.task.conditions, evidence, state, rec.latestEvaluation?.evaluatedAt ?? nowIso);
    const explained = explainWait(evaluation, evidence, locale);
    return {
      taskId: rec.task.id,
      status: rec.task.status,
      playbookId: rec.task.playbookId,
      conditionsHash: rec.task.conditions.hash,
      executorPresence: rec.task.executorPresence,
      /** latest_evaluation = 展开上次评估；evaluated_now = 没有落库评估，用现有证据现算（可能全是证据不足） */
      source: rec.latestEvaluation?.evaluation ? "latest_evaluation" : "evaluated_now",
      evaluatorId: rec.latestEvaluation?.evaluation ? "task" : this.d.evaluator.id,
      evidenceSnapshotId: this.snapshotOf(rec)?.snapshot.id ?? null,
      /** CV-D13：评估用的上下文来源模式；backfill / sample 不得当 LIVE */
      contextProvenance: evidence.context?.provenance?.mode ?? null,
      ...explained,
      locale,
    };
  }

  /* ---------- 同输入对照 ---------- */
  async comparePolicies(callerId: string, taskId: string, raw: unknown) {
    const rec = await this.requireTask(callerId, taskId);
    const b = (raw ?? {}) as Record<string, unknown>;
    const vs = Array.isArray(b["variants"]) ? (b["variants"] as unknown[]) : [];
    if (vs.length !== 2) throw new HttpError(400, "invalid_request", "双策略对照需要恰好两套 variants", [{ field: "variants", code: "expected_exactly_2" }]);
    const variants = vs.map((v, i) => {
      const o = (v ?? {}) as Record<string, unknown>;
      const label = typeof o["label"] === "string" && o["label"].trim() ? o["label"].trim().slice(0, 32) : i === 0 ? "A" : "B";
      return { label, conditions: this.parseConditionSet(o["conditions"], `variants[${i}].conditions`) };
    }) as [{ label: string; conditions: ConditionSet }, { label: string; conditions: ConditionSet }];
    if (variants[0].label === variants[1].label) variants[1].label = `${variants[1].label}'`;
    const snap = this.snapshotOf(rec);
    if (!snap) throw new HttpError(409, "no_evaluation_yet", "任务还没有落库的评估证据，无法固定同一快照；等 monitor 评估一次后再对照");
    const goal = rec.goal;
    const registry = this.d.registry;
    const result = comparePolicies({
      taskId: rec.task.id,
      snapshot: snap.snapshot,
      variants,
      evaluator: this.d.evaluator,
      taskState: rec.taskState ?? EMPTY_STATE,
      goal,
      planner: goal ? () => plannerFromSnapshot(goal, registry, snap.snapshot) : undefined,
    });
    const row = await this.store.saveComparison({
      id: result.comparison.id,
      callerId,
      ownerAddress: rec.task.owner.toLowerCase(),
      taskId: rec.task.id,
      evidenceSnapshotId: snap.snapshot.id,
      snapshotHash: snap.snapshot.hash,
      comparisonJson: result.comparison,
      resultJson: result,
      evaluatorId: this.d.evaluator.id,
      mode: "SIMULATION",
      createdAt: this.now(),
    });
    return {
      comparisonId: row.id,
      ...result,
      snapshot: {
        id: snap.snapshot.id,
        takenAt: snap.snapshot.takenAt,
        hash: snap.snapshot.hash,
        evidenceIds: snap.snapshot.records.map((r) => r.evidenceId),
        contextPackagedAt: snap.snapshot.context?.packagedAt ?? null,
        eventVersions: snap.snapshot.events.map((e) => ({ id: e.id, revision: e.revision, firstKnownAt: e.firstKnownAt })),
      },
      /** 真实任务原样：对照不改它 */
      task: { id: rec.task.id, status: rec.task.status, conditionsHash: rec.task.conditions.hash, mandateIds: rec.task.mandateIds },
      note: {
        en: "Simulation on a fixed evidence snapshot: both rule sets saw exactly the same evidence, context and event versions. No authorization was written and the real task is unchanged.",
        zh: "固定证据快照上的模拟：两套规则看到的是完全相同的证据、上下文与事件版本。没有写任何授权，真实任务未改动。",
      },
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ---------- 回放 ---------- */
  async createReplay(callerId: string, raw: unknown) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const errors: Array<{ field: string; code: string }> = [];
    const playbookId = typeof b["playbookId"] === "string" && (PLAYBOOK_IDS as readonly string[]).includes(b["playbookId"]) ? (b["playbookId"] as PlaybookId) : null;
    if (!playbookId) errors.push({ field: "playbookId", code: "unknown_playbook" });
    const assetKey = typeof b["assetKey"] === "string" ? b["assetKey"].toLowerCase() : "";
    const entry = assetKey ? findEntry(this.d.registry, assetKey) : undefined;
    if (!entry) errors.push({ field: "assetKey", code: "asset_unsupported" });
    const from = typeof b["from"] === "string" && Number.isFinite(Date.parse(b["from"])) ? new Date(Date.parse(b["from"])).toISOString() : null;
    const to = typeof b["to"] === "string" && Number.isFinite(Date.parse(b["to"])) ? new Date(Date.parse(b["to"])).toISOString() : null;
    if (!from || !to || from >= to) errors.push({ field: "from/to", code: "invalid_range" });
    else if (Date.parse(to) - Date.parse(from) > REPLAY_MAX_RANGE_MS) errors.push({ field: "from/to", code: "range_over_31_days" });
    const nowIso = this.now().toISOString();
    if (to && to > nowIso) errors.push({ field: "to", code: "in_the_future" });
    const stepMinutes = b["stepMinutes"] === undefined ? 60 : Number(b["stepMinutes"]);
    if (!Number.isInteger(stepMinutes) || stepMinutes < 5 || stepMinutes > 24 * 60) errors.push({ field: "stepMinutes", code: "expected_5_to_1440" });
    if (from && to && Number.isInteger(stepMinutes) && stepMinutes > 0 && (Date.parse(to) - Date.parse(from)) / (stepMinutes * 60_000) > REPLAY_MAX_POINTS) errors.push({ field: "stepMinutes", code: "too_many_points" });
    if (errors.length > 0) throw new HttpError(400, "invalid_request", "回放参数校验失败", errors);
    const conditions = this.parseConditionSet(b["conditions"], "conditions");
    const owner = this.ownerFromCaller(callerId) ?? (typeof b["ownerAddress"] === "string" && /^0x[0-9a-fA-F]{40}$/.test(b["ownerAddress"]) ? b["ownerAddress"].toLowerCase() : null);
    const taskState: ConditionTaskState = EMPTY_STATE;
    const archive = await this.d.archive.read({ entry: entry!, from: from!, to: to! });
    const id = newId("rpl");
    // CV-D13：sample 上下文只在 fixture 模式（联调）可用；生产/LIVE 证据模式下一律排除
    const allowSample = this.d.cfg.EVIDENCE_MODE === "fixture" && !this.d.cfg.isProd;
    const result = runReplay({ id, playbookId: playbookId!, conditions, assetKey: entry!.assetKey, from: from!, to: to!, stepMinutes, archive, evaluator: this.d.evaluator, taskState, locale: LabService.locale(b["locale"]), maxPoints: REPLAY_MAX_POINTS, allowSample });
    const row = await this.store.saveReplay({ id, callerId, ownerAddress: owner, assetKey: entry!.assetKey, playbookId: playbookId!, conditionsHash: conditions.hash, fromAt: new Date(from!), toAt: new Date(to!), runJson: result.run, resultJson: result, evaluatorId: this.d.evaluator.id, mode: "REPLAY", createdAt: this.now() });
    return this.replayView(row, result);
  }

  async getReplay(callerId: string, id: string) {
    const row = await this.store.getReplay(id);
    if (!row || row.callerId !== callerId) throw new HttpError(404, "replay_not_found");
    return this.replayView(row, row.resultJson as ReturnType<typeof runReplay>);
  }

  private replayView(row: { id: string; createdAt: Date; evaluatorId: string }, result: ReturnType<typeof runReplay>) {
    return { replayId: row.id, ...result, evaluatorId: row.evaluatorId, createdAt: row.createdAt.toISOString() };
  }
}
