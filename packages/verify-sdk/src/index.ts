/**
 * @chaconne/verify-sdk — Chaconne Verify HTTP 服务的类型化客户端。
 * - 路径与状态码见 docs/devday-2026/interfaces.md §5 与 §10.4（冻结）。
 * - 可选 x402 自动付款：提供 `x402Signer`（用户自持钱包的 signTypedData）后，402 会自动签 EIP-3009 授权并重发一次；
 *   `onBeforePayment` 可拒绝（额度控制）。本包不持有私钥、不广播交易。
 * - 所有方法返回 `{ status, body, paymentRequired, paymentResponse, paid }`，不吞错：非 2xx 由调用方判断。
 */
import type { Bill, BudgetGroup, Condition, ConditionSet, CreateVerifyJob, EvidenceBundle, EventImpact, EventKind, MarketContext, MarketEvent, PlanGoal, PlaybookId, PolicyComparison, Product, ReplayRun, StepCertificate, MandateStep, Task, ThesisCard, ThesisOnInvalidation, TradeMandate, VerifyReport } from "@chaconne/core/verify";
import { createX402Payer, type Hex, type X402Challenge, type X402Payer, type X402PayerOptions, type X402Signer } from "./x402";

export { createX402Payer, amountUsdEstimate, DEFAULT_X402_NETWORKS } from "./x402";
export type { Hex, X402Challenge, X402Payer, X402Signer, X402PayerOptions } from "./x402";

export interface ClientOptions {
  baseUrl: string;
  /** /v1 路径需要；A2MCP 与 /pub 不需要 */
  apiKey?: string;
  /** 通配 key（web:*）时的钱包地址；也用于 profiles/me */
  caller?: string;
  /** 提供后自动付款（402 → 签授权 → 重发） */
  x402Signer?: X402Signer;
  x402Networks?: string[];
  onBeforePayment?: X402PayerOptions["onBeforePayment"];
  onPayment?: X402PayerOptions["onPayment"];
  fetchImpl?: typeof fetch;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  paymentRequired: string | null;
  paymentResponse: string | null;
  /** 本次调用实际发起的付款（自动付款时） */
  paid: X402Challenge | null;
  settle: Record<string, unknown> | null;
}

export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** 常用请求体（字段以 core contracts 为准；这里只做便捷类型） */
export type CreateJobBody = Omit<CreateVerifyJob, "recipientAddress" | "executionChainId" | "mode" | "policyVersion" | "maxReferenceDeviationBps"> & Partial<Pick<CreateVerifyJob, "recipientAddress" | "executionChainId" | "mode" | "policyVersion" | "maxReferenceDeviationBps">>;
export interface CreatePlanBody extends PlanGoal {
  clientRequestId: string;
}
export interface CreateMandateBody {
  typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: "TradeMandate"; message: TradeMandate };
  signature: Hex;
  planId?: string;
  jobId?: string;
  clientRequestId?: string;
  /** SKU：task_bundle | monitor_window */
  sku?: "task_bundle" | "monitor_window";
}
export interface PrepareStepResponse {
  status: "READY" | "WAIT" | "BLOCKED" | "DONE";
  stepIndex?: string;
  typedData?: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: "MandateStep"; message: MandateStep };
  step?: MandateStep;
  stepDigest?: Hex;
  certificate?: StepCertificate;
  certificateSignature?: Hex;
  routerCalldata?: Hex;
  outputSet?: Hex[];
  planGuard?: Hex;
  validUntil?: string;
  reasons?: unknown[];
  delta?: unknown;
  [k: string]: unknown;
}

