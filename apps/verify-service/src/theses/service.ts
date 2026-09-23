/**
 * 理由卡（C7）：CRUD + 复核项 + 检查记录。只有 owner（同 callerId）/agent 能追加 review-items，且不触发执行。
 * 失效后的三路径（notify / pause_issuance / draft_exit）由 TasksService.applyThesisAction 执行；本服务只判定与落库。
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyTheses, verifyThesisChecks } from "@chaconne/db";
import {
  checkThesis,
  machinePremisesFromConditions,
  thesisStatusOf,
  validateReviewItem,
  validateThesisInput,
  type Condition,
  type ConditionEvidence,
  type TaskConditionState,
  type Premise,
  type PremiseStatus,
  type ThesisCard,
  type ThesisCheckResult,
  type ThesisOnInvalidation,
} from "@chaconne/core/verify";
import { newId } from "../ids";
import { HttpError } from "../jobs/service";

export type ThesisRow = typeof verifyTheses.$inferSelect;

export interface ThesesDeps {
  db: Db;
  now?: () => Date;
}

export class ThesesService {
  private readonly now: () => Date;
  constructor(private readonly d: ThesesDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** 建卡：显式输入（premises 可含 machine/research）+ 由任务条件自动生成的机器前提 */
  async create(a: { id?: string; callerId: string; owner: string; taskId: string; mode: "LIVE" | "SIMULATION"; raw: unknown; conditionsForMachinePremises?: Condition[]; defaultGoal?: string; defaultValidUntil?: string }): Promise<ThesisRow> {
    const nowIso = this.now().toISOString();
    const rawObj = (a.raw ?? {}) as Record<string, unknown>;
    const merged = { goal: rawObj["goal"] ?? a.defaultGoal ?? "", rationale: rawObj["rationale"] ?? "", premises: rawObj["premises"] ?? [], validUntil: rawObj["validUntil"] ?? a.defaultValidUntil, onInvalidation: rawObj["onInvalidation"] ?? "notify" };
    const v = validateThesisInput(merged, a.mode, nowIso);
    if (!v.ok) throw new HttpError(400, "invalid_request", "理由卡校验失败", v.errors);
    const id = a.id ?? newId("ths");
    const explicit: Premise[] = v.input.premises.map((p, i) => (p.kind === "machine" ? { id: `${id}_p${i}`, kind: "machine", text: p.text, condition: p.condition as Condition, status: "unknown", lastCheckedAt: null, evidenceIds: [] } : { id: `${id}_p${i}`, kind: "research", text: p.text, status: "unknown", lastCheckedAt: null, evidenceIds: [], reviewItems: [] }));
    const auto = a.conditionsForMachinePremises ? machinePremisesFromConditions(a.conditionsForMachinePremises, id) : [];
    const premises = [...auto, ...explicit];
    const now = this.now();
    const [row] = await this.d.db
      .insert(verifyTheses)
      .values({ id, taskId: a.taskId, callerId: a.callerId, ownerAddress: a.owner, goal: v.input.goal, rationale: v.input.rationale, premisesJson: premises, validUntil: new Date(v.input.validUntil), onInvalidation: v.input.onInvalidation, status: thesisStatusOf(premises, v.input.validUntil, nowIso), lastCheckedAt: null, createdAt: now, updatedAt: now })
      .returning();
    return row!;
  }

  async byId(id: string): Promise<ThesisRow | null> {
    return (await this.d.db.select().from(verifyTheses).where(eq(verifyTheses.id, id)).limit(1))[0] ?? null;
  }
  async require(callerId: string, id: string): Promise<ThesisRow> {
    const row = await this.byId(id);
    if (!row || row.callerId !== callerId) throw new HttpError(404, "thesis_not_found");
    return row;
  }
  async byTask(taskId: string): Promise<ThesisRow | null> {
    return (await this.d.db.select().from(verifyTheses).where(eq(verifyTheses.taskId, taskId)).orderBy(desc(verifyTheses.createdAt)).limit(1))[0] ?? null;
  }
  async activeByOwner(): Promise<ThesisRow[]> {
    return this.d.db.select().from(verifyTheses).where(and(eq(verifyTheses.status, "holds")));
  }

  card(row: ThesisRow): ThesisCard {
    return { id: row.id, taskId: row.taskId, goal: row.goal, rationale: row.rationale, premises: row.premisesJson as Premise[], validUntil: row.validUntil.toISOString(), onInvalidation: row.onInvalidation as ThesisOnInvalidation, status: row.status as ThesisCard["status"] };
  }

  async view(row: ThesisRow) {
    const checks = await this.d.db.select().from(verifyThesisChecks).where(eq(verifyThesisChecks.thesisId, row.id)).orderBy(desc(verifyThesisChecks.checkedAt)).limit(20);
    const card = this.card(row);
    return {
      ...card,
      owner: row.ownerAddress,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      researchPending: card.premises.filter((p) => p.kind === "research" && p.status === "unknown").length,
      checks: checks.map((c) => ({ checkedAt: c.checkedAt.toISOString(), status: c.status, actionTaken: c.actionTaken, evidenceIds: c.evidenceIds })),
      note: "Machine premises are re-checked by the monitor against signed context; research premises stay 'unknown' until the owner marks them. Adding review items never triggers execution.",
    };
  }

  /** 追加复核项（只 owner/agent；sourceUrl 必填；不触发执行） */
  async addReviewItem(callerId: string, id: string, raw: unknown, addedBy: "agent" | "user"): Promise<ThesisRow> {
    const row = await this.require(callerId, id);
    const o = (raw ?? {}) as Record<string, unknown>;
    const premiseId = typeof o["premiseId"] === "string" ? o["premiseId"] : null;
    const v = validateReviewItem(o, addedBy, this.now().toISOString());
    if (!v.ok) throw new HttpError(400, "invalid_request", "复核项校验失败", v.errors);
    const premises = (row.premisesJson as Premise[]).map((p) => ({ ...p }));
    const target = premiseId ? premises.find((p) => p.id === premiseId) : premises.find((p) => p.kind === "research");
    if (!target) throw new HttpError(404, "premise_not_found", "没有可挂复核项的 research 前提");
    if (target.kind !== "research") throw new HttpError(409, "premise_not_research", "复核项只能挂在 research 前提上（机器前提由条件求值决定）");
    target.reviewItems = [...(target.reviewItems ?? []), v.item].slice(-50);
    const [updated] = await this.d.db.update(verifyTheses).set({ premisesJson: premises, updatedAt: this.now() }).where(eq(verifyTheses.id, id)).returning();
    return updated!;
  }

  /** 用户标记 research 前提（holds / invalidated / unknown）；机器前提不可手改 */
  async markPremise(callerId: string, id: string, premiseId: string, status: PremiseStatus): Promise<{ row: ThesisRow; newlyInvalidated: boolean }> {
    const row = await this.require(callerId, id);
    if (status !== "holds" && status !== "invalidated" && status !== "unknown") throw new HttpError(400, "invalid_request", "status 只能是 holds|invalidated|unknown");
    const premises = (row.premisesJson as Premise[]).map((p) => ({ ...p }));
    const target = premises.find((p) => p.id === premiseId);
    if (!target) throw new HttpError(404, "premise_not_found");
    if (target.kind !== "research") throw new HttpError(409, "premise_not_research", "机器前提由条件求值决定，不能手动标记");
    const was = target.status;
    target.status = status;
    target.lastCheckedAt = this.now().toISOString();
    const [updated] = await this.d.db.update(verifyTheses).set({ premisesJson: premises, updatedAt: this.now() }).where(eq(verifyTheses.id, id)).returning();
    return { row: updated!, newlyInvalidated: status === "invalidated" && was !== "invalidated" };
  }

  async renew(callerId: string, id: string, validUntilRaw: unknown): Promise<ThesisRow> {
    const row = await this.require(callerId, id);
    const nowIso = this.now().toISOString();
    if (typeof validUntilRaw !== "string" || Number.isNaN(Date.parse(validUntilRaw)) || Date.parse(validUntilRaw) <= Date.parse(nowIso)) throw new HttpError(400, "invalid_request", "validUntil 必须是未来的 ISO 时间");
    const premises = row.premisesJson as Premise[];
    const validUntil = new Date(Date.parse(validUntilRaw)).toISOString();
    const [updated] = await this.d.db.update(verifyTheses).set({ validUntil: new Date(validUntil), status: thesisStatusOf(premises, validUntil, nowIso), updatedAt: this.now() }).where(eq(verifyTheses.id, id)).returning();
    return updated!;
  }

  async end(callerId: string, id: string): Promise<ThesisRow> {
    await this.require(callerId, id);
    const now = this.now();
    // validUntil 严格早于 now：后续重评按 thesisStatusOf 仍判 expired
    const [updated] = await this.d.db.update(verifyTheses).set({ validUntil: new Date(now.getTime() - 1000), status: "expired", updatedAt: now }).where(eq(verifyTheses.id, id)).returning();
    return updated!;
  }

  /** 重评机器前提并落检查记录；返回核心判定（动作由 TasksService 执行） */
  async runCheck(row: ThesisRow, evidence: ConditionEvidence, taskState: TaskConditionState, actionTaken: string | null = null): Promise<{ result: ThesisCheckResult; row: ThesisRow }> {
    const nowIso = this.now().toISOString();
    const result = checkThesis(this.card(row), evidence, taskState, nowIso);
    const [updated] = await this.d.db.update(verifyTheses).set({ premisesJson: result.card.premises, status: result.card.status, lastCheckedAt: new Date(nowIso), updatedAt: new Date(nowIso) }).where(eq(verifyTheses.id, row.id)).returning();
    await this.d.db.insert(verifyThesisChecks).values({ thesisId: row.id, checkedAt: new Date(nowIso), status: result.card.status, premisesJson: result.card.premises, actionTaken, evidenceIds: result.evidenceIds });
    return { result, row: updated! };
  }

  async recordAction(thesisId: string, action: string): Promise<void> {
    const last = (await this.d.db.select().from(verifyThesisChecks).where(eq(verifyThesisChecks.thesisId, thesisId)).orderBy(desc(verifyThesisChecks.checkedAt)).limit(1))[0];
    if (last) await this.d.db.update(verifyThesisChecks).set({ actionTaken: action }).where(eq(verifyThesisChecks.id, last.id));
  }

  async checks(thesisId: string) {
    return this.d.db.select().from(verifyThesisChecks).where(eq(verifyThesisChecks.thesisId, thesisId)).orderBy(asc(verifyThesisChecks.checkedAt));
  }
}
