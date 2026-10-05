/**
 * 公开只读数据（战报 /pub/reports、值守看板 /pub/tasks/:shareId/activity）：走 /api/pub 代理，无 key、无钱包。
 * 从 lib/api-v2 移来（v8）：公开页与 OG 图只引这里，不把 lib/api → lib/session → viem 拉进包（D6）。
 * 隐私：公开战报钱包恒隐藏；看板白名单只留 at + category + actor。
 */
import type { PersonaId, ShareStatus } from "@chaconne/core/verify";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

/** 公开读取（隐私过滤后） */
export interface PublicReport {
  shareId: string;
  kind: "job" | "mandate" | "simulation";
  status: ShareStatus;
  persona: { personaId: PersonaId; name: string; tone: "calm" | "playful" | "terse" } | null;
  headline: { en: string; zh: string } | null;
  goal: { side: "buy" | "sell"; outputSymbols: string[]; inputSymbol: string; policyId: string; amountDisplay: string | null };
  result: { verdict: string | null; completionBps: number | null; spentDisplay: string | null; receivedDisplay: string | null; feesDisplay: string | null; reasons: Array<{ code: string; severity: string }>; waitingOn: string | null };
  evidence: { evidenceHash: string | null; reportHash: string | null; bundleUrl: string | null; txHashes: string[] };
  /** 单笔核验（kind=job）的公开核验结果：行情事实 + 核验时间；没执行时页面据此说清「这只是核验」 */
  check?: { executionEligible: boolean; marketSession: string; comparisonStatus: string; evaluatedAt: string; policyId: string; reference: { kind: string; priceUsd: string; deviationBps: number | null; sourcePublishedAt: string | null; tradingDate: string | null } | null; executableUsdPerShare: string | null; adverseImpactBps: number | null; quoteReceivedAt: string | null } | null;
  templateId: string | null;
  evidenceMode: "LIVE" | "FIXTURE" | "SIMULATION";
  createdAt: string;
}

/** 公开值守看板：只有类别与时间（P6 / R5） */
export interface PublicActivityItem { at: string; category: string; actor?: "owner" | "agent" | "executor" | "system" }
export interface PublicActivityView { shareId: string; generatedAt?: string; presence?: string | null; mode?: "LIVE" | "SIMULATION" | null; items: PublicActivityItem[] }

/**
 * 服务端公开战报（C2）与页面类型（E2）字段名不完全一致，在这一处归一化（I2 2026-09-21）：
 * headline 字符串 + headlineZh → {en,zh}；goal.input/output(s)/amount|budget → inputSymbol/outputSymbols/amountDisplay；
 * result.reasonDetails|reasons → [{code,severity}]；execution.txHash → evidence.txHashes。
 */
