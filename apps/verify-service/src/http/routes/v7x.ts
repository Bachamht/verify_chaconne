/**
 * v7 · 委托 / 额度 / 执行作业 / 执行者 / 运营者故障注入 / 任务持仓（Lane X，§12.8 中 delegation、allowances、owners/*、handover、positions、executor/*、ops/*）
 * 本文件只由 Lane X 修改；app.ts 经 routes/index.ts 调用 registerV7X。
 * 每条路由先看能力开关：关闭 → 503 hosted_disabled（不经任何服务逻辑）；再过 API key 鉴权。
 *   执行者路由只认 callerId = executor:hosted（Lane A 的服务 key 鉴权落地后由默认拒绝中间件进一步限制）；
 *   运营者路由要求运营者 key，且服务身份（executor:hosted / agent:hosted）永远不是运营者（SEC-01）。
 */
import type { Express, NextFunction, Request, Response } from "express";
import { FAULT_KINDS, type FaultKind } from "@chaconne/core/verify";
import type { AppDeps } from "../app";
import { apiKeyAuth, callerOf, isOperator } from "../auth";
import { HttpError } from "../../jobs/service";
import type { DelegationService } from "../../delegation/service";
import type { PermitDomains } from "../../delegation/domains";
import type { ExecutionJobs } from "../../execution/jobs";
import type { OpsState } from "../../execution/ops";
import type { JobOutcomeHandler } from "../../execution/recertify";
import type { FeeBudget } from "../../execution/fees";

/** Lane X 的服务句柄（由 src/index.ts 装配进 AppDeps.v7.x） */
export interface V7XHandles {
  readonly lane: "x";
  delegation: DelegationService;
  jobs: ExecutionJobs | null;
  ops: OpsState;
  domains: PermitDomains;
  outcomes: JobOutcomeHandler | null;
  /** 执行身份费用预算（D-089 修订） */
  fees?: FeeBudget | null;
}

const SERVICE_CALLERS = new Set(["executor:hosted", "agent:hosted"]);

