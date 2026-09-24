"use client";
/**
 * v2 接口的唯一接入点（E2 定稿）。所有字段名假设集中在此，集成时与 C2 对齐只改这一处。
 * 路径：interfaces.md §10.4；类型：@chaconne/core/verify v2 增补。
 */
import type { Bill, BudgetAllocation, BudgetGroup, Condition, ConditionSet, DeltaExplanation, EventImpact, EvidenceBundle, MandateEvalStatus, MandateState, MandateStep, MandateStepState, MarketContext, MarketEvent, PersonaId, PlanCandidate, PlanGoal, PlanReport, PlaybookId, PolicyComparison, Product, ReplayRun, ShareStatus, StepCertificate, Task, ThesisCard, TradeMandate } from "@chaconne/core/verify";
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

/* ====================================================================== */
/* v6（Chaconne Agent · Lane F）——路径按 interfaces §11.7，类型按 contracts.ts v6 段。   */
/* 响应包装形态（{task} / {tasks} / {events} …）是页面假设，B/C/D/E 定稿后只改这一段。      */
/* 端点未部署（404 not_found / 501 / 503）→ notReady()=true，页面显示「该能力尚未就绪」空态， */
/* 绝不放假数据、不用回放冒充实时（CV-D13：provenance.mode 非 live 一律可见标注）。            */
/* ====================================================================== */
export type TaskMode = "SIMULATION" | "LIVE";
export interface MandateDraftView {
  typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }; types: Record<string, Array<{ name: string; type: string }>>; primaryType: "TradeMandate"; message: TradeMandate };
  outputSet: `0x${string}`[];
}
export interface CreateTaskBody {
  clientRequestId: string;
  ownerAddress: string;
  playbookId: PlaybookId;
  params: Record<string, unknown>;
  conditions: { version: "conditions/1"; items: Condition[] };
  mode: TaskMode;
  thesis?: Record<string, unknown>;
  budgetGroupId?: string;
}
export interface TaskCreated {
  task: Task;
  mandateDraft: MandateDraftView | null;
  thesisDraft: ThesisCard | null;
  budgetAllocation: (Partial<BudgetAllocation> & { state: string }) | null;
  /** 服务端 tasks/service.ts view() 额外字段（可选：旧部署可能没有） */
  mode?: TaskMode;
  params?: Record<string, unknown>;
  steps?: { planned: number; confirmed: number; lastConfirmedAt: string | null };
  mandates?: Array<{ mandateId: string; state: string; current?: boolean; spent?: string; stepsDone?: number; maxSteps?: number; deadline?: string; pulledUnexpiredSteps?: number[]; revokeStatus?: "none" | "pending" | "confirmed" }>;
  evidenceMode?: string;
}
/** prepare-step 的响应（tasks/service.ts prepareStep）：200 READY / 409 WAIT；SIMULATION 不签证书 */
export interface PrepareStepView extends PreparedStep {
  taskId?: string;
  taskStatus?: string;
  blockers?: Task["blockers"];
  nextCheckAt?: string | null;
  mode?: "SIMULATION";
  note?: string;
}
/** 服务侧停止（D-088）：响应体里的 note 必须写明只阻止后续签发 */
export interface TaskStopped {
  task: Task;
  note: string;
}
export interface ExplainWaitView {
  /** Lane E 的响应没有顶层 taskId（任务 id 在路径里） */
  taskId?: string;
  blockers: Task["blockers"];
  nextCheckAt: string | null;
  /** 服务端实际返回：需要用户处理的阻塞项**子集**（数组），不是布尔；每个 blocker 自己也带 userActionRequired */
  userActionRequired: Task["blockers"];
  i18n?: Array<{ code: string; en: string; zh: string }>;
  contextProvenance?: string | null;
  evidenceAt?: string | null;
}
export interface PortfolioView {
  owner: string;
  chainId: number;
  /** 服务端实际返回 block:{number,hash,timestamp}；旧字段 blockNumber 兼容保留为可选 */
  block?: { number: number; hash?: string; timestamp?: number | string };
  blockNumber?: number;
  /** 服务端把 tracedQtyRaw 剥掉了（成本只覆盖可追溯数量，覆盖率走 coverage.coverageBps）；这里一律当可选。
   *  unavailable=true 表示链上读取失败：balanceRaw 是 "0" 占位，**不能当真实 0**（V-31） */
  holdings: Array<{ assetKey: string; symbol?: string; displaySymbol?: string; underlyingId?: string; decimals?: number; balanceRaw: string; unavailable?: boolean; priceUsd?: string | null; tracedQtyRaw?: string | null; costUsd?: string | null; costCoverageBps?: number | null; coverage?: { coverageBps: number | null; unknownQtyRaw?: string; note?: string } | null; traced?: { qtyRaw: string | null; costRaw: string | null; costAssetKey?: string | null } | null; userReported?: { qtyRaw: string; costRaw: string } | null; source?: string }>;
  /** 资金币种余额（服务端 portfolio/service.ts）：同样带 unavailable */
  cash?: Array<{ assetKey: string; symbol: string; balanceRaw: string; decimals: number; unavailable: boolean }>;
  authorizations?: unknown[];
  budgetGroups?: unknown[];
  notes?: Record<string, string>;
  /** 乘数调整换算标注（Q-04） */
  unitAdjustments?: Array<{ assetKey: string; note: string }>;
}
export interface BudgetGroupView extends BudgetGroup {
  spentRaw?: string;
  reservedRaw?: string;
  pendingRaw?: string;
  allocations: BudgetAllocation[];
}
export type RecapMode = "LIVE" | "SIMULATION" | "REPLAY" | "FIXTURE";
export interface RecapView {
  id: string;
  owner: string;
  date: string;
  tz: "America/New_York";
  closeAtUtc: string;
  earlyClose: boolean;
  generateAfterUtc: string;
  generatedAt: string;
  modes: RecapMode[];
  coverage: { mandates: "ok" | "unavailable"; tasks: "ok" | "unavailable"; events: "ok" | "unavailable" };
  sections: {
    handled: Array<{ refId: string; refKind: "mandate" | "task"; label: string; status: string; mode: RecapMode; steps: { done: number; max: number }; blockers: Array<{ code: string; text: string }>; nextCheckAt: string | null }>;
    waited: Array<{ refId: string; label: string; reasons: Array<{ code: string; text: string }>; evaluations: number; nextCheckAt: string | null }>;
    trades: Array<{ at: string; refId: string; stepIndex: number; side: "buy" | "sell"; inputAssetKey: string; outputAssetKey: string; amountInRaw: string; receivedRaw: string | null; txHash: string | null; state: string; mode: RecapMode }>;
    remaining: Array<{ refId: string; label: string; stepsLeft: number; deadline: string }>;
    decisions: Array<{ refId: string; label: string; code: string; text: string; action: string }>;
  };
  ledger: Array<{ assetKey: string; spentRaw: string; receivedRaw: string; steps: number }>;
  timeline: Array<{ at: string; refId: string; type: string; text: string; assetKey?: string; amountRaw?: string; txHash?: string | null }>;
  milestones: Array<{ id: string; label: { en: string; zh: string }; at: string; evidence: { refId: string; txHash?: string | null } }>;
  remixable: Array<{ refId: string; refKind: "mandate" | "task"; structure: { side: "buy" | "sell"; inputAssetKey: string; outputAssetKeys: string[]; policyId?: string; steps: number }; remixHref: string }>;
  share: { public: boolean; hideAssets: boolean; hideAmounts: boolean; shareId: string | null; publicUrl: string | null };
}
export interface RecapPendingView {
  status: "pending";
  owner: string;
  date: string;
  closeAtUtc: string | null;
  earlyClose: boolean;
  generateAfterUtc: string | null;
  tradingDay: boolean;
  note: string;
}
export interface MissionView {
  id: string;
  kind: "event" | "replay" | "simulation";
  mode: "SIMULATION" | "REPLAY";
  title: { en: string; zh: string };
  why: { en: string; zh: string };
  dateLabel: string;
  eventId: string | null;
  eventKind: string | null;
  eventStatus: string | null;
  assetKey: string | null;
  underlyingId: string | null;
  draft: { playbookId: PlaybookId; mode: "SIMULATION" | "REPLAY"; params: Record<string, unknown>; conditions: ConditionSet };
  href: string;
}

