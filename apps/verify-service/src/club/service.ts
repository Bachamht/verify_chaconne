/**
 * Chaconne Club 后端最小集（W6，D-082）：模拟任务 / 角色 / 翻创模板 / 战报公开。
 * 硬性原则：角色与文案不改变任何规则或授权（C-01：同输入不同角色 → 报告哈希相同）；模拟不签证书不执行；分享默认私密。
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyJobs, verifyProfiles, verifyShares, verifySimulations, verifyTemplates } from "@chaconne/db";
import { PERSONA_IDS, type AssetRegistry, type NormalizedJob, type PersonaId, type PlanGoal, type PlanReport, type Profile, type SharePrivacy, type ShareStatus, type VerifyReport } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { EvidenceProvider } from "../evidence/provider";
import { newId } from "../ids";
import { HttpError, type VerifyService } from "../jobs/service";
import type { MandatesService } from "../mandates/service";
import type { Orders } from "../payments/orders";
import type { PlanEngine } from "../plans/engine";
import type { PlansService } from "../plans/service";
import { validatePlanGoal } from "../plans/validate";

export interface ClubDeps {
  db: Db;
  cfg: VerifyConfig;
  registry: AssetRegistry;
  evidence: EvidenceProvider;
  engine: PlanEngine;
  jobs: VerifyService;
  plans: PlansService;
  mandates: MandatesService;
  orders: Orders;
  now?: () => Date;
}

export type ShareKind = "job" | "mandate" | "simulation" | "plan";


export class ClubService {
  private readonly now: () => Date;
  constructor(private readonly d: ClubDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** 从 callerId（web:<addr> / a2mcp:owner:<addr>）或请求体取 owner 地址 */
  ownerOf(callerId: string, bodyOwner?: unknown): string {
    const m = callerId.match(/(0x[0-9a-f]{40})$/);
    if (m) return m[1]!;
    if (typeof bodyOwner === "string" && /^0x[0-9a-fA-F]{40}$/.test(bodyOwner)) return bodyOwner.toLowerCase();
    throw new HttpError(400, "owner_required", "该调用方需要在请求体给出 ownerAddress");
  }

  /* ---------- 模拟（C-04） ---------- */

  async simulate(callerId: string, raw: unknown) {
    // 两种请求形态都收：网页/接口文档 §10.10 是 {goal:{…}, personaId, presetId, clientRequestId}，MCP 是目标字段平铺
    const r = (raw ?? {}) as Record<string, unknown>;
    const nested = r["goal"] && typeof r["goal"] === "object" ? (r["goal"] as Record<string, unknown>) : null;
    const b: Record<string, unknown> = nested ? { ...nested, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "goal")) } : r;
    const owner = this.ownerOf(callerId, b["ownerAddress"]);
    const personaId = PERSONA_IDS.includes(b["personaId"] as PersonaId) ? (b["personaId"] as PersonaId) : null;
    const v = validatePlanGoal({ ...b, ownerAddress: owner, clientRequestId: typeof b["clientRequestId"] === "string" ? b["clientRequestId"] : `sim-${Date.now()}`, deadline: typeof b["deadline"] === "string" ? b["deadline"] : new Date(this.now().getTime() + 3600_000).toISOString() }, this.d.cfg.EXECUTION_CHAIN_ID);
    if (!v.ok) throw new HttpError(400, "invalid_request", "模拟目标校验失败", v.errors);
    const nowDate = this.now();
    const simId = newId("sim");
    const result = await this.d.engine.plan(v.goal, { registry: this.d.registry, evidence: this.d.evidence, nowIso: nowDate.toISOString(), planId: simId });
    const [row] = await this.d.db
      .insert(verifySimulations)
      .values({ id: simId, callerId, ownerAddress: owner, personaId, goalJson: v.goal, planJson: result.report, planHash: result.report.planHash, evidenceMode: this.d.evidence.mode, createdAt: nowDate })
      .returning();
    return this.simulationView(row!, result.report);
  }

  async requireSimulation(callerId: string, id: string) {
    const row = (await this.d.db.select().from(verifySimulations).where(eq(verifySimulations.id, id)).limit(1))[0];
    if (!row || row.callerId !== callerId) throw new HttpError(404, "simulation_not_found");
    return this.simulationView(row, row.planJson as PlanReport);
  }

  private simulationView(row: typeof verifySimulations.$inferSelect, plan: PlanReport) {
    const rec = plan.candidates.find((c) => c.candidateId === plan.recommended) ?? null;
    const verdict = rec ? rec.chosenPolicyVerdict : plan.candidates.some((c) => c.chosenPolicyVerdict === "limited") ? "limited" : "rejected";
    return {
      simulationId: row.id,
      verdict,
      recommended: plan.recommended,
      mode: "SIMULATION" as const,
      underlyingEvidenceMode: row.evidenceMode,
      personaId: row.personaId,
      goal: row.goalJson as PlanGoal,
      plan,
      planHash: row.planHash,
      certificatesIssued: 0,
      executions: [],
      note: "Simulation: planning and rules ran on real evidence; no certificate was signed and nothing was executed.",
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ---------- 角色 ---------- */

  async getProfile(callerId: string, bodyOwner?: unknown): Promise<Profile | null> {
    const owner = this.ownerOf(callerId, bodyOwner);
    const row = (await this.d.db.select().from(verifyProfiles).where(eq(verifyProfiles.ownerAddress, owner)).limit(1))[0];
    return row ? { ownerAddress: owner as `0x${string}`, personaId: row.personaId as PersonaId, name: row.name, tone: row.tone as Profile["tone"] } : null;
  }

  async putProfile(callerId: string, raw: unknown): Promise<Profile> {
    const b = (raw ?? {}) as Record<string, unknown>;
    const owner = this.ownerOf(callerId, b["ownerAddress"]);
    const personaId = b["personaId"];
    const name = typeof b["name"] === "string" ? b["name"].trim().slice(0, 32) : "";
    const tone = b["tone"];
    const errors: Array<{ field: string; code: string }> = [];
    if (!PERSONA_IDS.includes(personaId as PersonaId)) errors.push({ field: "personaId", code: `expected one of ${PERSONA_IDS.join("|")}` });
    if (!name) errors.push({ field: "name", code: "required" });
    if (tone !== "calm" && tone !== "playful" && tone !== "terse") errors.push({ field: "tone", code: "expected calm|playful|terse" });
    if (errors.length) throw new HttpError(400, "invalid_request", "角色校验失败", errors);
    const now = this.now();
    await this.d.db
      .insert(verifyProfiles)
      .values({ ownerAddress: owner, personaId: personaId as string, name, tone: tone as string, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: verifyProfiles.ownerAddress, set: { personaId: personaId as string, name, tone: tone as string, updatedAt: now } });
    return { ownerAddress: owner as `0x${string}`, personaId: personaId as PersonaId, name, tone: tone as Profile["tone"] };
  }

  /* ---------- 翻创模板（C-03）：只含结构，不含金额/钱包/旧报价/旧授权 ---------- */

  async createTemplate(callerId: string, raw: unknown) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const kind = b["kind"] === "plan" ? "plan" : b["kind"] === "job" ? "job" : null;
    // 网页发的是 refId（与 /v1/shares 一致），MCP 发 from：两个都收
    const from = typeof b["from"] === "string" ? b["from"] : typeof b["refId"] === "string" ? b["refId"] : "";
    if (!kind || !from) throw new HttpError(400, "invalid_request", "需要 kind (job|plan) 与 from / refId (id)");
    // 作者：调用方身份或请求体里有地址就用；都没有（共享 web 调用方）则取被翻创对象的 owner
    const authorHint = /(0x[0-9a-f]{40})$/.test(callerId) || typeof b["ownerAddress"] === "string" ? b["ownerAddress"] : await this.ownerOfRef(callerId, kind, from);
    const author = this.ownerOf(callerId, authorHint);
    const profile = await this.getProfile(callerId, authorHint).catch(() => null);
    let template: Record<string, unknown>;
    if (kind === "job") {
      const job = await this.d.jobs.requireJob(callerId, from);
      const j = job.jobJson as NormalizedJob;
      template = { kind, inputAssetKey: j.inputAssetKey, outputAssetKey: j.outputAssetKey, policyId: j.policyId, policyVersion: j.policyVersion, params: j.params, side: j.side ?? "buy" };
    } else {
      const plan = await this.d.plans.requirePlan(callerId, from);
      const g = plan.goalJson as PlanGoal;
      template = { kind, legs: g.legs, inputAssetKeys: g.budget.inputAssetKeys, side: g.side, policyId: g.policyId, policyVersion: g.policyVersion, maxSlippageBps: g.maxSlippageBps, maxPriceImpactBps: g.maxPriceImpactBps, ...(g.maxReferenceDeviationBps !== undefined ? { maxReferenceDeviationBps: g.maxReferenceDeviationBps } : {}), ...(g.ladderBps ? { ladderBps: g.ladderBps } : {}) };
    }
    const now = this.now();
    const [row] = await this.d.db.insert(verifyTemplates).values({ id: newId("tpl"), authorAddress: author, authorName: profile?.name ?? null, kind, templateJson: template, createdAt: now }).returning();
    return this.templateView(row!);
  }

  async getTemplate(id: string) {
    const row = (await this.d.db.select().from(verifyTemplates).where(eq(verifyTemplates.id, id)).limit(1))[0];
    if (!row) throw new HttpError(404, "template_not_found");
    return this.templateView(row);
  }

  private templateView(row: typeof verifyTemplates.$inferSelect) {
    return { templateId: row.id, kind: row.kind, author: { name: row.authorName ?? "anonymous" }, template: row.templateJson, createdAt: row.createdAt.toISOString() };
  }

  /* ---------- 战报公开（C-02 / C-06） ---------- */

  async setShare(callerId: string, raw: unknown) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const kind = (["job", "mandate", "simulation", "plan"] as const).find((k) => k === b["kind"]);
    const refId = typeof b["refId"] === "string" ? b["refId"] : "";
    if (!kind || !refId) throw new HttpError(400, "invalid_request", "需要 kind 与 refId");
    const owner = await this.ownerOfRef(callerId, kind, refId);
    const isPublic = b["public"] === true;
    const p = (b["privacy"] ?? {}) as Record<string, unknown>;
    const privacy: SharePrivacy = { amounts: p["amounts"] === "exact" ? "exact" : p["amounts"] === "hidden" ? "hidden" : "range", wallet: "hidden" };
    const title = typeof b["title"] === "string" ? b["title"].trim().slice(0, 120) : null;
    const now = this.now();
    const existing = (await this.d.db.select().from(verifyShares).where(and(eq(verifyShares.kind, kind), eq(verifyShares.refId, refId))).limit(1))[0];
    const shareId = existing?.shareId ?? newId("shr");
    const stored = { ...privacy, ...(title ? { title } : {}) };
    if (existing) await this.d.db.update(verifyShares).set({ public: isPublic, privacyJson: stored, updatedAt: now }).where(eq(verifyShares.shareId, shareId));
    else await this.d.db.insert(verifyShares).values({ shareId, callerId, ownerAddress: owner, kind, refId, privacyJson: stored, public: isPublic, createdAt: now, updatedAt: now });
    return { shareId, kind, refId, public: isPublic, privacy, title, publicUrl: isPublic ? `/pub/reports/${shareId}` : null };
  }

  private async ownerOfRef(callerId: string, kind: ShareKind, refId: string): Promise<string> {
    if (kind === "job") return (await this.d.jobs.requireJob(callerId, refId)).ownerAddress;
    if (kind === "plan") return (await this.d.plans.requirePlan(callerId, refId)).ownerAddress;
    if (kind === "mandate") return (await this.d.mandates.requireMandate(callerId, refId)).ownerAddress;
    const row = (await this.d.db.select().from(verifySimulations).where(eq(verifySimulations.id, refId)).limit(1))[0];
    if (!row || row.callerId !== callerId) throw new HttpError(404, "simulation_not_found");
    return row.ownerAddress;
  }

  /** 公开分享行（只返回 public=true 的）；/pub/reports/:shareId/bundle 用它找到 kind/refId/callerId（V-39） */
  async publicShareRow(shareId: string) {
    const share = (await this.d.db.select().from(verifyShares).where(eq(verifyShares.shareId, shareId)).limit(1))[0];
    if (!share || !share.public) throw new HttpError(404, "share_not_found");
    return share;
  }

  /** 公开读取：只返回 public=true 的，经隐私过滤 */
  async publicReport(shareId: string) {
    const share = await this.publicShareRow(shareId);
    const stored = share.privacyJson as SharePrivacy & { title?: string };
    const privacy: SharePrivacy = { amounts: stored.amounts, wallet: "hidden" };
    const title = stored.title ?? null;
    const profile = (await this.d.db.select().from(verifyProfiles).where(eq(verifyProfiles.ownerAddress, share.ownerAddress)).limit(1))[0];
    const persona = profile ? { personaId: profile.personaId, name: profile.name, tone: profile.tone } : null;
    const amount = (raw: string, decimals: number) => (privacy.amounts === "exact" ? raw : privacy.amounts === "hidden" ? null : rangeOf(raw, decimals));
    const base = { shareId, kind: share.kind, persona, privacy, title, createdAt: share.createdAt.toISOString(), templateId: null as string | null, evidenceMode: null as string | null, status: "waiting" as ShareStatus, headline: "", headlineZh: "", goal: null as unknown, result: null as unknown, verifier: { bundleUrl: null as string | null, contractAddress: null as string | null } };
    if (share.kind === "job") {
      const job = (await this.d.db.select().from(verifyJobs).where(eq(verifyJobs.id, share.refId)).limit(1))[0]!;
      const latest = await this.d.jobs.latestReport(share.refId);
      const r = latest?.reportJson as VerifyReport | undefined;
      const j = job.jobJson as NormalizedJob;
      const inEntry = this.d.registry.entries.find((e) => e.assetKey === j.inputAssetKey);
      const outEntry = this.d.registry.entries.find((e) => e.assetKey === j.outputAssetKey);
      const execs = await this.d.jobs.executions(share.refId);
      const confirmed = execs.find((e) => e.state === "CONFIRMED");
      const status: ShareStatus = confirmed ? "completed" : r?.verdict === "rejected" ? "rejected" : "waiting";
      return {
        ...base,
        evidenceMode: this.d.evidence.mode,
        status,
        headline: title ?? headlineFor(status, outEntry?.displaySymbol ?? "stock", persona?.tone ?? "calm"),
        headlineZh: title ?? headlineForZh(status, outEntry?.displaySymbol ?? "股票", persona?.tone ?? "calm"),
        goal: { side: j.side ?? "buy", input: inEntry?.displaySymbol ?? null, output: outEntry?.displaySymbol ?? null, amount: amount(j.amountInRaw, inEntry?.tokenDecimals ?? 6), policyId: j.policyId },
        result: r ? { verdict: r.verdict, comparisonStatus: r.comparisonStatus, marketSession: r.marketSession, reasons: r.reasons.map((x) => x.code), reasonDetails: r.reasons.map((x) => ({ code: x.code, severity: x.severity })), completionBps: confirmed ? 10_000 : null, reportHash: latest!.reportHash, evidenceHash: r.evidenceHash, evaluatedAt: r.evaluatedAt, execution: confirmed ? { txHash: confirmed.txHash, received: privacy.amounts === "exact" ? (confirmed.receiptJson as { event?: { received?: string } } | null)?.event?.received ?? null : null } : null } : null,
        // publicBundleUrl：无需 key 的证据包（V-39）；bundleUrl 仍是 owner 用 key 读的路径
        verifier: { bundleUrl: `/v1/jobs/${share.refId}/bundle`, publicBundleUrl: `/pub/reports/${shareId}/bundle`, contractAddress: this.d.cfg.GUARD_ADDRESS || null },
      };
    }
    if (share.kind === "mandate") {
      const row = await this.d.mandates.byId(share.refId);
      if (!row) throw new HttpError(404, "share_not_found");
      const json = row.mandateJson as { legs: Array<{ outputAssetKey: string }>; inputAssetKey: string; side: string };
      const inEntry = this.d.registry.entries.find((e) => e.assetKey === json.inputAssetKey);
      const latest = await this.d.mandates.latestEvaluation(row.id);
      const done = BigInt(row.budgetCap) > 0n ? Number((BigInt(row.spent) * 10_000n) / BigInt(row.budgetCap)) : 0;
      const status: ShareStatus = row.state === "COMPLETED" ? "completed" : row.stepsDone > 0 ? "partial" : latest?.status === "BLOCKED" ? "rejected" : "waiting";
      return {
        ...base,
        evidenceMode: this.d.evidence.mode,
        status,
        headline: title ?? headlineFor(status, json.legs.map((l) => this.d.registry.entries.find((e) => e.assetKey === l.outputAssetKey)?.displaySymbol ?? "stock").join("+"), persona?.tone ?? "calm"),
        headlineZh: title ?? headlineForZh(status, json.legs.map((l) => this.d.registry.entries.find((e) => e.assetKey === l.outputAssetKey)?.displaySymbol ?? "股票").join("+"), persona?.tone ?? "calm"),
        goal: { side: json.side, input: inEntry?.displaySymbol ?? null, outputs: json.legs.map((l) => this.d.registry.entries.find((e) => e.assetKey === l.outputAssetKey)?.displaySymbol ?? null), budget: amount(row.budgetCap, inEntry?.tokenDecimals ?? 6), steps: { done: row.stepsDone, max: row.maxSteps } },
        result: { state: row.state, completionBps: done, latestStatus: latest?.status ?? null, latestDelta: (latest?.deltaJson as { summary?: unknown } | null)?.summary ?? null, evaluatedAt: latest?.evaluatedAt.toISOString() ?? null },
        verifier: { bundleUrl: `/v1/mandates/${share.refId}/bundle`, publicBundleUrl: `/pub/reports/${shareId}/bundle`, contractAddress: this.d.cfg.PLANGUARD_ADDRESS || null },
      };
    }
    if (share.kind === "simulation") {
      const row = (await this.d.db.select().from(verifySimulations).where(eq(verifySimulations.id, share.refId)).limit(1))[0]!;
      const plan = row.planJson as PlanReport;
      const goal = row.goalJson as PlanGoal;
      const inEntry = this.d.registry.entries.find((e) => e.assetKey === goal.budget.inputAssetKeys[0]);
      const rec = plan.candidates.find((c) => c.candidateId === plan.recommended) ?? null;
      return {
        ...base,
        evidenceMode: "SIMULATION",
        status: "simulation",
        headline: title ?? headlineFor("simulation", goal.legs.map((l) => this.d.registry.entries.find((e) => e.assetKey === l.outputAssetKey)?.displaySymbol ?? "stock").join("+"), persona?.tone ?? "calm"),
        headlineZh: title ?? headlineForZh("simulation", goal.legs.map((l) => this.d.registry.entries.find((e) => e.assetKey === l.outputAssetKey)?.displaySymbol ?? "股票").join("+"), persona?.tone ?? "calm"),
        goal: { side: goal.side, input: inEntry?.displaySymbol ?? null, budget: amount(goal.budget.amountInRaw, inEntry?.tokenDecimals ?? 6), policyId: goal.policyId },
        result: { candidates: plan.candidates.length, recommended: rec ? { completionBps: rec.completionBps, nextStep: rec.nextStep, verdict: rec.chosenPolicyVerdict } : null, blockers: [...new Set(plan.candidates.flatMap((c) => c.reasons.filter((r) => r.severity === "block").map((r) => r.code)))], planHash: plan.planHash },
        verifier: { bundleUrl: null, contractAddress: null },
      };
    }
    const plan = await this.d.plans.byId(share.refId);
    if (!plan) throw new HttpError(404, "share_not_found");
    const report = plan.planJson as PlanReport;
    const goal = plan.goalJson as PlanGoal;
    const inEntry = this.d.registry.entries.find((e) => e.assetKey === goal.budget.inputAssetKeys[0]);
    return {
      ...base,
      evidenceMode: this.d.evidence.mode,
      status: report.recommended ? "waiting" : "rejected",
      headline: title ?? headlineFor(report.recommended ? "waiting" : "rejected", goal.legs.map((l) => this.d.registry.entries.find((e) => e.assetKey === l.outputAssetKey)?.displaySymbol ?? "stock").join("+"), persona?.tone ?? "calm"),
      headlineZh: title ?? headlineForZh(report.recommended ? "waiting" : "rejected", goal.legs.map((l) => this.d.registry.entries.find((e) => e.assetKey === l.outputAssetKey)?.displaySymbol ?? "股票").join("+"), persona?.tone ?? "calm"),
      goal: { side: goal.side, input: inEntry?.displaySymbol ?? null, budget: amount(goal.budget.amountInRaw, inEntry?.tokenDecimals ?? 6), policyId: goal.policyId },
      result: { candidates: report.candidates.length, recommended: report.recommended !== null, planHash: report.planHash },
      verifier: { bundleUrl: null, contractAddress: null },
    };
  }

  /** Genesis Live：只列自愿公开的战报，最新在前，不排名 */
  async liveBoard(limit = 50) {
    const rows = await this.d.db.select().from(verifyShares).where(eq(verifyShares.public, true)).orderBy(desc(verifyShares.updatedAt)).limit(Math.min(limit, 100));
    const out: unknown[] = [];
    for (const s of rows) {
      try {
        out.push(await this.publicReport(s.shareId));
      } catch {
        /* 引用对象已不可见 */
      }
    }
    return out;
  }
}

