/**
 * @chaconne/verify-sdk — Chaconne Verify HTTP 服务的类型化客户端。
 * - 路径与状态码见 docs/devday-2026/interfaces.md §5 与 §10.4（冻结）。
 * - 可选 x402 自动付款：提供 `x402Signer`（用户自持钱包的 signTypedData）后，402 会自动签 EIP-3009 授权并重发一次；
 *   `onBeforePayment` 可拒绝（额度控制）。本包不持有私钥、不广播交易。
 * - 所有方法返回 `{ status, body, paymentRequired, paymentResponse, paid }`，不吞错：非 2xx 由调用方判断。
 */
import type { Bill, CreateVerifyJob, EvidenceBundle, PlanGoal, Product, StepCertificate, MandateStep, TradeMandate, VerifyReport } from "@chaconne/core/verify";
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

export type Method = "GET" | "POST" | "PUT";

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
    },
  };
}

export type VerifySdkClient = ReturnType<typeof createClient>;
