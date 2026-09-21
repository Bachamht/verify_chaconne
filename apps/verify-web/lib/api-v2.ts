"use client";
/**
 * v2 接口的唯一接入点（E2 定稿）。所有字段名假设集中在此，集成时与 C2 对齐只改这一处。
 * 路径：interfaces.md §10.4；类型：@chaconne/core/verify v2 增补。
 */
import type { Bill, DeltaExplanation, EvidenceBundle, MandateEvalStatus, MandateState, MandateStep, MandateStepState, PersonaId, PlanCandidate, PlanGoal, PlanReport, Product, ShareStatus, StepCertificate, TradeMandate } from "@chaconne/core/verify";
import { api } from "./api";

/* ---------- 假设的响应形态（C2 定稿后在此对齐） ---------- */
export interface PlanView {
  planId: string;
  clientRequestId: string;
  goal: PlanGoal;
  goalHash: string;
  report: PlanReport | null;
  evidenceMode: "LIVE" | "FIXTURE" | "SIMULATION";
  order?: { orderId: string; state: string; priceUsd: string } | null;
  createdAt: string;
}
export interface MandateEvaluationView {
  evaluationId: string;
  evaluatedAt: string;
  status: MandateEvalStatus;
  reasons: Array<{ code: string; severity: string }>;
  delta: DeltaExplanation | null;
  preparedStepIndex: string | null;
}
export interface MandateStepView {
  stepIndex: string;
  state: MandateStepState;
  step: MandateStep | null;
  stepDigest: string | null;
  validUntil: string | null;
  txHash: string | null;
  receipt: Record<string, unknown> | null;
}
export interface MandateView {
  mandateId: string;
  state: MandateState;
  owner: string;
  planId: string | null;
  jobId: string | null;
  mandate: TradeMandate;
  mandateDigest: string;
  signature: `0x${string}`;
  outputSet: `0x${string}`[];
  inputAssetKey: string;
  outputAssetKeys: string[];
  policyId: string;
  policyVersion: string;
  spent: string;
  stepsDone: number;
  maxSteps: number;
  budgetCap: string;
  perStepCap: string;
  validFrom: string;
  deadline: string;
  latestEvaluation: MandateEvaluationView | null;
  evaluations: MandateEvaluationView[];
  steps: MandateStepView[];
  evidenceMode: "LIVE" | "FIXTURE";
  createdAt: string;
  updatedAt: string;
}
export interface PreparedStep {
  status: MandateEvalStatus;
  reasons?: Array<{ code: string; severity: string }>;
  delta?: DeltaExplanation | null;
  step?: {
    stepIndex: string;
    typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }; types: Record<string, Array<{ name: string; type: string }>>; primaryType: "MandateStep"; message: MandateStep };
    stepDigest: string;
    certificate: StepCertificate;
    certificateSignature: `0x${string}`;
    attestationSigner: string;
    routerCalldata: `0x${string}`;
    outputSet: `0x${string}`[];
    approval: { token: `0x${string}`; spender: `0x${string}`; amount: string };
    guardCall: { to: `0x${string}`; functionName: "executeStep" };
    validUntil: string;
  };
  error?: string;
  message?: string;
}
export interface SimulationView {
  simulationId: string;
  goal: PlanGoal;
  report: PlanReport | null;
  verdict: string | null;
  evidenceMode: "SIMULATION" | "LIVE";
  personaId: PersonaId | null;
  createdAt: string;
  shareId?: string | null;
}
export interface ProfileView {
  ownerAddress: string;
  personaId: PersonaId;
  name: string;
  tone: "calm" | "playful" | "terse";
}
export interface TemplateView {
  templateId: string;
  authorName: string | null;
  authorPersonaId: PersonaId | null;
  kind: "job" | "plan";
  structure: { inputAssetKeys: string[]; legs: Array<{ outputAssetKey: string; weightBps: number }>; side: "buy" | "sell"; policyId: string; policyVersion: string; maxSlippageBps: number; maxPriceImpactBps: number | null; maxReferenceDeviationBps: number | null };
  createdAt: string;
}
export interface ShareView {
  shareId: string;
  kind: "job" | "mandate" | "simulation";
  refId: string;
  public: boolean;
  privacy: { amounts: "exact" | "range" | "hidden"; wallet: "hidden" };
  createdAt: string;
}
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
  templateId: string | null;
  evidenceMode: "LIVE" | "FIXTURE" | "SIMULATION";
  createdAt: string;
}

