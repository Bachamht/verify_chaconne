/**
 * 钱包账户化：GET /v1/records?owner=<地址> —— 该钱包名下全部记录（任务 / 授权计划 / 规划 / 单笔核验 / 模拟），倒序合并。
 * 只做只读汇总，字段是各表已有的公开摘要（不含证据、签名、原始请求）；详情仍走各自的 GET /v1/<kind>/:id。
 * 鉴权与组合页一致：assertOwner（受信代理的 x-verify-caller 直接通过；API key 调用方须此前为该 owner 登记过记录）。
 */
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyJobs, verifyMandates, verifyPlans, verifySimulations, verifyTasks } from "@chaconne/db";

export type RecordKind = "task" | "mandate" | "plan" | "job" | "simulation";
export interface RecordItem {
  kind: RecordKind;
  id: string;
  createdAt: string;
  status?: string;
  mode?: string;
  playbookId?: string;
  params?: Record<string, unknown>;
  side?: "buy" | "sell";
  policyId?: string;
  inputAssetKey?: string;
  outputAssetKeys?: string[];
  amountInRaw?: string;
  personaId?: string | null;
  taskId?: string | null;
  stepsDone?: number;
  maxSteps?: number;
  budgetCap?: string;
  spent?: string;
  deadline?: string;
}

const LIMIT = 100;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : new Date(0).toISOString());

/** PlanGoal → 摘要（side / policyId / 资金币种 / 输出资产 / 总额） */
function goalSummary(goal: unknown): Pick<RecordItem, "side" | "policyId" | "inputAssetKey" | "outputAssetKeys" | "amountInRaw"> {
  const g = obj(goal);
  const budget = obj(g["budget"]);
  const legs = Array.isArray(g["legs"]) ? (g["legs"] as unknown[]).map((l) => str(obj(l)["outputAssetKey"])).filter((k): k is string => !!k) : [];
  const inputs = Array.isArray(budget["inputAssetKeys"]) ? (budget["inputAssetKeys"] as unknown[]).filter((k): k is string => typeof k === "string") : [];
  return {
    side: g["side"] === "sell" ? "sell" : g["side"] === "buy" ? "buy" : undefined,
    policyId: str(g["policyId"]),
    inputAssetKey: inputs[0],
    outputAssetKeys: legs,
    amountInRaw: str(budget["amountInRaw"]),
  };
}

export async function listRecords(db: Db, owner: string): Promise<RecordItem[]> {
  const o = owner.toLowerCase();
  const [tasks, mandatesAll, archived, plans, jobs, sims] = await Promise.all([
    db.select({ id: verifyTasks.id, createdAt: verifyTasks.createdAt, status: verifyTasks.status, mode: verifyTasks.mode, playbookId: verifyTasks.playbookId, paramsJson: verifyTasks.paramsJson, goalJson: verifyTasks.goalJson })
      .from(verifyTasks).where(and(eq(verifyTasks.ownerAddress, o), isNull(verifyTasks.archivedAt))).orderBy(desc(verifyTasks.createdAt)).limit(LIMIT),
    db.select({ id: verifyMandates.id, createdAt: verifyMandates.createdAt, state: verifyMandates.state, taskId: verifyMandates.taskId, stepsDone: verifyMandates.stepsDone, maxSteps: verifyMandates.maxSteps, budgetCap: verifyMandates.budgetCap, spent: verifyMandates.spent, deadline: verifyMandates.deadline, mandateJson: verifyMandates.mandateJson })
      .from(verifyMandates).where(eq(verifyMandates.ownerAddress, o)).orderBy(desc(verifyMandates.createdAt)).limit(LIMIT),
    // 已归档（用户删除）的任务：其授权计划一并从列表隐藏，详情页仍可按 id 读（CV-D16 batch 7）
    db.select({ id: verifyTasks.id }).from(verifyTasks).where(and(eq(verifyTasks.ownerAddress, o), isNotNull(verifyTasks.archivedAt))),
    db.select({ id: verifyPlans.id, createdAt: verifyPlans.createdAt, goalJson: verifyPlans.goalJson })
      .from(verifyPlans).where(eq(verifyPlans.ownerAddress, o)).orderBy(desc(verifyPlans.createdAt)).limit(LIMIT),
    db.select({ id: verifyJobs.id, createdAt: verifyJobs.createdAt, jobJson: verifyJobs.jobJson })
      .from(verifyJobs).where(eq(verifyJobs.ownerAddress, o)).orderBy(desc(verifyJobs.createdAt)).limit(LIMIT),
    db.select({ id: verifySimulations.id, createdAt: verifySimulations.createdAt, personaId: verifySimulations.personaId, goalJson: verifySimulations.goalJson })
      .from(verifySimulations).where(eq(verifySimulations.ownerAddress, o)).orderBy(desc(verifySimulations.createdAt)).limit(LIMIT),
  ]);
  const archivedIds = new Set(archived.map((r) => r.id));
  const mandates = mandatesAll.filter((r) => !r.taskId || !archivedIds.has(r.taskId));
  const items: RecordItem[] = [
    ...tasks.map((r): RecordItem => ({ kind: "task", id: r.id, createdAt: iso(r.createdAt), status: r.status, mode: r.mode, playbookId: r.playbookId, params: obj(r.paramsJson), ...goalSummary(r.goalJson) })),
    ...mandates.map((r): RecordItem => {
      const m = obj(r.mandateJson);
      const outputs = Array.isArray(m["outputAssetKeys"]) ? (m["outputAssetKeys"] as unknown[]).filter((k): k is string => typeof k === "string") : [];
      return { kind: "mandate", id: r.id, createdAt: iso(r.createdAt), status: r.state, taskId: r.taskId ?? null, stepsDone: r.stepsDone, maxSteps: r.maxSteps, budgetCap: r.budgetCap, spent: r.spent, deadline: iso(r.deadline), inputAssetKey: str(m["inputAssetKey"]), outputAssetKeys: outputs };
    }),
    ...plans.map((r): RecordItem => ({ kind: "plan", id: r.id, createdAt: iso(r.createdAt), ...goalSummary(r.goalJson) })),
    ...jobs.map((r): RecordItem => {
      const j = obj(r.jobJson);
      return { kind: "job", id: r.id, createdAt: iso(r.createdAt), side: j["side"] === "sell" ? "sell" : "buy", policyId: str(j["policyId"]), inputAssetKey: str(j["inputAssetKey"]), outputAssetKeys: str(j["outputAssetKey"]) ? [str(j["outputAssetKey"])!] : [], amountInRaw: str(j["amountInRaw"]), mode: str(j["mode"]) };
    }),
    ...sims.map((r): RecordItem => ({ kind: "simulation", id: r.id, createdAt: iso(r.createdAt), personaId: r.personaId ?? null, mode: "SIMULATION", ...goalSummary(r.goalJson) })),
  ];
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, LIMIT * 2);
}