/* ---------- v6（Chaconne Agent，interfaces §11.7；字段以 core contracts v6 段为准，响应包装形态是 Lane F 假设，集成时对齐） ---------- */
export type TaskMode = "SIMULATION" | "LIVE";
export interface CreateTaskBody {
  clientRequestId: string;
  ownerAddress: string;
  playbookId: PlaybookId;
  params: Record<string, unknown>;
  /** 传 items 即可；服务端算 hash。也接受完整 ConditionSet */
  conditions: { version: "conditions/1"; items: Condition[]; hash?: string } | ConditionSet;
  mode: TaskMode;
  thesis?: Partial<Pick<ThesisCard, "goal" | "rationale" | "premises" | "validUntil" | "onInvalidation">>;
  budgetGroupId?: string;
}
/** POST /v1/tasks 的返回：任务 + 待签授权草案 + 理由卡草案 + 资金组分配结果 */
export interface CreateTaskResponse {
  task: Task;
  mandateDraft?: { typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: "TradeMandate"; message: TradeMandate }; outputSet: Hex[] } | null;
  thesisDraft?: ThesisCard | null;
  budgetAllocation?: { state: string; reservedRaw?: string } | null;
  [k: string]: unknown;
}
/** 服务侧停止语义（D-088）：响应体必须写明只阻止后续签发 */
export interface TaskStopResponse {
  task: Task;
  note: string;
  [k: string]: unknown;
}
export interface ExplainWaitResponse {
  taskId?: string;
  blockers: Task["blockers"];
  nextCheckAt: string | null;
  /** 服务端实际返回：需要用户处理的阻塞项子集（数组），不是布尔 */
  userActionRequired: unknown[];
  [k: string]: unknown;
}
export interface RecapShareBody {
  public: boolean;
  hideAssets?: boolean;
  hideAmounts?: boolean;
}

export class VerifyHttp {
  private readonly f: typeof fetch;
  readonly payer: X402Payer | null;
  constructor(private readonly o: ClientOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.payer = o.x402Signer ? createX402Payer({ signer: o.x402Signer, ...(o.x402Networks ? { networks: o.x402Networks } : {}), ...(o.onBeforePayment ? { onBeforePayment: o.onBeforePayment } : {}), ...(o.onPayment ? { onPayment: o.onPayment } : {}) }) : null;
  }

