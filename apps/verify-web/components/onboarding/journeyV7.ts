import type { AssetEntry } from "@/lib/assets";
import { buildStartRequest, type StartDraft, type V7CreateBody } from "./modelV7";

export interface StartAttempt {
  draft: StartDraft;
  stable: AssetEntry;
  body: V7CreateBody;
}
export interface StartJourney {
  version: 1;
  owner: string;
  template: number;
  draft: StartDraft | null;
  attempt: StartAttempt | null;
  observation: (StartAttempt & { id: string }) | null;
  liveRequestId: string | null;
  liveId: string | null;
}
export const journeyKey = (owner: string) => "verify_start_v7:" + owner.toLowerCase();
export const emptyJourney = (owner: string): StartJourney => ({ version: 1, owner: owner.toLowerCase(), template: 0, draft: null, attempt: null, observation: null, liveRequestId: null, liveId: null });

function validDraft(value: unknown): value is StartDraft {
  if (!value || typeof value !== "object") return false;
  const d = value as StartDraft;
  return typeof d.objective === "string" && d.objective.length <= 500 && typeof d.strategy === "string" && d.strategy.length <= 4000
    && Array.isArray(d.assetKeys) && d.assetKeys.length <= 8 && d.assetKeys.every((k) => typeof k === "string" && /^eip155:196:0x[\da-f]{40}$/i.test(k))
    && typeof d.totalHuman === "string" && d.totalHuman.length <= 80 && typeof d.perStepHuman === "string" && d.perStepHuman.length <= 80
    && Number.isFinite(d.maxSteps) && Number.isFinite(d.days) && typeof d.allowSell === "boolean" && typeof d.regularOnly === "boolean"
    && ["platform_only", "agent_data", "agent_research"].includes(d.trustTier)
    && Array.isArray(d.watch) && d.watch.length <= 20 && d.watch.every((w) => typeof w === "string")
    && (d.exampleId === null || typeof d.exampleId === "string");
}

function validAttempt(a: StartAttempt, owner: string): boolean {
  if (!a || !validDraft(a.draft) || !a.stable || !a.body) return false;
  const { stable, body } = a;
  if (typeof stable.assetKey !== "string" || !/^eip155:196:0x[\da-f]{40}$/i.test(stable.assetKey)
    || !Number.isInteger(stable.tokenDecimals) || stable.tokenDecimals < 0 || stable.tokenDecimals > 36
    || typeof stable.displaySymbol !== "string" || stable.role !== "stable_input"
    || typeof body.clientRequestId !== "string" || typeof body.scope?.deadline !== "string"
    || !Number.isFinite(Date.parse(body.scope.deadline))) return false;
  const rebuilt = buildStartRequest(a.draft, stable, owner, "SIMULATION", body.clientRequestId, body.scope.deadline);
  return rebuilt !== null && JSON.stringify(rebuilt) === JSON.stringify(body);
}

/** Only restore our own complete requests, partitioned by wallet. Never store signatures or tokens. */
export function parseJourney(raw: string | null, owner: string): StartJourney | null {
  try {
    if (!raw || raw.length > 100_000) return null;
    const j = JSON.parse(raw) as StartJourney;
    if (j.version !== 1 || j.owner !== owner.toLowerCase() || !Number.isInteger(j.template) || j.template < 0
      || (j.draft !== null && !validDraft(j.draft))
      || (j.attempt !== null && !validAttempt(j.attempt, owner))
      || (j.observation !== null && (!validAttempt(j.observation, owner) || !validId(j.observation.id)))
      || (j.liveRequestId !== null && !validId(j.liveRequestId))
      || (j.liveId !== null && (!validId(j.liveId) || !j.observation))) return null;
    return j;
  } catch { return null; }
}
function validId(id: unknown): id is string { return typeof id === "string" && /^[\w:-]{1,160}$/.test(id); }

/** Editing the plan invalidates both idempotency keys and the old live destination. */
export function editJourney(j: StartJourney, draft: StartDraft, template = j.template): StartJourney {
  return { ...j, draft, template, attempt: null, observation: null, liveRequestId: null, liveId: null };
}

/** Promote the observed snapshot, never the mutable form; expiry requires a fresh observation. */
export function liveFromObservation(body: V7CreateBody, clientRequestId: string, now = Date.now()): V7CreateBody | null {
  if (body.mode !== "SIMULATION" || !body.scope?.deadline || Date.parse(body.scope.deadline) <= now || !Number.isFinite(Date.parse(body.scope.deadline))) return null;
  return { ...body, clientRequestId, mode: "LIVE", executor: { mode: "hosted" } };
}