export function normalizePublicReport(raw: unknown): PublicReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["shareId"] !== "string") return null;
  const goal = (r["goal"] ?? {}) as Record<string, unknown>;
  const result = (r["result"] ?? {}) as Record<string, unknown>;
  const execution = (result["execution"] ?? null) as { txHash?: string | null; received?: string | null } | null;
  const rec = (result["recommended"] ?? null) as { completionBps?: number } | boolean | null;
  const headline = typeof r["headline"] === "string" ? { en: r["headline"] as string, zh: (r["headlineZh"] as string | undefined) ?? (r["headline"] as string) } : (r["headline"] as { en: string; zh: string } | null);
  const outputs = (goal["outputSymbols"] as string[] | undefined) ?? (goal["outputs"] as Array<string | null> | undefined)?.filter((x): x is string => !!x) ?? (typeof goal["output"] === "string" ? [goal["output"] as string] : []);
  const reasons =
    (result["reasonDetails"] as Array<{ code: string; severity: string }> | undefined) ??
    ((result["reasons"] as Array<string | { code: string; severity?: string }> | undefined) ?? []).map((x) => (typeof x === "string" ? { code: x, severity: "info" } : { code: x.code, severity: x.severity ?? "info" })) ??
    ((result["blockers"] as string[] | undefined) ?? []).map((code) => ({ code, severity: "block" }));
  const status = r["status"] as ShareStatus;
  return {
    shareId: r["shareId"] as string,
    kind: (r["kind"] as PublicReport["kind"]) ?? "job",
    status,
    persona: (r["persona"] as PublicReport["persona"]) ?? null,
    headline,
    goal: {
      side: ((goal["side"] as string) === "sell" ? "sell" : "buy"),
      outputSymbols: outputs,
      inputSymbol: (goal["inputSymbol"] as string | undefined) ?? (goal["input"] as string | undefined) ?? "",
      policyId: (goal["policyId"] as string | undefined) ?? "",
      amountDisplay: (goal["amountDisplay"] as string | null | undefined) ?? (goal["amount"] as string | null | undefined) ?? (goal["budget"] as string | null | undefined) ?? null,
    },
    result: {
      verdict: (result["verdict"] as string | undefined) ?? (typeof rec === "object" && rec ? "eligible" : null),
      completionBps: (result["completionBps"] as number | undefined) ?? (typeof rec === "object" && rec && typeof rec.completionBps === "number" ? rec.completionBps : status === "completed" ? 10_000 : null),
      spentDisplay: (result["spentDisplay"] as string | null | undefined) ?? null,
      receivedDisplay: (result["receivedDisplay"] as string | null | undefined) ?? execution?.received ?? null,
      feesDisplay: (result["feesDisplay"] as string | null | undefined) ?? null,
      reasons,
      waitingOn: (result["waitingOn"] as string | null | undefined) ?? (typeof result["latestDelta"] === "string" ? (result["latestDelta"] as string) : null),
    },
    evidence: (r["evidence"] as PublicReport["evidence"] | undefined) ?? {
      evidenceHash: (result["evidenceHash"] as string | null | undefined) ?? null,
      reportHash: (result["reportHash"] as string | null | undefined) ?? (result["planHash"] as string | null | undefined) ?? null,
      bundleUrl: ((r["verifier"] as { bundleUrl?: string | null } | undefined)?.bundleUrl ?? null),
      txHashes: execution?.txHash ? [execution.txHash] : [],
    },
    check: (result["check"] as PublicReport["check"] | undefined) ?? null,
    templateId: (r["templateId"] as string | null | undefined) ?? null,
    evidenceMode: ((r["evidenceMode"] as string | null | undefined) ?? "LIVE") as PublicReport["evidenceMode"],
    createdAt: (r["createdAt"] as string | undefined) ?? new Date(0).toISOString(),
  };
}

export async function pubReport(shareId: string): Promise<{ status: number; data: PublicReport }> {
  const res = await fetch(`/api/pub/reports/${shareId}`, { cache: "no-store" });
  const raw = await res.json().catch(() => null);
  return { status: res.status, data: normalizePublicReport(raw) as PublicReport };
}
export async function pubList(): Promise<{ status: number; data: { items: PublicReport[] } }> {
  const res = await fetch(`/api/pub/reports`, { cache: "no-store" });
  const raw = (await res.json().catch(() => ({ items: [] }))) as { items?: unknown[] };
  return { status: res.status, data: { items: (raw.items ?? []).map(normalizePublicReport).filter((x): x is PublicReport => x !== null) } };
}

/** 公开看板的白名单归一化：只留 at + category（纵深防御：即使服务端多给了字段，页面也拿不到） */
export function normalizePublicActivity(raw: unknown): PublicActivityView | null {
  if (!isObj(raw) || typeof raw["shareId"] !== "string") return null;
  const ACTORS = ["owner", "agent", "executor", "system"] as const;
  const items = (Array.isArray(raw["items"]) ? raw["items"] : []).filter(isObj).map((x) => {
    const actor = ACTORS.find((a) => a === x["actor"]);
    return { at: typeof x["at"] === "string" ? x["at"] : "", category: typeof x["category"] === "string" ? x["category"] : "other", ...(actor ? { actor } : {}) };
  }).filter((x) => x.at);
  const mode = raw["mode"] === "LIVE" || raw["mode"] === "SIMULATION" ? raw["mode"] : null;
  return { shareId: raw["shareId"], generatedAt: typeof raw["generatedAt"] === "string" ? raw["generatedAt"] : undefined, presence: typeof raw["presence"] === "string" ? raw["presence"] : null, mode, items };
}

/** 公开值守看板走 /api/pub 代理（无 API key） */
export async function pubTaskActivity(shareId: string): Promise<{ status: number; data: PublicActivityView | null }> {
  try {
    const res = await fetch(`/api/pub/tasks/${encodeURIComponent(shareId)}/activity`, { cache: "no-store" });
    const raw = await res.json().catch(() => null);
    return { status: res.status, data: normalizePublicActivity(raw) };
  } catch {
    return { status: 0, data: null };
  }
}
