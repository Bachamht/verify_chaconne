/**
 * v7 · 托管 Agent 轮次、决策上下文、报价、记忆（Lane A，§12.8 中 agent/*、agent-context、quotes、memory）；
 * registerV7AEarly = 服务 key（authKind=service）默认拒绝路由白名单 + 轮次令牌（D-093、CV-D25）。
 * 本文件只由 Lane A 修改；app.ts 经 routes/index.ts 调用。
 */
import type { Express, NextFunction, Request, Response } from "express";
import type { AppDeps } from "../app";
import { apiKeyAuth, callerOf, rateLimit, requestApiKey, serviceKeyMatcher } from "../auth";
import { HttpError } from "../../jobs/service";
import { errorBody } from "../errors";
import { matchServiceRoute, SERVICE_RATE_LIMIT_PER_MIN } from "../../agent/routeGuard";
import { currentRunBinding, RUN_TOKEN_HEADER, runWithBinding } from "../../agent/runContext";
import type { AgentRuntime } from "../../agent/service";

/** Lane A 的服务句柄（由 src/index.ts 装配进 AppDeps.v7.a） */
export interface V7AHandles {
  runtime: AgentRuntime;
}

function deny(res: Response, status: number, error: string, message: string): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).json({ error, message });
}

/**
 * 在所有旧路由之前执行（D-093、CV-D25）：
 *  1. 请求 key 的 SHA-256 与 VERIFY_EXECUTOR_KEY_SHA256 / VERIFY_HOSTED_AGENT_KEY_SHA256 常量时间比较 → callerId = executor:hosted | agent:hosted，authKind = service；
 *  2. 服务 key 单独限频（agent 300/min、executor 600/min）；
 *  3. 默认拒绝：不在白名单 → 403 service_route_forbidden（到不了任何服务自己的鉴权）；
 *  4. agent:hosted 的任务类请求必须带 x-agent-run-token：缺失 → 403；令牌绑定的任务 / 轮次 ≠ 路由里的 → 403；旧 attempt / 租约过期 → 409；
 *     通过后把 (runId, taskId, attempt) 绑进本次请求的异步上下文，服务层 requireTask 再核一次。
 * 不是服务 key 的请求原样放行（旧行为不变）。
 */
export function registerV7AEarly(app: Express, d: AppDeps): void {
  const match = serviceKeyMatcher({ executor: d.cfg.VERIFY_EXECUTOR_KEY_SHA256, agent: d.cfg.VERIFY_HOSTED_AGENT_KEY_SHA256 });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const key = requestApiKey(req);
    if (!key) return next();
    const caller = match(key);
    if (!caller) return next();
    res.locals["callerId"] = caller;
    res.locals["authKind"] = "service";
    res.setHeader("Cache-Control", "private, no-store");
    if (!rateLimit(`service:${caller}`, SERVICE_RATE_LIMIT_PER_MIN[caller], 60_000)) {
      res.setHeader("Retry-After", "60");
      return deny(res, 429, "rate_limited", `Rate limit exceeded for this service key (${SERVICE_RATE_LIMIT_PER_MIN[caller]}/min).`);
    }
    const m = matchServiceRoute(caller, req.method, req.path);
    if (!m) return deny(res, 403, "service_route_forbidden", `${caller} may not call ${req.method} ${req.path} (default-deny route allowlist, D-093)`);
    const scope = m.rule.scope;
    if (scope === "free" || scope === "executor") return next();
    if (!d.cfg.v7.hostedAgent) return deny(res, 503, "hosted_disabled", "hosted agent is disabled (HOSTED_AGENT_ENABLED=false)");
    if (scope === "agent_open") return next();
    const contextTask = scope === "context" ? (typeof req.query["taskId"] === "string" ? req.query["taskId"] : null) : null;
    if (scope === "context" && !contextTask) return next();
    const runtime = d.v7?.a?.runtime;
    if (!runtime) return deny(res, 503, "hosted_disabled", "hosted agent runtime is not mounted");
    const token = (req.header(RUN_TOKEN_HEADER) ?? "").trim();
    if (!token) return deny(res, 403, "run_token_required", `agent:hosted task requests need ${RUN_TOKEN_HEADER} (one per claimed run)`);
    runtime
      .validateToken(token)
      .then(async (v) => {
        if (!v.ok) return deny(res, v.status, v.code, v.status === 409 ? "the run token belongs to an expired lease or an older attempt" : "unknown or invalid run token");
        const b = v.binding;
        if (scope === "agent_run" && m.resourceId !== b.runId) return deny(res, 403, "run_token_run_mismatch", "the run token is bound to another run");
        if (scope === "task" && m.resourceId !== b.taskId) return deny(res, 403, "run_token_task_mismatch", "the run token is bound to another task");
        if (scope === "context" && contextTask !== b.taskId) return deny(res, 403, "run_token_task_mismatch", "the run token is bound to another task");
        if (scope === "thesis") {
          const t = m.resourceId && d.theses ? await d.theses.byId(m.resourceId) : null;
          if (!t || t.taskId !== b.taskId) return deny(res, 403, "run_token_task_mismatch", "this thesis does not belong to the task bound to the run token");
        }
        runWithBinding(b, () => next());
      })
      .catch(next);
  });
}

