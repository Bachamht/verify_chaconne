/**
 * /start v7（P1）的纯逻辑：同一份目标与范围先建 SIMULATION + 托管 Agent（观察模式），再建 LIVE（托管 Agent + 平台执行）。
 * 两次请求只有 mode / executor / 请求编号不同——「交给它真实运行」不会悄悄改范围（测试断言）。
 */
import type { CreateTaskBody } from "@/lib/api-v2";
import type { AssetEntry } from "@/lib/assets";
import { humanToRaw } from "@/lib/format";

export interface StartDraft {
  objective: string;
  strategy: string;
  assetKeys: string[];
  totalHuman: string;
  perStepHuman: string;
  maxSteps: number;
  days: number;
  allowSell: boolean;
  regularOnly: boolean;
  trustTier: "platform_only" | "agent_data" | "agent_research";
  watch: string[];
  exampleId: string | null;
}

export type DraftError = "objective" | "assets" | "total" | "perStep" | "maxSteps" | "days";

const decOk = (v: string, decimals: number) => /^\d+(\.\d+)?$/.test(v.trim()) && (v.split(".")[1]?.length ?? 0) <= decimals;

export function validateStartDraft(d: StartDraft, stable: AssetEntry | null): DraftError[] {
  const e: DraftError[] = [];
  if (!d.objective.trim()) e.push("objective");
  if (d.assetKeys.length === 0 || d.assetKeys.length > 8) e.push("assets");
  const dec = stable?.tokenDecimals ?? 6;
  const total = decOk(d.totalHuman, dec) ? humanToRaw(d.totalHuman, dec) : null;
  const per = decOk(d.perStepHuman, dec) ? humanToRaw(d.perStepHuman, dec) : null;
  if (!total || BigInt(total) <= 0n) e.push("total");
  if (!per || BigInt(per) <= 0n || (total && BigInt(per) > BigInt(total))) e.push("perStep");
  if (!Number.isInteger(d.maxSteps) || d.maxSteps < 1 || d.maxSteps > 60) e.push("maxSteps");
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > 365) e.push("days");
  return e;
}

/** CreateTaskBody + v7 的 agent / executor 字段（interfaces §12.8「改动的旧接口」） */
export type V7CreateBody = CreateTaskBody & { agent: { mode: "hosted" | "byo" }; executor?: { mode: "hosted" | "agent_wallet" | "browser" } };

export function buildStartRequest(d: StartDraft, stable: AssetEntry, owner: string, mode: "SIMULATION" | "LIVE", clientRequestId: string, deadline: string): V7CreateBody | null {
  if (validateStartDraft(d, stable).length) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return null;
  const total = humanToRaw(d.totalHuman, stable.tokenDecimals)!;
  const per = humanToRaw(d.perStepHuman, stable.tokenDecimals)!;
  return {
    clientRequestId,
    ownerAddress: owner.toLowerCase(),
    mode,
    strategy: d.strategy.trim() || undefined,
    exampleId: d.exampleId ?? undefined,
    watchEvents: { kinds: d.watch },
    params: { policyId: "QUOTE_ONLY", maxPriceImpactBps: 100 },
    agent: { mode: "hosted" },
    ...(mode === "LIVE" ? { executor: { mode: "hosted" as const } } : {}),
    scope: {
      objective: d.objective.trim().slice(0, 500),
      inputAssetKey: stable.assetKey,
      outputAssetKeys: [...d.assetKeys].map((k) => k.toLowerCase()).sort(),
      budgetCapRaw: total,
      perStepCapRaw: per,
      maxSteps: d.maxSteps,
      deadline,
      trustTier: d.trustTier,
      issuance: "agent",
      allowSell: d.allowSell,
      ...(d.regularOnly ? { hardConditions: [{ type: "session", allow: ["US_REGULAR"] }] } : {}),
    },
  };
}

/** 两次请求的范围必须完全一致（除 deadline 允许同一时刻派生） */
export function sameScope(a: V7CreateBody, b: V7CreateBody): boolean {
  return JSON.stringify(a.scope) === JSON.stringify(b.scope) && a.strategy === b.strategy && JSON.stringify(a.watchEvents) === JSON.stringify(b.watchEvents) && JSON.stringify(a.params) === JSON.stringify(b.params);
}

/** 建任务失败时的人话分类（托管准入 / 观察次数 / 其它） */
export function createFailureKind(r: { status: number; data: unknown }): "hosted_closed" | "sim_limit" | "other" {
  const code = String((r.data as { error?: unknown } | null)?.error ?? "");
  if (r.status === 403 && (code === "hosted_not_allowed" || code === "")) return "hosted_closed";
  if (code === "hosted_not_allowed") return "hosted_closed";
  if (code === "hosted_sim_limit" || code === "sim_limit_reached") return "sim_limit";
  return "other";
}