/** 金额区间化（默认隐私）：按十进制量级给出区间文案 */
export function rangeOf(raw: string, decimals: number): string {
  const v = Number(BigInt(raw)) / 10 ** decimals;
  if (v < 10) return "< 10";
  if (v < 100) return "10–100";
  if (v < 1000) return "100–1k";
  if (v < 10_000) return "1k–10k";
  return "> 10k";
}

/** 角色语气只影响标题文案，不影响任何数值/判定 */
export function headlineFor(status: ShareStatus, symbol: string, tone: string): string {
  const t = tone === "playful" ? "playful" : tone === "terse" ? "terse" : "calm";
  const table: Record<ShareStatus, Record<string, string>> = {
    completed: { calm: `Verified and executed: ${symbol}.`, playful: `Nailed it — ${symbol} bought the honest way.`, terse: `${symbol}: done.` },
    partial: { calm: `Partially completed on ${symbol}; the rest is waiting for conditions.`, playful: `Halfway there on ${symbol}, the band plays on.`, terse: `${symbol}: partial.` },
    waiting: { calm: `Waiting for the right conditions on ${symbol}.`, playful: `${symbol} is on the setlist — waiting for the downbeat.`, terse: `${symbol}: waiting.` },
    rejected: { calm: `Correctly refused: ${symbol} did not pass the policy.`, playful: `${symbol} got a firm no — and that's the right answer.`, terse: `${symbol}: rejected.` },
    simulation: { calm: `Simulation on ${symbol}: rules ran, nothing executed.`, playful: `Rehearsal on ${symbol} — no money moved.`, terse: `${symbol}: simulated.` },
  };
  return table[status][t]!;
}