/* ---------- 响应归一化（服务端 C2 定稿字段 → 页面类型；interfaces §10 两处写法不一致，以服务实际返回为准） ---------- */
type ApiResult<T> = Awaited<ReturnType<typeof api<T>>>;
type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

/** 只在 2xx 且是对象时改形；错误体原样透传（页面读 error / message / details） */
async function mapOk<T>(p: Promise<ApiResult<unknown>>, f: (raw: Raw) => unknown): Promise<ApiResult<T>> {
  const r = await p;
  const ok = r.status >= 200 && r.status < 300 && isObj(r.data);
  return { ...r, data: (ok ? f(r.data as Raw) : r.data) as T };
}

/** 账单：服务返回 {jobId|mandateId, bill: Bill}。形状不对一律给 null——BillPanel 直接读 bill.serviceFees.length，给错对象整页白屏 */
export function normalizeBill(raw: Raw): Bill | null {
  const b = isObj(raw["bill"]) ? raw["bill"] : raw;
  return Array.isArray(b["serviceFees"]) && Array.isArray(b["principal"]) && Array.isArray(b["gas"]) ? (b as unknown as Bill) : null;
}
/** 规划：服务字段是 plan，页面读 report */
export function normalizePlan(raw: Raw): Raw {
  return { ...raw, report: raw["report"] ?? raw["plan"] ?? null };
}
/** 模拟：plan → report；mode("SIMULATION") → evidenceMode */
export function normalizeSimulation(raw: Raw): Raw {
  return { ...raw, report: raw["report"] ?? raw["plan"] ?? null, evidenceMode: raw["evidenceMode"] ?? raw["mode"] ?? "SIMULATION" };
}
/** 翻创模板：author.name → authorName；template → structure（单笔任务的模板补成单腿结构，页面两处预填共用一种形状） */
export function normalizeTemplate(raw: Raw): Raw {
  const t = isObj(raw["structure"]) ? raw["structure"] : isObj(raw["template"]) ? raw["template"] : {};
  const params = isObj(t["params"]) ? t["params"] : {};
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const legs = Array.isArray(t["legs"]) ? t["legs"] : typeof t["outputAssetKey"] === "string" ? [{ outputAssetKey: t["outputAssetKey"], weightBps: 10000 }] : [];
  const inputAssetKeys = Array.isArray(t["inputAssetKeys"]) ? t["inputAssetKeys"] : typeof t["inputAssetKey"] === "string" ? [t["inputAssetKey"]] : [];
  const author = isObj(raw["author"]) ? raw["author"] : {};
  return {
    ...raw,
    authorName: raw["authorName"] ?? (typeof author["name"] === "string" ? author["name"] : null),
    authorPersonaId: raw["authorPersonaId"] ?? (typeof author["personaId"] === "string" ? author["personaId"] : null),
    structure: {
      inputAssetKeys,
      legs,
      side: t["side"] === "sell" ? "sell" : "buy",
      policyId: typeof t["policyId"] === "string" ? t["policyId"] : "REFERENCE_CONTEXT",
      policyVersion: typeof t["policyVersion"] === "string" ? t["policyVersion"] : "1.1.0",
      maxSlippageBps: num(t["maxSlippageBps"]) ?? num(params["maxSlippageBps"]) ?? 50,
      maxPriceImpactBps: num(t["maxPriceImpactBps"]) ?? num(params["maxPriceImpactBps"]),
      maxReferenceDeviationBps: num(t["maxReferenceDeviationBps"]) ?? num(params["maxReferenceDeviationBps"]),
    },
  };
}

