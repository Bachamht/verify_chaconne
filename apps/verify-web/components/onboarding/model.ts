import type { ConditionItemResult } from "@chaconne/core/verify";
import type { CreateTaskBody, TaskCreated } from "@/lib/api-v2";
import type { AssetEntry } from "@/lib/assets";
import { humanToRaw } from "@/lib/format";
import { buildTaskBody, type DraftHandoff } from "../agent/tasks/taskDraft";
import type { SamplePlaybook } from "../agent/home/entries";

export const SIMULATION_OWNER = "0x0000000000000000000000000000000000000001";

export interface SimulationTask extends TaskCreated {
  lastEvaluation?: {
    evaluatedAt?: string;
    outcome?: string;
    perItem?: ConditionItemResult[];
    simulation?: { wouldIssue?: boolean } | null;
  } | null;
}

export interface OnboardingResult {
  view: SimulationTask;
  request: CreateTaskBody;
  stock: AssetEntry;
  stable: AssetEntry;
  sample: SamplePlaybook;
}

/** Local snapshots may be missing or damaged; never render their amount with unchecked BigInt input. */
export function isOnboardingSnapshot(value: unknown): value is OnboardingResult {
  if (!value || typeof value !== "object") return false;
  const saved = value as Partial<OnboardingResult>;
  const raw = saved.request?.params?.["perStepAmountRaw"] ?? saved.request?.params?.["amountRaw"];
  return isSimulationTask(saved.view) && saved.request?.mode === "SIMULATION"
    && /^0x[0-9a-fA-F]{40}$/.test(saved.request.ownerAddress)
    && typeof raw === "string" && /^\d{1,90}$/.test(raw) && BigInt(raw) > 0n
    && Array.isArray(saved.request.conditions?.items)
    && !!saved.stock && saved.stock.role === "stock_output" && typeof saved.stock.assetKey === "string" && typeof saved.stock.displaySymbol === "string"
    && !!saved.stable && saved.stable.role === "stable_input" && typeof saved.stable.assetKey === "string" && typeof saved.stable.displaySymbol === "string"
    && Number.isInteger(saved.stable.tokenDecimals) && saved.stable.tokenDecimals >= 0 && saved.stable.tokenDecimals <= 36
    && !!saved.sample && Number.isInteger(saved.sample.steps) && saved.sample.steps >= 1 && saved.sample.steps <= 60
    && saved.sample.steps === saved.request.params["steps"] && saved.sample.playbookId === saved.request.playbookId
    && typeof saved.sample.title?.zh === "string" && typeof saved.sample.title?.en === "string" && Array.isArray(saved.sample.conditions);
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

export function buildSimulationRequest(sample: SamplePlaybook, stock: AssetEntry, stable: AssetEntry, totalHuman: string, owner: string | null, clientRequestId: string): CreateTaskBody | null {
  const amount = splitSimulationBudget(totalHuman, stable.tokenDecimals, sample.steps);
  if (!amount || stock.role !== "stock_output" || !stock.executionAllowed || stable.role !== "stable_input") return null;
  const effectiveOwner = owner && /^0x[0-9a-fA-F]{40}$/.test(owner) ? owner : SIMULATION_OWNER;
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

/** Copy only the user's original plan. Never carry a demo owner or a generated thesis id into LIVE. */
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
