import type { ConditionItemResult } from "@chaconne/core/verify";
import type { CreateTaskBody, TaskCreated } from "@/lib/api-v2";
import type { AssetEntry } from "@/lib/assets";
import { humanToRaw } from "@/lib/format";
import type { ComplexTask } from "../agent/home/entries";
import type { GoalDraft } from "../agent/tasks/taskDraft";

export interface SimulationTask extends TaskCreated {
  lastEvaluation?: {
    evaluatedAt?: string;
    outcome?: string;
    perItem?: ConditionItemResult[];
    simulation?: { wouldIssue?: boolean } | null;
  } | null;
}

/** Split a total cap in token base units. Rounding can only reduce the total. */
export function splitSimulationBudget(human: string, decimals: number, steps: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !Number.isInteger(steps) || steps < 1 || steps > 60) return null;
  const value = human.trim();
  if (value.length > 48 || !/^\d+(\.\d+)?$/.test(value)) return null;
  if ((value.split(".")[1]?.length ?? 0) > decimals) return null;
  const requested = humanToRaw(value, decimals);
  if (!requested) return null;
  const per = BigInt(requested) / BigInt(steps);
  if (per <= 0n) return null;
  const total = per * BigInt(steps);
  const digits = per.toString().padStart(decimals + 1, "0");
  const perStepHuman = decimals === 0 ? digits : [digits.slice(0, -decimals), digits.slice(-decimals).replace(/0+$/, "")].filter(Boolean).join(".");
  return { requestedRaw: requested, perStepRaw: per.toString(), totalRaw: total.toString(), remainderRaw: (BigInt(requested) - total).toString(), perStepHuman };
}

/**
 * 体验用的目标式任务请求（SIMULATION，不传 playbookId）：范围 = 允许的资产、总额、每笔上限（总额 / 笔数）、笔数、期限；
 * 策略文本与关注的事件随任务；钱包账户化：owner 必须是已连接的钱包，否则不构造。
 */
export function buildGoalRequest(task: ComplexTask, stocks: AssetEntry[], stable: AssetEntry, totalHuman: string, owner: string | null, clientRequestId: string, locale: "en" | "zh"): CreateTaskBody | null {
  const amount = splitSimulationBudget(totalHuman, stable.tokenDecimals, task.steps);
  const allowed = stocks.filter((s) => s.role === "stock_output" && s.executionAllowed);
  if (!amount || allowed.length === 0 || allowed.length !== stocks.length || stable.role !== "stable_input") return null;
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return null;
  const deadline = new Date(Date.now() + task.days * 86_400_000).toISOString();
  return {
    clientRequestId,
    ownerAddress: owner.toLowerCase(),
    mode: "SIMULATION",
    strategy: task.strategy[locale],
    exampleId: task.id,
    watchEvents: { kinds: task.watch },
    params: { policyId: "QUOTE_ONLY", maxPriceImpactBps: 100 },
    scope: {
      objective: task.objective[locale],
      inputAssetKey: stable.assetKey,
      outputAssetKeys: allowed.map((s) => s.assetKey),
      budgetCapRaw: amount.totalRaw,
      perStepCapRaw: amount.perStepRaw,
      maxSteps: task.steps,
      deadline,
      trustTier: task.trustTier,
      issuance: "agent",
      ...(task.regularSessionOnly ? { hardConditions: [{ type: "session", allow: ["US_REGULAR"] }] } : {}),
    },
  };
}

export type SimulationDecision = "ready" | "waiting" | "stopped" | "unknown";

/** An empty blocker list alone never proves that a simulation passed. */
export function simulationDecision(view: SimulationTask): SimulationDecision {
  if (view.mode !== "SIMULATION") return "unknown";
  if (["PAUSED", "REVOKE_PENDING", "REVOKED", "EXPIRED", "CANCELLED", "COMPLETED"].includes(view.task.status)) return "stopped";
  if (view.task.status === "WAITING" || view.lastEvaluation?.outcome === "UNSATISFIED" || view.lastEvaluation?.outcome === "INSUFFICIENT_EVIDENCE") return "waiting";
  if (view.task.blockers.length) return "waiting";
  if (view.task.status === "ACTIVE" && view.lastEvaluation?.outcome === "SATISFIED" && view.lastEvaluation.simulation?.wouldIssue === true) return "ready";
  return "unknown";
}

/** 「准备真实运行」：把同一份目标、策略与范围交给 /agent 的目标表单（人类单位；不带 owner 与请求编号） */
export function liveGoalDraft(request: CreateTaskBody, task: ComplexTask, stable: AssetEntry, totalHuman: string): GoalDraft | null {
  const amount = splitSimulationBudget(totalHuman, stable.tokenDecimals, task.steps);
  if (!amount || !request.scope) return null;
  return {
    objective: String(request.scope.objective ?? ""),
    strategy: request.strategy ?? "",
    assetKeys: [...(request.scope.outputAssetKeys ?? [])],
    inputAssetKey: stable.assetKey,
    totalHuman,
    perStepHuman: amount.perStepHuman,
    maxSteps: task.steps,
    days: task.days,
    trustTier: task.trustTier,
    watch: [...task.watch],
    regularOnly: !!task.regularSessionOnly,
    exampleId: task.id,
  };
}

export function isSimulationTask(value: unknown): value is SimulationTask {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<SimulationTask>;
  return view.mode === "SIMULATION" && !!view.task && typeof view.task.id === "string" && /^tsk_[A-Za-z0-9_]+$/.test(view.task.id)
    && typeof view.task.status === "string" && Array.isArray(view.task.blockers) && Array.isArray(view.task.conditions?.items);
}
