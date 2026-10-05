/**
 * verify-service HTTP 客户端（MCP 工具唯一的后端）。
 * 不持有用户钱包私钥；付款凭证由 host 产生并作为参数传入（PAYMENT-SIGNATURE 头透传）。
 */
import type { X402Challenge, X402Payer } from "@chaconne/verify-sdk";

export interface VerifyClientOptions {
  baseUrl: string;
  apiKey: string;
  /** 通配 key（web:*）时的钱包地址 */
  caller?: string;
  fetchImpl?: typeof fetch;
  /** agent-wallet 模式下的 x402 付款人（用户自持钱包）；缺省 = 不自动付款，402 原样返回给 host */
  payer?: X402Payer | null;
  /**
   * v7（CV-D25）：托管 Agent 的一次性轮次令牌（x-agent-run-token）。缺省读环境变量 VERIFY_RUN_TOKEN；
   * 托管 Agent 每轮启动一个本进程，只给它 VERIFY_SERVICE_URL / VERIFY_API_KEY / VERIFY_RUN_TOKEN。
   */
  runToken?: string | null;
}

export const RUN_TOKEN_HEADER = "x-agent-run-token";

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  /** x402 挑战（未付款时） */
  paymentRequired: string | null;
  /** x402 结算回执（付款成功时） */
  paymentResponse: string | null;
  /** 本次调用由 agent-wallet 自动付款时的挑战摘要 */
  paid?: X402Challenge | null;
}

/** 免 key 端点（V-40）；开放模式下已不再据此拦截，保留给调用方判断 */
export const FREE_PATH_RE = /^\/(healthz|pub\/|a2mcp\/|openapi\.json|llms\.txt|\.well-known\/|v1\/(assets|policies|products|playbooks|context|events)(\/|\?|$))/;
export const API_KEY_REQUIRED = "api_key_required";

export class VerifyClient {
  private readonly f: typeof fetch;
  private readonly runToken: string | null;
  constructor(private readonly o: VerifyClientOptions) {
    this.f = o.fetchImpl ?? fetch;
    const t = o.runToken !== undefined ? o.runToken : (process.env["VERIFY_RUN_TOKEN"] ?? null);
    this.runToken = t && t.trim() ? t.trim() : null;
  }

  /** 是否带着托管 Agent 的轮次令牌 */
  get hasRunToken(): boolean {
    return this.runToken !== null;
  }

  get payer(): X402Payer | null {
    return this.o.payer ?? null;
  }

  /** 是否配置了 API key（开放模式下可无 key） */
  get hasApiKey(): boolean {
    return !!this.o.apiKey;
  }

  async call<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, extraHeaders: Record<string, string> = {}, opts: { autoPay?: boolean; auth?: boolean } = {}): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", ...extraHeaders };
    const auth = opts.auth ?? true;
    const normalizedPath = `/${path.replace(/^\//, "")}`;
    // 没有 VERIFY_API_KEY 也照常发请求：免 key 端点正常；需 key 的端点回 401 missing_api_key（带拿 key 的地址），工具层映射成 not_available
    void normalizedPath;
    if (auth && this.o.apiKey) headers["x-api-key"] = this.o.apiKey;
    if (auth && this.o.caller) headers["x-verify-caller"] = this.o.caller;
    if (auth && this.runToken) headers[RUN_TOKEN_HEADER] = this.runToken;
    const url = `${this.o.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    const send = (h: Record<string, string>) => this.f(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let res = await send(headers);
    let paid: X402Challenge | null = null;
    if (res.status === 402 && this.o.payer && (opts.autoPay ?? true)) {
      const payment = await this.o.payer.pay((n) => res.headers.get(n));
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
    };
  }
}
