/**
 * verify-service 执行者接口客户端（/v1/executor/*，鉴权 = executor:hosted 服务 key）。
 * 请求与响应里从不出现私钥；raw tx 只在 sending 事件里上报给服务端（供崩溃恢复按哈希找回 / 原样重播）。
 */
import type { ExecuteStepJobPayload, FaultSpec, PermitJobPayload } from "@chaconne/core/verify";
import type { Hex } from "viem";

export interface ClaimedJob {
  id: string;
  kind: "permit" | "execute_step";
  state: string;
  attempt: number;
  owner: Hex;
  token: Hex | null;
  taskId: string | null;
  mandateId: string | null;
  stepId: string | null;
  stepIndex: number | null;
  validUntil: string | null;
  leaseUntil: string | null;
  payload: ExecuteStepJobPayload | PermitJobPayload;
  fault: FaultSpec | null;
  rawTx: Hex | null;
  rawTxHash: Hex | null;
  txHash: Hex | null;
  recover?: boolean;
}

export type JobEvent =
  | { type: "sending"; rawTxHash?: Hex | null; nonce?: string | null; rawTx?: Hex | null }
  | { type: "sent"; txHash: Hex }
  | { type: "preflight_failed"; code: string; revert?: { cls: string; error: string | null; message?: string } | null; detail?: string }
  | { type: "receipt"; txHash: Hex; status: "success" | "reverted"; blockNumber: string; approval?: { owner: string; spender: string; value: string } | null }
  | { type: "abandoned"; reason: string };

export interface EventResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ServiceApi {
  claim(a: { executor: Hex; instanceId: string; max?: number }): Promise<{ status: number; jobs: ClaimedJob[]; error?: string }>;
  event(jobId: string, attempt: number, e: JobEvent): Promise<EventResult>;
  heartbeat(a: { executor: Hex; instanceId: string; mode: string; gasBalanceWei: string; chainHead: string; version: string; gasLow?: boolean }): Promise<{ status: number; error?: string }>;
}

export class HttpServiceApi implements ServiceApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly f: typeof fetch = fetch,
  ) {}
  private async post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await this.f(`${this.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-api-key": this.apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: r.status, body: json };
  }
  async claim(a: { executor: Hex; instanceId: string; max?: number }) {
    const r = await this.post("/v1/executor/claim", { ...a, max: a.max ?? 1 });
    return { status: r.status, jobs: (r.body["jobs"] as ClaimedJob[] | undefined) ?? [], ...(typeof r.body["error"] === "string" ? { error: r.body["error"] } : {}) };
  }
  async event(jobId: string, attempt: number, e: JobEvent) {
    return this.post(`/v1/executor/jobs/${encodeURIComponent(jobId)}/events`, { attempt, ...e });
  }
  async heartbeat(a: { executor: Hex; instanceId: string; mode: string; gasBalanceWei: string; chainHead: string; version: string; gasLow?: boolean }) {
    const r = await this.post("/v1/executor/heartbeat", a);
    return { status: r.status, ...(typeof r.body["error"] === "string" ? { error: r.body["error"] } : {}) };
  }
}