export function registerV7X(app: Express, d: AppDeps): void {
  const x = d.v7?.x;
  if (!x) return;
  const cfg = d.cfg;
  const auth = apiKeyAuth(cfg.apiKeys, cfg.RATE_LIMIT_PER_MIN, { open: cfg.authOpen, resolve: d.keys ? (k) => d.keys!.resolve(k) : undefined });
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
  const flag = (on: () => boolean, what: string) => (_req: Request, res: Response, next: NextFunction) => {
    if (!on()) {
      res.status(503).json({ error: "hosted_disabled", message: `${what} is not enabled on this deployment` });
      return;
    }
    next();
  };
  const delegationOn = flag(() => cfg.v7.delegation, "v7 delegation (AGENT_V7_DELEGATION_ENABLED)");
  const anyV7 = flag(() => cfg.v7.delegation || cfg.v7.hostedAgent || cfg.v7.hostedExecutor, "v7 hosted runtime");
  const positionsOn = flag(() => cfg.v7.delegation || cfg.v7.sell, "task positions (AGENT_V7_DELEGATION_ENABLED / AGENT_V7_SELL_ENABLED)");
  const executorOn = flag(() => cfg.v7.hostedExecutor && !!x.jobs, "hosted executor (HOSTED_EXECUTOR_ENABLED)");
  const executorOnly = (_req: Request, res: Response, next: NextFunction) => {
    if (callerOf(res) !== "executor:hosted") {
      res.status(403).json({ error: "executor_only", message: "only the platform executor identity may call /v1/executor/*" });
      return;
    }
    next();
  };
  const operatorOnly = (_req: Request, res: Response, next: NextFunction) => {
    if (!isOperator(res) || SERVICE_CALLERS.has(callerOf(res))) {
      res.status(403).json({ error: "operator_only" });
      return;
    }
    next();
  };
  const id = (req: Request) => String(req.params["id"]);

  /* ---------- 委托清单 / 额度签名（O） ---------- */
  app.get("/v1/tasks/:id/delegation", delegationOn, auth, wrap(async (req, res) => {
    res.json(await x.delegation.checklist(callerOf(res), id(req), { issue: true }));
  }));
  app.post("/v1/tasks/:id/delegation/refresh", delegationOn, auth, wrap(async (req, res) => {
    res.json(await x.delegation.refreshSells(callerOf(res), id(req)));
  }));
  app.post("/v1/tasks/:id/allowances", delegationOn, auth, wrap(async (req, res) => {
    res.status(202).json(await x.delegation.submitPermit(callerOf(res), { taskId: id(req) }, (req.body ?? {}) as Record<string, unknown>));
  }));

  /* ---------- owner 维度额度（O） ---------- */
  app.get("/v1/owners/:owner/allowances", delegationOn, auth, wrap(async (req, res) => {
    res.json(await x.delegation.ownerAllowances(callerOf(res), String(req.params["owner"])));
  }));
  app.post("/v1/owners/:owner/allowances/reclaim", delegationOn, auth, wrap(async (req, res) => {
    res.status(200).json(await x.delegation.reclaim(callerOf(res), String(req.params["owner"]), (req.body ?? {}) as Record<string, unknown>));
  }));
  app.post("/v1/owners/:owner/allowances/submit", delegationOn, auth, wrap(async (req, res) => {
    res.status(202).json(await x.delegation.submitPermit(callerOf(res), { taskId: null, owner: String(req.params["owner"]) }, (req.body ?? {}) as Record<string, unknown>));
  }));

  /* ---------- 接管切换 / 任务持仓（O, H 读） ---------- */
  app.post("/v1/tasks/:id/handover", anyV7, auth, wrap(async (req, res) => {
    const row = await x.delegation.handover(callerOf(res), id(req), (req.body ?? {}) as Record<string, unknown>);
    res.json({ taskId: row.id, agentMode: row.agentMode, executorMode: row.executorMode, scopeHash: row.scopeHash, note: "No new signature: the signed scope is unchanged." });
  }));
  app.get("/v1/tasks/:id/positions", positionsOn, auth, wrap(async (req, res) => {
    const row = await d.tasks!.requireTask(callerOf(res), id(req), "read");
    res.json({ taskId: row.id, positions: await x.delegation.positions(row), dustRaw: cfg.POSITION_DUST_RAW, note: "sellableRaw = your on-chain balance of the stock (D-092 as confirmed 2026-10-02): a sell may use up to your full holdings, inside the sell authorization you signed. netRaw is this task's own bought − sold, for information." });
  }));

  /* ---------- 执行者（E） ---------- */
  app.post("/v1/executor/claim", executorOn, auth, executorOnly, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const executor = typeof b["executor"] === "string" && /^0x[0-9a-fA-F]{40}$/.test(b["executor"]) ? b["executor"].toLowerCase() : null;
    const instanceId = typeof b["instanceId"] === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b["instanceId"]) ? b["instanceId"] : null;
    if (!executor || !instanceId) throw new HttpError(400, "invalid_request", "需要 { executor: 地址, instanceId }");
    const jobs = await x.jobs!.claim({ executor, instanceId, kinds: Array.isArray(b["kinds"]) ? (b["kinds"] as string[]) : undefined, max: typeof b["max"] === "number" ? b["max"] : 1 });
    if (jobs.length === 0) {
      res.status(204).end();
      return;
    }
    res.json({ jobs });
  }));
  app.post("/v1/executor/jobs/:id/events", executorOn, auth, executorOnly, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const job = await x.jobs!.byId(id(req));
    if (!job) throw new HttpError(404, "job_not_found");
    const r = await x.jobs!.event(job.claimedBy ?? "", id(req), b);
    res.json({ ok: true, job: r.job });
  }));
  app.post("/v1/executor/heartbeat", executorOn, auth, executorOnly, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const executor = typeof b["executor"] === "string" && /^0x[0-9a-fA-F]{40}$/.test(b["executor"]) ? b["executor"].toLowerCase() : null;
    const instanceId = typeof b["instanceId"] === "string" ? b["instanceId"].slice(0, 64) : null;
    if (!executor || !instanceId) throw new HttpError(400, "invalid_request", "需要 { executor, instanceId }");
    await x.jobs!.heartbeat({ executor, instanceId, mode: b["mode"] === "okx_agentic" ? "okx_agentic" : "eoa", gasBalanceWei: /^\d+$/.test(String(b["gasBalanceWei"] ?? "")) ? String(b["gasBalanceWei"]) : "0", chainHead: /^\d+$/.test(String(b["chainHead"] ?? "")) ? String(b["chainHead"]) : "0", version: String(b["version"] ?? "").slice(0, 64), gasLow: b["gasLow"] === true });
    res.status(204).end();
  }));

  /* ---------- 运营者（OP） ---------- */
  app.post("/v1/ops/faults", auth, operatorOnly, wrap(async (req, res) => {
    if (!cfg.v7.faultInjection) throw new HttpError(403, "fault_injection_disabled", "FAULT_INJECTION_ENABLED=false");
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!(FAULT_KINDS as readonly unknown[]).includes(b["kind"])) throw new HttpError(400, "invalid_request", `kind 必须是 ${FAULT_KINDS.join(" | ")}`);
    const f = x.ops.addFault({ kind: b["kind"] as FaultKind, taskId: typeof b["taskId"] === "string" ? b["taskId"] : null, jobKind: b["jobKind"] === "permit" || b["jobKind"] === "execute_step" ? b["jobKind"] : null, ...(typeof b["delayS"] === "number" && b["delayS"] >= 0 && b["delayS"] <= 600 ? { delayS: b["delayS"] } : {}), by: callerOf(res) });
    res.status(201).json({ fault: f, note: "One-shot: attached to the next matching job at claim time. Faults only delay or expire; they never bypass a check." });
  }));
  app.get("/v1/ops/status", auth, operatorOnly, wrap(async (_req, res) => {
    const execs = x.jobs ? await x.jobs.executorStatuses() : [];
    res.json({
      flags: cfg.v7,
      executors: execs.map((e) => ({ executor: e.executor, mode: e.mode, lastHeartbeatAt: e.lastHeartbeatAt?.toISOString() ?? null, gasBalanceWei: e.gasBalanceWei, gasLow: x.jobs?.gasLow(e.executor) ?? false, chainHead: e.chainHead, version: e.version, instanceLeaseUntil: e.instanceLeaseUntil?.toISOString() ?? null })),
      queue: x.jobs ? await x.jobs.queueCounts() : {},
      pendingFaults: x.ops.pendingFaults(),
      recertifyPending: x.outcomes?.pendingIntents() ?? [],
      integrityAlerts: x.ops.recentAlerts().slice(-50),
      permitDomains: x.domains.status(),
      feeBudget: x.fees ? await x.fees.status() : null,
    });
  }));
}
