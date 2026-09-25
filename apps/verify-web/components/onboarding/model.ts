import type { ConditionItemResult } from "@chaconne/core/verify";
import type { CreateTaskBody, TaskCreated } from "@/lib/api-v2";
import type { AssetEntry } from "@/lib/assets";
import { humanToRaw } from "@/lib/format";
import { buildTaskBody, type DraftHandoff } from "../agent/tasks/taskDraft";
import type { SamplePlaybook } from "../agent/home/entries";

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

/** 钱包账户化：owner 必须是已连接的钱包地址；没有就不构造请求 */
export function buildSimulationRequest(sample: SamplePlaybook, stock: AssetEntry, stable: AssetEntry, totalHuman: string, owner: string | null, clientRequestId: string): CreateTaskBody | null {
  const amount = splitSimulationBudget(totalHuman, stable.tokenDecimals, sample.steps);
  if (!amount || stock.role !== "stock_output" || !stock.executionAllowed || stable.role !== "stable_input") return null;
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return null;
  const effectiveOwner = owner;
  return buildTaskBody({
    playbookId: sample.playbookId,
    outputAssetKey: stock.assetKey,
    inputAssetKey: stable.assetKey,
    steps: sample.steps,
    perStepHuman: amount.perStepHuman,
    mode: "SIMULATION",
    conditions: sample.conditions,
    maxPremiumBps: sample.conditions.find((c) => c.type === "premium_bps_lte")?.value ?? 30,
  }, effectiveOwner, stable.tokenDecimals, clientRequestId);
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

/** Copy only the user's original plan; never carry a generated thesis id into LIVE. */
export function liveDraftFromSimulation(request: CreateTaskBody): DraftHandoff {
  return {
    playbookId: request.playbookId,
    mode: "LIVE",
    params: { ...request.params },
    conditions: { items: request.conditions.items.filter((item) => item.type !== "thesis_holds").map((item) => ({ ...item })) },
  };
}

export function isSimulationTask(value: unknown): value is SimulationTask {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<SimulationTask>;
  return view.mode === "SIMULATION" && !!view.task && typeof view.task.id === "string" && /^tsk_[A-Za-z0-9_]+$/.test(view.task.id)
    && typeof view.task.status === "string" && Array.isArray(view.task.blockers) && Array.isArray(view.task.conditions?.items);
}