/** 端点未部署 → 页面显示「该能力尚未就绪」（不是错误，不是数据） */
export function notReady(r: { status: number; data: unknown }): boolean {
  if (r.status === 501 || r.status === 503 || r.status === 502) return true;
  if (r.status !== 404) return false;
  const err = (r.data as { error?: string } | null)?.error;
  return err === undefined || err === "not_found" || err === "not_allowed";
}
/** {task:{…}} 或平铺 → Task */
export function normalizeTask(raw: Raw): Raw {
  const t = isObj(raw["task"]) ? raw["task"] : raw;
  return { ...raw, task: { ...t, blockers: Array.isArray(t["blockers"]) ? t["blockers"] : [], mandateIds: Array.isArray(t["mandateIds"]) ? t["mandateIds"] : [], executorPresence: t["executorPresence"] ?? "offline", nextCheckAt: t["nextCheckAt"] ?? null }, mandateDraft: raw["mandateDraft"] ?? null, thesisDraft: raw["thesisDraft"] ?? null, budgetAllocation: raw["budgetAllocation"] ?? null };
}
function normalizeList<K extends string>(key: K) {
  return (raw: Raw): Raw => ({ ...raw, [key]: Array.isArray(raw[key]) ? raw[key] : Array.isArray(raw["items"]) ? raw["items"] : [] });
}
const q = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};