/** 中文标题（与 headlineFor 同一语气表；只改文案，不改数值） */
export function headlineForZh(status: ShareStatus, symbol: string, tone: string): string {
  const t = tone === "playful" ? "playful" : tone === "terse" ? "terse" : "calm";
  const table: Record<ShareStatus, Record<string, string>> = {
    completed: { calm: `已核验并执行：${symbol}。`, playful: `搞定——${symbol} 用诚实的方式买到了。`, terse: `${symbol}：完成。` },
    partial: { calm: `${symbol} 部分完成，其余在等条件。`, playful: `${symbol} 走到一半，乐队继续演奏。`, terse: `${symbol}：部分完成。` },
    waiting: { calm: `${symbol} 在等合适的条件。`, playful: `${symbol} 已经在歌单上——等一个下拍。`, terse: `${symbol}：等待中。` },
    rejected: { calm: `正确地拒绝了：${symbol} 没通过策略。`, playful: `${symbol} 被明确拒绝——而这就是正确答案。`, terse: `${symbol}：已拒绝。` },
    simulation: { calm: `${symbol} 模拟：规则跑了，什么都没执行。`, playful: `${symbol} 彩排——没有动一分钱。`, terse: `${symbol}：已模拟。` },
  };
  return table[status][t]!;
}