/* ---------- 调用 ---------- */
export const plans = {
  create: (body: PlanGoal & { clientRequestId: string }) => mapOk<PlanView & { error?: string; message?: string; details?: unknown }>(api("POST", "v1/plans", body), normalizePlan),
  get: (id: string) => mapOk<PlanView>(api("GET", `v1/plans/${id}`), normalizePlan),
  toJob: (id: string, candidateId: string) => api<{ jobId: string; error?: string; message?: string }>("POST", `v1/plans/${id}/jobs`, { candidateId, clientRequestId: `web-${Date.now()}` }),
};
export const mandates = {
  create: (body: { typedData: unknown; signature: `0x${string}`; outputSet: `0x${string}`[]; planId?: string | null; jobId?: string | null; inputAssetKey: string; outputAssetKeys: string[]; policyId: string; policyVersion: string; clientRequestId: string }) => api<MandateView & { error?: string; message?: string; details?: unknown }>("POST", "v1/mandates", body),
  get: (id: string) => api<MandateView>("GET", `v1/mandates/${id}`),
  pause: (id: string) => api<MandateView>("POST", `v1/mandates/${id}/pause`),
  resume: (id: string) => api<MandateView>("POST", `v1/mandates/${id}/resume`),
  cancel: (id: string) => api<MandateView>("POST", `v1/mandates/${id}/cancel`),
  prepareStep: (id: string) => api<PreparedStep>("POST", `v1/mandates/${id}/prepare-step`, { refreshKey: `web-${Date.now()}` }),
  submit: (id: string, n: string, txHash: `0x${string}`) => api<MandateStepView>("POST", `v1/mandates/${id}/steps/${n}/submissions`, { txHash }),
  bundle: (id: string) => api<EvidenceBundle>("GET", `v1/mandates/${id}/bundle`),
  bill: (id: string) => mapOk<Bill | null>(api("GET", `v1/mandates/${id}/bill`), normalizeBill),
};
export const jobsV2 = {
  bundle: (id: string) => api<EvidenceBundle>("GET", `v1/jobs/${id}/bundle`),
  bill: (id: string) => mapOk<Bill | null>(api("GET", `v1/jobs/${id}/bill`), normalizeBill),
};
export const products = { list: () => api<{ products: Product[] }>("GET", "v1/products") };
export const simulations = {
  create: (body: { goal: PlanGoal; personaId?: PersonaId; presetId?: string; clientRequestId: string }) => mapOk<SimulationView & { error?: string; message?: string }>(api("POST", "v1/simulations", body), normalizeSimulation),
  get: (id: string) => mapOk<SimulationView>(api("GET", `v1/simulations/${id}`), normalizeSimulation),
};
export const profiles = {
  me: () => api<ProfileView | { error: string }>("GET", "v1/profiles/me"),
  save: (p: { ownerAddress: string; personaId: PersonaId; name: string; tone: "calm" | "playful" | "terse" }) => api<ProfileView>("PUT", "v1/profiles/me", p),
};
export const templates = {
  create: (body: { kind: "job" | "plan"; refId: string }) => mapOk<TemplateView>(api("POST", "v1/templates", body), normalizeTemplate),
  get: (id: string) => mapOk<TemplateView>(api("GET", `v1/templates/${id}`), normalizeTemplate),
};
export const shares = {
  create: (body: { kind: "job" | "mandate" | "simulation"; refId: string; public: boolean; privacy: { amounts: "exact" | "range" | "hidden"; wallet: "hidden" } }) => api<ShareView>("POST", "v1/shares", body),
};
/** 公开读取走 /api/pub 代理（无 API key） */
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

export type { PlanCandidate };