/** 能力开关关闭或未装配运行时 → 不挂路由（旧行为不变） */
export function registerV7A(app: Express, d: AppDeps): void {
  const runtime = d.v7?.a?.runtime;
  if (!runtime) return;
  const auth = apiKeyAuth(d.cfg.apiKeys, d.cfg.RATE_LIMIT_PER_MIN, { open: d.cfg.authOpen, resolve: d.keys ? (k) => d.keys!.resolve(k) : undefined });
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
  const gate = (_req: Request, res: Response, next: NextFunction) => {
    if (d.cfg.v7.hostedAgent) return next();
    res.status(503).json(errorBody(new HttpError(503, "hosted_disabled", "hosted agent is disabled (HOSTED_AGENT_ENABLED=false)")));
  };
  const agentOnly = (_req: Request, res: Response, next: NextFunction) => {
    if (callerOf(res) === "agent:hosted") return next();
    res.status(403).json({ error: "agent_only", message: "only the hosted agent service key may call /v1/agent/*" });
  };
  const binding = () => {
    const b = currentRunBinding();
    if (!b) throw new HttpError(403, "run_token_required", "this call needs the run token");
    return b;
  };

  /* ---------- 轮次队列（§2.8 /v1/agent/*） ---------- */
  app.post(
    "/v1/agent/claim",
    gate,
    auth,
    agentOnly,
    wrap(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await runtime.claim(String(b["worker"] ?? ""), b["max"]);
      if (r.runs.length === 0) {
        res.status(204).end();
        return;
      }
      res.json(r);
    }),
  );
  app.post(
    "/v1/agent/heartbeat",
    gate,
    auth,
    agentOnly,
    wrap(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      await runtime.heartbeat(String(b["worker"] ?? ""), b);
      res.status(204).end();
    }),
  );
  app.post(
    "/v1/agent/runs/:runId/checkpoint",
    gate,
    auth,
    agentOnly,
    wrap(async (req, res) => {
      res.json(await runtime.checkpoint(binding(), String(req.params["runId"]), (req.body ?? {}) as Record<string, unknown>));
    }),
  );
  app.post(
    "/v1/agent/runs/:runId/complete",
    gate,
    auth,
    agentOnly,
    wrap(async (req, res) => {
      res.json(await runtime.complete(binding(), String(req.params["runId"]), (req.body ?? {}) as Record<string, unknown>));
    }),
  );

  /* ---------- 决策上下文 / 报价 / 记忆（O, H） ---------- */
  app.get(
    "/v1/tasks/:id/agent-context",
    gate,
    auth,
    wrap(async (req, res) => {
      res.json(await runtime.agentContext(callerOf(res), String(req.params["id"]), currentRunBinding()));
    }),
  );
  app.post(
    "/v1/tasks/:id/quotes",
    gate,
    auth,
    wrap(async (req, res) => {
      res.json(await runtime.quotes(callerOf(res), String(req.params["id"]), (req.body ?? {}) as Record<string, unknown>));
    }),
  );
  app.get(
    "/v1/tasks/:id/memory",
    gate,
    auth,
    wrap(async (req, res) => {
      res.json(await runtime.memoryList(callerOf(res), String(req.params["id"])));
    }),
  );
  app.post(
    "/v1/tasks/:id/memory",
    gate,
    auth,
    wrap(async (req, res) => {
      const r = await runtime.memoryAdd(callerOf(res), String(req.params["id"]), (req.body ?? {}) as Record<string, unknown>);
      res.status(r.duplicate ? 200 : 201).json(r);
    }),
  );
}
