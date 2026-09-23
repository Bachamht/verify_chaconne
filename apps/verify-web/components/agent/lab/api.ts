"use client";
/** /agent/lab 的接口接入点（Lane E）：路径 interfaces §11.7 C9 三行；响应形态以 apps/verify-service/src/lab/service.ts 为准。 */
import type { Blocker, Condition, ConditionOutcome, PolicyComparison, ReasonCode, ReplayRun } from "@chaconne/core/verify";
import { api } from "@/lib/api";

export interface ExplainWaitView {
  taskId: string;
  status: string;
  playbookId: string;
  conditionsHash: string;
  executorPresence: string;
  source: "latest_evaluation" | "evaluated_now";
  evaluatorId: string;
  evidenceSnapshotId: string | null;
  outcome: ConditionOutcome;
  evaluatedAt: string;
  blockers: Blocker[];
  i18n: Array<{ code: ReasonCode; en: string; zh: string }>;
  nextCheckAt: string | null;
  nextCheckNote: { en: string; zh: string };
  userActionRequired: Blocker[];
}

export interface CompareView {
  comparisonId: string;
  comparison: PolicyComparison;
  planner: Array<{ label: string; summary: { planHash: string; recommended: string | null; verdict: string | null; candidateCount: number; blocking: ReasonCode[] } | null }>;
  outcomeDiff: Array<{ label: string; outcome: ConditionOutcome; blockingCodes: ReasonCode[]; nextCheckAt: string | null }>;
  remix: { simulationBody: Record<string, unknown> | null; variantLabel: string; note: { en: string; zh: string } };
  evaluatorId: string;
  mode: "SIMULATION";
  snapshot: { id: string; takenAt: string; hash: string; evidenceIds: string[]; contextPackagedAt: string | null; eventVersions: Array<{ id: string; revision: number; firstKnownAt: string }> };
  task: { id: string; status: string; conditionsHash: string; mandateIds: string[] };
  note: { en: string; zh: string };
}

export interface ReplayView {
  replayId: string;
  run: ReplayRun;
  mode: "REPLAY";
  evaluatorId: string;
  sources: { verify_evidence: number; verify_context_snapshots: number; premium_1h: number; events: number };
  note: { en: string; zh: string };
}

export const lab = {
  explainWait: (taskId: string, locale: string) => api<ExplainWaitView>("GET", `v1/tasks/${encodeURIComponent(taskId)}/explain-wait?locale=${locale}`),
  compare: (taskId: string, variants: Array<{ label: string; conditions: { items: Condition[] } }>) => api<CompareView>("POST", `v1/tasks/${encodeURIComponent(taskId)}/compare-policies`, { variants }),
  replay: (body: { playbookId: string; assetKey: string; conditions: { items: Condition[] }; from: string; to: string; stepMinutes: number; locale: string }) => api<ReplayView>("POST", "v1/replays", body),
  simulate: (body: Record<string, unknown>) => api<{ simulationId: string; verdict: string; mode: string }>("POST", "v1/simulations", body),
};
