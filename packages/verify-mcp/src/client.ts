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
}

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

export class VerifyClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: VerifyClientOptions) {
    this.f = o.fetchImpl ?? fetch;
  }

  get payer(): X402Payer | null {
    return this.o.payer ?? null;
  }

  async call<T = unknown>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, extraHeaders: Record<string, string> = {}, opts: { autoPay?: boolean; auth?: boolean } = {}): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json", ...extraHeaders };
    const auth = opts.auth ?? true;
    if (auth && this.o.apiKey) headers["x-api-key"] = this.o.apiKey;
    if (auth && this.o.caller) headers["x-verify-caller"] = this.o.caller;
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
