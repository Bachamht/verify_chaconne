/**
 * 轮次令牌的请求级绑定（CV-D25）：registerV7AEarly 校验 x-agent-run-token 后，用 AsyncLocalStorage 把
 * (runId, taskId, attempt) 绑在本次请求的异步上下文里。各服务的 requireTask(callerId, id, op) 对 agent:hosted
 * 再核一次「路由里的任务 == 令牌绑定的任务」（纵深防御：中间件挡一次、服务挡一次）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunBinding {
  runId: string;
  taskId: string;
  turnVersion: number;
  attempt: number;
  leaseUntil: Date;
}

const als = new AsyncLocalStorage<RunBinding>();

export function runWithBinding<T>(b: RunBinding, fn: () => T): T {
  return als.run(b, fn);
}

/** 当前请求绑定的轮次（只有 agent:hosted 且带有效令牌的请求才有） */
export function currentRunBinding(): RunBinding | null {
  return als.getStore() ?? null;
}

/** 令牌格式：rt1.<runId>.<attempt>.<64 hex 随机>；服务端只存整串的 sha256 */
export const RUN_TOKEN_RE = /^rt1\.(run_[0-9a-f]+)\.(\d{1,3})\.([0-9a-f]{64})$/;
export function parseRunToken(token: string): { runId: string; attempt: number } | null {
  const m = RUN_TOKEN_RE.exec(token);
  return m ? { runId: m[1]!, attempt: Number(m[2]) } : null;
}
export const RUN_TOKEN_HEADER = "x-agent-run-token";