export const agentTasks = {
  create: (body: CreateTaskBody) => mapOk<TaskCreated & { error?: string; message?: string; details?: unknown }>(api("POST", "v1/tasks", body), normalizeTask),
  get: (id: string) => mapOk<TaskCreated>(api("GET", `v1/tasks/${id}`), normalizeTask),
  list: (owner: string) => mapOk<{ tasks: Task[] }>(api("GET", `v1/tasks${q({ owner })}`), normalizeList("tasks")),
  pause: (id: string) => mapOk<TaskStopped>(api("POST", `v1/tasks/${id}/pause`), normalizeTask),
  resume: (id: string) => mapOk<TaskStopped>(api("POST", `v1/tasks/${id}/resume`), normalizeTask),
  cancel: (id: string) => mapOk<TaskStopped>(api("POST", `v1/tasks/${id}/cancel`), normalizeTask),
  authorize: (id: string, body: { typedData: MandateDraftView["typedData"]; signature: `0x${string}`; outputSet: `0x${string}`[]; clientRequestId: string }) => mapOk<TaskCreated & { mandateId?: string }>(api("POST", `v1/tasks/${id}/authorize`, body), normalizeTask),
  prepareStep: (id: string) => api<PrepareStepView>("POST", `v1/tasks/${id}/prepare-step`, { refreshKey: `web-${Date.now()}` }),
  explainWait: (id: string) => api<ExplainWaitView>("GET", `v1/tasks/${id}/explain-wait`),
  comparePolicies: (id: string, variants: Array<{ label: string; conditions: { version: "conditions/1"; items: Condition[] } }>) => api<PolicyComparison>("POST", `v1/tasks/${id}/compare-policies`, { variants }),
};
export const marketContext = {
  get: (o: { tier?: "agent" | "display"; assetKey?: string; owner?: string; taskId?: string } = {}) => api<MarketContext>("GET", `v1/context${q({ tier: "agent", ...o })}`),
};
export const marketEvents = {
  list: (o: { from?: string; to?: string; underlyingId?: string; kind?: string } = {}) => mapOk<{ events: MarketEvent[] }>(api("GET", `v1/events${q(o)}`), normalizeList("events")),
  impacts: (owner: string, horizonHours = 48) => mapOk<{ impacts: EventImpact[] }>(api("GET", `v1/event-impacts${q({ owner, horizonHours })}`), normalizeList("impacts")),
};
export const replays = {
  create: (body: { playbookId: PlaybookId; conditions: { version: "conditions/1"; items: Condition[] }; assetKey: string; from: string; to: string }) => api<ReplayRun>("POST", "v1/replays", body),
};
export const budgetGroups = {
  get: (id: string) => mapOk<BudgetGroupView>(api("GET", `v1/budget-groups/${id}`), normalizeList("allocations")),
  create: (body: Omit<BudgetGroup, "id" | "priorityRule">) => api<BudgetGroupView>("POST", "v1/budget-groups", { ...body, priorityRule: "priority_then_created" }),
};
export const portfolio = {
  get: (owner: string) => mapOk<PortfolioView>(api("GET", `v1/portfolio/${owner}`), normalizeList("holdings")),
};
export const recaps = {
  /** refresh=1：服务端重新生成（V-35「重新生成」按钮） */
  list: (owner: string, date?: string, refresh = false) => api<RecapView | RecapPendingView>("GET", `v1/recaps${q({ owner, date, refresh: refresh ? 1 : undefined })}`),
  get: (id: string) => api<RecapView>("GET", `v1/recaps/${id}`),
  share: (id: string, body: { public: boolean; hideAssets?: boolean; hideAmounts?: boolean }) => api<{ recapId: string; share: RecapView["share"] }>("POST", `v1/recaps/${id}/share`, body),
};
export const missions = {
  list: (o: { assetKey?: string } = {}) => mapOk<{ generatedAt: string; eventsCoverage: "ok" | "unavailable"; missions: MissionView[] }>(api("GET", `v1/missions${q(o)}`), normalizeList("missions")),
};
export function isRecapPending(x: RecapView | RecapPendingView | null | undefined): x is RecapPendingView {
  return !!x && (x as RecapPendingView).status === "pending";
}
/** CV-D13：上下文来源模式；缺省按 live 处理只对签名验过的服务响应成立，页面一律显式显示 */
export function contextProvenance(ctx: MarketContext | null | undefined): "live" | "backfill" | "sample" | "unknown" {
  const m = (ctx as { provenance?: { mode?: string } } | null | undefined)?.provenance?.mode;
  return m === "live" || m === "backfill" || m === "sample" ? m : "unknown";
}