  url(path: string): string {
    return `${this.o.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  }

  async request<T = unknown>(method: Method, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, opts: { auth?: boolean; autoPay?: boolean } = {}): Promise<ApiResult<T>> {
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", ...extraHeaders };
    if (auth && this.o.apiKey) headers["x-api-key"] = this.o.apiKey;
    if (auth && this.o.caller) headers["x-verify-caller"] = this.o.caller;
    const send = (h: Record<string, string>) => this.f(this.url(path), { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let res = await send(headers);
    let paid: X402Challenge | null = null;
    if (res.status === 402 && this.payer && (opts.autoPay ?? true)) {
      const payment = await this.payer.pay((n) => res.headers.get(n));
      if (payment) {
        paid = payment.challenge;
        res = await send({ ...headers, ...payment.headers });
      }
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: "invalid_json", raw: text.slice(0, 500) };
    }
    return {
      status: res.status,
      body: parsed as T,
      paymentRequired: res.headers.get("payment-required"),
      paymentResponse: res.headers.get("payment-response"),
      paid,
      settle: paid && this.payer ? this.payer.parseSettle((n) => res.headers.get(n)) : null,
    };
  }
}

function qs(q: Record<string, string | number | undefined>): string {
  const parts = Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** v6：端点未部署（404/501/503）→ 调用方应显示「尚未就绪」，不要用假数据或回放伪装 */
export function isNotAvailable(r: { status: number; body: unknown }): boolean {
  if (r.status === 501 || r.status === 503) return true;
  if (r.status !== 404) return false;
  const err = (r.body as { error?: string } | null)?.error;
  return err === "not_found" || err === "not_allowed" || err === undefined;
}

export function createClient(o: ClientOptions) {
  const h = new VerifyHttp(o);
  const enc = encodeURIComponent;
  return {
    http: h,
    payerAddress: h.payer?.address ?? null,
    request: h.request.bind(h),
    assets: () => h.request("GET", "/v1/assets"),
    policies: () => h.request("GET", "/v1/policies"),
    products: () => h.request<{ products: Product[] }>("GET", "/v1/products"),
    healthz: () => h.request("GET", "/healthz", undefined, {}, { auth: false }),
    jobs: {
      create: (body: CreateJobBody) => h.request("POST", "/v1/jobs", { mode: "exactIn", executionChainId: 196, policyVersion: "1.1.0", recipientAddress: body.ownerAddress, maxReferenceDeviationBps: null, ...body }),
      get: (jobId: string) => h.request("GET", `/v1/jobs/${enc(jobId)}`),
      /** 未付且无 signer → 402（body.paymentRequired 头可交给外部钱包）；有 signer → 自动付款 */
      report: (jobId: string, version?: number, extraHeaders: Record<string, string> = {}) => h.request<{ report: VerifyReport; reportHash: Hex; evidence: unknown[] }>("GET", `/v1/jobs/${enc(jobId)}/report${version ? `?version=${version}` : ""}`, undefined, extraHeaders),
      prepareExecution: (jobId: string, refreshKey: string) => h.request("POST", `/v1/jobs/${enc(jobId)}/prepare-execution`, { refreshKey }),
      /** intentSignature：owner 对 TradeIntent 的签名；传了才会进证据包（bundle 校验 cert_N_intent_digest 依赖它） */
      submit: (jobId: string, attemptId: string, txHash: Hex, intentSignature?: Hex) => h.request("POST", `/v1/jobs/${enc(jobId)}/submissions`, { attemptId, txHash, ...(intentSignature ? { intentSignature } : {}) }),
      bundle: (jobId: string) => h.request<EvidenceBundle>("GET", `/v1/jobs/${enc(jobId)}/bundle`),
      /** 线上形状是 {jobId, bill}（interfaces §10 C2 定稿），不是裸 Bill */
      bill: (jobId: string) => h.request<{ jobId: string; bill: Bill }>("GET", `/v1/jobs/${enc(jobId)}/bill`),
    },
    plans: {
      create: (body: CreatePlanBody) => h.request("POST", "/v1/plans", body),
      get: (planId: string) => h.request("GET", `/v1/plans/${enc(planId)}`),
      /** 把 recommended（或指定 candidateId）转成 job */
      toJob: (planId: string, candidateId?: string, clientRequestId?: string) => h.request("POST", `/v1/plans/${enc(planId)}/jobs`, { ...(candidateId ? { candidateId } : {}), ...(clientRequestId ? { clientRequestId } : {}) }),
    },
    mandates: {
      create: (body: CreateMandateBody) => h.request("POST", "/v1/mandates", body),
      get: (id: string) => h.request("GET", `/v1/mandates/${enc(id)}`),
      pause: (id: string) => h.request("POST", `/v1/mandates/${enc(id)}/pause`),
      resume: (id: string) => h.request("POST", `/v1/mandates/${enc(id)}/resume`),
      cancel: (id: string) => h.request("POST", `/v1/mandates/${enc(id)}/cancel`),
      prepareStep: (id: string) => h.request<PrepareStepResponse>("POST", `/v1/mandates/${enc(id)}/prepare-step`),
      submitStep: (id: string, stepIndex: string | number, txHash: Hex) => h.request("POST", `/v1/mandates/${enc(id)}/steps/${stepIndex}/submissions`, { txHash }),
      bundle: (id: string) => h.request<EvidenceBundle>("GET", `/v1/mandates/${enc(id)}/bundle`),
      bill: (id: string) => h.request<{ mandateId: string; bill: Bill }>("GET", `/v1/mandates/${enc(id)}/bill`),
    },
    simulations: {
      create: (body: Record<string, unknown>) => h.request("POST", "/v1/simulations", body),
      get: (id: string) => h.request("GET", `/v1/simulations/${enc(id)}`),
    },
    profiles: {
      me: () => h.request("GET", "/v1/profiles/me"),
      update: (body: Record<string, unknown>) => h.request("PUT", "/v1/profiles/me", body),
    },
    templates: {
      create: (body: Record<string, unknown>) => h.request("POST", "/v1/templates", body),
      get: (id: string) => h.request("GET", `/v1/templates/${enc(id)}`),
    },
    shares: {
      create: (body: Record<string, unknown>) => h.request("POST", "/v1/shares", body),
      getPublic: (shareId: string) => h.request("GET", `/pub/reports/${enc(shareId)}`, undefined, {}, { auth: false }),
    },
    a2mcp: {
      verify: (params: Record<string, unknown>) => h.request("POST", "/a2mcp/verify", params, {}, { auth: false }),
      plan: (params: Record<string, unknown>) => h.request("POST", "/a2mcp/plan", params, {}, { auth: false }),
      /** v6：owner 或资产集合 → 事件影响 + 任务草案（审核期价格 0，只回 200） */
      agentTasks: (params: { owner?: string; assets?: string[]; horizonHours?: number }) => h.request("POST", "/a2mcp/agent-tasks", params, {}, { auth: false }),
    },
    /* ---------- v6（interfaces §11.7）：未部署的端点返回 404/501/503，调用方据此显示「尚未就绪」，不要伪装 ---------- */
    context: {
      /** C1；免费档 tier=agent；永远 200，字段级 unavailable */
      get: (q: { tier?: "agent" | "paid" | "display"; assetKey?: string; owner?: string; taskId?: string } = {}) => h.request<MarketContext>("GET", `/v1/context${qs(q)}`),
    },
    events: {
      list: (q: { from?: string; to?: string; underlyingId?: string; kind?: EventKind } = {}) => h.request<{ events: MarketEvent[] } | MarketEvent[]>("GET", `/v1/events${qs(q)}`),
      revisions: (id: string) => h.request<{ revisions: MarketEvent[] }>("GET", `/v1/events/${enc(id)}/revisions`),
      /** C6 影响清单 */
      impacts: (owner: string, horizonHours = 48) => h.request<{ impacts: EventImpact[] } | EventImpact[]>("GET", `/v1/event-impacts${qs({ owner, horizonHours })}`),
    },
    tasks: {
      create: (body: CreateTaskBody) => h.request<CreateTaskResponse>("POST", "/v1/tasks", body),
      get: (id: string) => h.request<{ task: Task } | Task>("GET", `/v1/tasks/${enc(id)}`),
      list: (owner: string) => h.request<{ tasks: Task[] } | Task[]>("GET", `/v1/tasks${qs({ owner })}`),
      pause: (id: string) => h.request<TaskStopResponse>("POST", `/v1/tasks/${enc(id)}/pause`),
      resume: (id: string) => h.request<TaskStopResponse>("POST", `/v1/tasks/${enc(id)}/resume`),
      /** 只阻止后续签发；已取走且未过期的证书仍可能可执行；彻底停止以链上 revokeMandate 确认为准（D-088） */
      cancel: (id: string) => h.request<TaskStopResponse>("POST", `/v1/tasks/${enc(id)}/cancel`),
      authorize: (id: string, body: { typedData: CreateMandateBody["typedData"]; signature: Hex; outputSet?: Hex[]; clientRequestId?: string }) => h.request("POST", `/v1/tasks/${enc(id)}/authorize`, body),
      prepareStep: (id: string) => h.request<PrepareStepResponse>("POST", `/v1/tasks/${enc(id)}/prepare-step`),
      explainWait: (id: string) => h.request<ExplainWaitResponse>("GET", `/v1/tasks/${enc(id)}/explain-wait`),
      comparePolicies: (id: string, variants: Array<{ label: string; conditions: { version: "conditions/1"; items: Condition[] } }>) => h.request<PolicyComparison>("POST", `/v1/tasks/${enc(id)}/compare-policies`, { variants }),
    },
    executor: {
      /** agent-wallet 执行器心跳（60 s）→ 204 */
      heartbeat: (mandateId: string, body: Record<string, unknown> = {}) => h.request("POST", `/v1/mandates/${enc(mandateId)}/executor/heartbeat`, body),
    },
    theses: {
      create: (body: { taskId: string; goal: string; rationale: string; premises: ThesisCard["premises"]; validUntil: string; onInvalidation: ThesisOnInvalidation }) => h.request<ThesisCard>("POST", "/v1/theses", body),
      get: (id: string) => h.request<ThesisCard>("GET", `/v1/theses/${enc(id)}`),
      addReviewItem: (id: string, body: { premiseId: string; side: "support" | "counter"; text: string; sourceUrl: string }) => h.request("POST", `/v1/theses/${enc(id)}/review-items`, body),
    },
    budgetGroups: {
      create: (body: Omit<BudgetGroup, "id" | "priorityRule"> & { priorityRule?: "priority_then_created" }) => h.request<BudgetGroup>("POST", "/v1/budget-groups", body),
      get: (id: string) => h.request<BudgetGroup & { allocations?: unknown[] }>("GET", `/v1/budget-groups/${enc(id)}`),
      allocate: (id: string, body: { taskId: string; mandateId: string; priority: number }) => h.request("POST", `/v1/budget-groups/${enc(id)}/allocations`, body),
    },
    portfolio: {
      get: (owner: string) => h.request("GET", `/v1/portfolio/${enc(owner)}`),
      costOverride: (owner: string, body: { assetKey: string; qtyRaw: string; costUsd: string; note?: string }) => h.request("POST", `/v1/portfolio/${enc(owner)}/cost-overrides`, body),
    },
    notify: {
      registerWebhook: (body: { url: string; secret: string; types?: string[] }) => h.request("POST", "/v1/notify/webhooks", body),
      getWebhook: (id: string) => h.request("GET", `/v1/notify/webhooks/${enc(id)}`),
      deleteWebhook: (id: string) => h.request("DELETE", `/v1/notify/webhooks/${enc(id)}`),
      linkTelegram: (body: Record<string, unknown> = {}) => h.request("POST", "/v1/notify/telegram/link", body),
      test: () => h.request("POST", "/v1/notify/test", {}),
    },
    replays: {
      create: (body: { playbookId: PlaybookId; conditions: { version: "conditions/1"; items: Condition[] }; assetKey: string; from: string; to: string }) => h.request<ReplayRun>("POST", "/v1/replays", body),
      get: (id: string) => h.request<ReplayRun>("GET", `/v1/replays/${enc(id)}`),
    },
    rebalance: {
      preview: (body: Record<string, unknown>) => h.request("POST", "/v1/rebalance/preview", body),
      createPlan: (body: Record<string, unknown>) => h.request("POST", "/v1/rebalance/plans", body),
      getPlan: (id: string) => h.request("GET", `/v1/rebalance/plans/${enc(id)}`),
    },
    recaps: {
      /** date 缺省 = 最近一个已到生成门槛的交易日；门槛未到 → 200 {status:"pending"} */
      list: (owner: string, date?: string) => h.request("GET", `/v1/recaps${qs({ owner, date })}`),
      get: (id: string) => h.request("GET", `/v1/recaps/${enc(id)}`),
      share: (id: string, body: RecapShareBody) => h.request("POST", `/v1/recaps/${enc(id)}/share`, body),
      getPublic: (shareId: string) => h.request("GET", `/pub/recaps/${enc(shareId)}`, undefined, {}, { auth: false }),
    },
    missions: {
      list: (q: { assetKey?: string; horizonDays?: number } = {}) => h.request("GET", `/v1/missions${qs(q)}`),
    },
  };
}

export type VerifySdkClient = ReturnType<typeof createClient>;
