/**
 * HTTP 入口（技术设计 §6.1 冻结路径）。所有业务经 VerifyService；付费闸门经 Paywall。
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { POLICIES, policyDefinitionHash, registryHash } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { apiKeyAuth, callerOf } from "./auth";
import type { Paywall } from "./paywall";
import { HttpError, type VerifyService } from "../jobs/service";
import { UpstreamEvidenceError } from "../evidence/live";
import { A2MCP_PATH, createA2mcpHandler } from "./a2mcp";
import { A2MCP_MONITOR_PATH, A2MCP_PLAN_PATH, createA2mcpMonitorHandler, createA2mcpPlanHandler } from "./a2mcpPlan";
import { log } from "../log";
import type { PlansService } from "../plans/service";
import type { MandatesService } from "../mandates/service";
import type { ClubService } from "../club/service";
import type { AttestationSigner } from "../attestation/signer";
import { productCatalog } from "../products/catalog";
import { buildBill } from "../products/bill";
import { buildJobBundle, buildMandateBundle } from "../bundle/bundle";
import { findEntry, type NormalizedJob } from "@chaconne/core/verify";
import type { XLayerMarket } from "../market/xlayer";
/* v6 Lane B */
import { isContextTier, STOP_SEMANTICS_NOTE, type PlaybookCatalog, type Condition, type ConditionSet, type EventKind, EVENT_KINDS } from "@chaconne/core/verify";
import type { ContextService } from "../context/service";
import type { CrowsnestAdapter } from "../context/crowsnest";
import type { EventStore } from "../events/store";
import type { TasksService } from "../tasks/service";
import type { ThesesService } from "../theses/service";
import { buildTaskBundle } from "../tasks/bundle";
import { playbookCatalogView } from "../tasks/playbooks";
import { rateLimit } from "./auth";
import type { LaneDHandles } from "../events/earnings/wire";
import { IMPACT_ACTIONS } from "@chaconne/core/verify";
import type { BudgetService } from "../budget/service";
import type { PortfolioService } from "../portfolio/service";
import type { RebalanceService } from "../rebalance/service";
import type { NotifyService } from "../notify/service";
import type { LabService } from "../lab/service";
/* v6 Lane F */
import type { RecapsService } from "../recaps/service";
import { buildMissions } from "../missions/build";
import { A2MCP_AGENT_TASKS_PATH, createA2mcpAgentTasksHandler, type AgentTasksDeps } from "./a2mcpAgentTasks";

export interface AppDeps {
  cfg: VerifyConfig;
  service: VerifyService;
  paywall: Paywall;
  health: () => Record<string, unknown>;
  /* v2 */
  plans?: PlansService;
  mandates?: MandatesService;
  club?: ClubService;
  signer?: AttestationSigner | null;
  /** 公开行情（主站消费，interfaces §10.16）；EVIDENCE_MODE=fixture / 无 OKX 凭据时为空 → 503 */
  market?: XLayerMarket | null;
  /* v6 Lane B */
  context?: ContextService | null;
  crowsnest?: CrowsnestAdapter | null;
  events?: EventStore | null;
  tasks?: TasksService | null;
  theses?: ThesesService | null;
  playbooks?: PlaybookCatalog | null;
  /* v6 Lane D：个人事件台（AGENT_C6_ENABLED=false 或未装配时为空 → 路由不挂） */
  laneD?: LaneDHandles | null;
  /* v6 Lane C（开关 AGENT_C4_ENABLED / AGENT_C8_ENABLED；为空 = 该能力未挂载 → 404） */
  budget?: BudgetService | null;
  portfolio?: PortfolioService | null;
  rebalance?: RebalanceService | null;
  notify?: NotifyService | null;
  /* v6 Lane E：决策实验（C9） */
  lab?: LabService | null;
  /* v6 Lane F：C5 夜班日志（AGENT_C5_ENABLED=false 时不挂载）；A2MCP Agent Tasks 的可选钩子（Lane D 影响/事件） */
  recaps?: RecapsService | null;
  agentHooks?: Pick<AgentTasksDeps, "impacts" | "events">;
  now?: () => Date;
}

export function createApp(d: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));

  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...d.health() });
  });

  /* ---------- 公开只读 ---------- */
  app.get("/v1/assets", (_req, res) => {
    const reg = d.service.registry;
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({
      registryVersion: reg.version,
      registryHash: registryHash(reg),
      chainId: reg.chainId,
      evidenceMode: d.cfg.EVIDENCE_MODE.toUpperCase(),
      assets: reg.entries.map((e) => ({
        assetKey: e.assetKey,
        chainId: e.chainId,
        tokenAddress: e.tokenAddress,
        tokenDecimals: e.tokenDecimals,
        issuerId: e.issuerId,
        displaySymbol: e.displaySymbol,
        underlyingId: e.underlyingId,
        tokenForm: e.tokenForm,
        role: e.role,
        sharesPerToken: e.sharesPerToken,
        executionAllowed: e.executionAllowed,
        provenance: e.provenance,
      })),
    });
  });

  app.get("/v1/policies", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      policies: Object.values(POLICIES)
        .flat()
        .map((def) => ({ ...def, policyDefinitionHash: policyDefinitionHash(def) })),
      pricing: { reportPriceUsd: d.cfg.REPORT_PRICE_USD, network: d.cfg.PAYMENT_NETWORK, refundPolicy: "A rejected or limited verdict is a delivered verification and is not refunded; service failures that prevent delivery are refunded manually by the operator." },
      entitlement: { maxRefreshes: d.cfg.ENTITLEMENT_MAX_REFRESHES, windowSeconds: d.cfg.ENTITLEMENT_WINDOW_SECONDS },
    });
  });

  /* ---------- 需调用方身份 ---------- */
  const auth = apiKeyAuth(d.cfg.apiKeys, d.cfg.RATE_LIMIT_PER_MIN);
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

  app.post(
    "/v1/jobs",
    auth,
    wrap(async (req, res) => {
      const r = await d.service.createJob(callerOf(res), req.body);
      res.status(r.status).json(r.body);
    }),
  );

  app.get(
    "/v1/jobs/:id",
    auth,
    wrap(async (req, res) => {
      const job = await d.service.requireJob(callerOf(res), String(req.params["id"]));
      res.json(await d.service.view(job));
    }),
  );

  app.get(
    "/v1/jobs/:id/report",
    auth,
    wrap(async (req, res) => {
      const jobId = String(req.params["id"]);
      await d.service.requireJob(callerOf(res), jobId);
      const order = await d.service.requireOrder(jobId);
      const version = req.query["version"] ? Number(req.query["version"]) : undefined;
      await d.paywall.handleReport(req, res, order, () => d.service.deliverReport(jobId, version));
    }),
  );

  app.post(
    "/v1/jobs/:id/prepare-execution",
    auth,
    wrap(async (req, res) => {
      const refreshKey = typeof req.body?.refreshKey === "string" ? req.body.refreshKey : "";
      const r = await d.service.prepareExecution(callerOf(res), String(req.params["id"]), refreshKey);
      res.status(r.status).json({ ...r.body, replay: r.replay });
    }),
  );

  app.post(
    "/v1/jobs/:id/submissions",
    auth,
    wrap(async (req, res) => {
      const attemptId = typeof req.body?.attemptId === "string" ? req.body.attemptId : "";
      const txHash = typeof req.body?.txHash === "string" ? req.body.txHash : "";
      const intentSignature = typeof req.body?.intentSignature === "string" ? req.body.intentSignature : undefined;
      const body = await d.service.recordSubmission(callerOf(res), String(req.params["id"]), attemptId, txHash, intentSignature);
      res.status(202).json(body);
    }),
  );

  /* ---------- v2：商品 / 账单 / 证据包 ---------- */
  app.get("/v1/products", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ products: productCatalog(d.cfg), network: d.cfg.PAYMENT_NETWORK, refundPolicy: "Manual, operator-run process. A rejected/limited/waiting outcome is a delivered service; only failures that prevent delivery are refunded." });
  });
  app.get(
    "/v1/jobs/:id/bill",
    auth,
    wrap(async (req, res) => {
      const jobId = String(req.params["id"]);
      const job = await d.service.requireJob(callerOf(res), jobId);
      const order = await d.service.requireOrder(jobId);
      const attempts = await d.service["d"].orders.settledAttempts(order.id);
      const execs = await d.service.executions(jobId);
      const inEntry = findEntry(d.service.registry, (job.jobJson as NormalizedJob).inputAssetKey);
      res.json({ jobId, bill: buildBill(d.cfg, order, attempts, execs.map((a) => ({ attemptId: a.id, txHash: a.txHash, receipt: (a.receiptJson as Record<string, unknown> | null) ?? null, inputToken: inEntry?.tokenAddress ?? null, chainId: job.executionChainId })), job.ownerAddress) });
    }),
  );
  const bundleDeps = () => {
    if (!d.plans || !d.mandates) throw new HttpError(503, "v2_disabled");
    return { cfg: d.cfg, registry: d.service.registry, signer: d.signer ?? null, jobs: d.service, mandates: d.mandates, plans: d.plans, orders: d.service["d"].orders };
  };
  app.get(
    "/v1/jobs/:id/bundle",
    auth,
    wrap(async (req, res) => {
      const jobId = String(req.params["id"]);
      const order = await d.service.requireOrder(jobId);
      await d.service.requireJob(callerOf(res), jobId);
      if (order.priceUsd !== "0" && !d.service["d"].orders.isDeliverable(order)) throw new HttpError(402, "payment_required", "报告尚未付款");
      res.json(await buildJobBundle(bundleDeps(), callerOf(res), jobId));
    }),
  );

  /* ---------- v2：规划 ---------- */
  if (d.plans) {
    const plans = d.plans;
    app.post(
      "/v1/plans",
      auth,
      wrap(async (req, res) => {
        const r = await plans.create(callerOf(res), req.body);
        res.status(r.status).json(r.body);
      }),
    );
    app.get(
      "/v1/plans/:id",
      auth,
      wrap(async (req, res) => {
        res.json(await plans.view(await plans.requirePlan(callerOf(res), String(req.params["id"]))));
      }),
    );
    app.get(
      "/v1/plans/:id/report",
      auth,
      wrap(async (req, res) => {
        const row = await plans.requirePlan(callerOf(res), String(req.params["id"]));
        const order = await d.service["d"].orders.byRef(row.id);
        if (!order) throw new HttpError(500, "order_missing");
        await d.paywall.handleReport(req, res, order, () => plans.deliver(row), { expectedPaths: [`/v1/plans/${row.id}/report`, A2MCP_PLAN_PATH] });
      }),
    );
    app.post(
      "/v1/plans/:id/jobs",
      auth,
      wrap(async (req, res) => {
        const row = await plans.requirePlan(callerOf(res), String(req.params["id"]));
        const order = await d.service["d"].orders.byRef(row.id);
        if (order && order.priceUsd !== "0" && !d.service["d"].orders.isDeliverable(order)) throw new HttpError(402, "payment_required", "规划尚未付款");
        const candidateId = typeof req.body?.candidateId === "string" ? req.body.candidateId : null;
        const r = await plans.toJob(callerOf(res), row, candidateId);
        res.status(r.status).json({ ...r.body, planId: r.planId, candidate: r.candidate });
      }),
    );
  }

  /* ---------- v2：授权计划 ---------- */
  if (d.mandates) {
    const mandates = d.mandates;
    const orders = d.service["d"].orders;
    app.post(
      "/v1/mandates",
      auth,
      wrap(async (req, res) => {
        const r = await mandates.register(callerOf(res), req.body);
        const order = await orders.byRef(r.row.id);
        if (!order) throw new HttpError(500, "order_missing");
        if (order.priceUsd === "0" || orders.isDeliverable(order)) {
          await mandates.activate(r.row.id);
          await orders.markDelivered(order.id);
          res.status(r.status).json(await mandates.view((await mandates.byId(r.row.id))!));
          return;
        }
        await d.paywall.handleReport(req, res, order, async () => {
          await mandates.activate(r.row.id);
          return mandates.view((await mandates.byId(r.row.id))!);
        }, { expectedPaths: ["/v1/mandates", A2MCP_MONITOR_PATH] });
      }),
    );
    app.get(
      "/v1/mandates/:id",
      auth,
      wrap(async (req, res) => {
        res.json(await mandates.view(await mandates.requireMandate(callerOf(res), String(req.params["id"]))));
      }),
    );
    for (const [action, to] of [["pause", "PAUSED"], ["resume", "ACTIVE"], ["cancel", "CANCELLED"]] as const) {
      app.post(
        `/v1/mandates/:id/${action}`,
        auth,
        wrap(async (req, res) => {
          const row = await mandates.transition(callerOf(res), String(req.params["id"]), to);
          res.json({ ...(await mandates.view(row)), note: to === "CANCELLED" ? "Off-chain cancel only stops certificate issuance; call PlanGuard.revokeMandate(m) from the owner wallet to revoke on-chain." : undefined });
        }),
      );
    }
    app.post(
      "/v1/mandates/:id/prepare-step",
      auth,
      wrap(async (req, res) => {
        const r = await mandates.prepareStep(callerOf(res), String(req.params["id"]));
        res.status(r.status === "READY" ? 200 : 409).json(r);
      }),
    );
    app.post(
      "/v1/mandates/:id/steps/:n/submissions",
      auth,
      wrap(async (req, res) => {
        const n = Number(req.params["n"]);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "invalid_step_index");
        const txHash = typeof req.body?.txHash === "string" ? req.body.txHash : "";
        const step = await mandates.recordSubmission(callerOf(res), String(req.params["id"]), n, txHash);
        res.status(202).json(mandates.stepView(step));
      }),
    );
    app.get(
      "/v1/mandates/:id/bill",
      auth,
      wrap(async (req, res) => {
        const row = await mandates.requireMandate(callerOf(res), String(req.params["id"]));
        const order = await orders.byRef(row.id);
        const attempts = order ? await orders.settledAttempts(order.id) : [];
        const steps = await mandates.steps(row.id);
        const inputToken = (row.mandateJson as { mandate: { inputToken: string } }).mandate.inputToken;
        res.json({ mandateId: row.id, bill: buildBill(d.cfg, order, attempts, steps.map((s) => ({ attemptId: s.id, txHash: s.txHash, receipt: (s.receiptJson as Record<string, unknown> | null) ?? null, inputToken, chainId: row.chainId })), row.ownerAddress) });
      }),
    );
    app.get(
      "/v1/mandates/:id/bundle",
      auth,
      wrap(async (req, res) => {
        res.json(await buildMandateBundle(bundleDeps(), callerOf(res), String(req.params["id"])));
      }),
    );
  }

  /* ---------- v2：Club（模拟 / 角色 / 模板 / 战报） ---------- */
  if (d.club) {
    const club = d.club;
    app.post("/v1/simulations", auth, wrap(async (req, res) => { res.status(201).json(await club.simulate(callerOf(res), req.body)); }));
    app.get("/v1/simulations/:id", auth, wrap(async (req, res) => { res.json(await club.requireSimulation(callerOf(res), String(req.params["id"]))); }));
    app.get("/v1/profiles/me", auth, wrap(async (req, res) => { res.json({ profile: await club.getProfile(callerOf(res), req.query["ownerAddress"]) }); }));
    app.put("/v1/profiles/me", auth, wrap(async (req, res) => { res.json({ profile: await club.putProfile(callerOf(res), req.body) }); }));
    app.post("/v1/templates", auth, wrap(async (req, res) => { res.status(201).json(await club.createTemplate(callerOf(res), req.body)); }));
    app.get("/v1/templates/:id", (req, res, next) => { club.getTemplate(String(req.params["id"])).then((t) => { res.setHeader("Cache-Control", "public, max-age=60"); res.json(t); }).catch(next); });
    app.post("/v1/shares", auth, wrap(async (req, res) => { res.status(201).json(await club.setShare(callerOf(res), req.body)); }));
    // Genesis Live 公开板：只列自愿公开的战报（E2 的 /live 依赖；I2 2026-09-21 补）
    app.get("/pub/reports", (req, res, next) => { club.liveBoard(Number(req.query["limit"] ?? 50) || 50).then((items) => { res.setHeader("Cache-Control", "public, max-age=30"); res.json({ items }); }).catch(next); });
    app.get("/pub/reports/:shareId", (req, res, next) => { club.publicReport(String(req.params["shareId"])).then((r) => { res.setHeader("Cache-Control", "public, max-age=30"); res.json(r); }).catch(next); });
    app.get("/pub/live", (req, res, next) => { club.liveBoard(Number(req.query["limit"] ?? 50) || 50).then((items) => { res.setHeader("Cache-Control", "public, max-age=30"); res.json({ items }); }).catch(next); });
  }

  /* v6 Lane E ---------- 决策实验（C9）：等待诊断 / 同输入对照 / 决策回放；开关 AGENT_C9_ENABLED ---------- */
  if (d.lab) {
    const lab = d.lab;
    const gate = (_req: Request, res: Response, next: NextFunction) => {
      if (d.cfg.agentC9Enabled) return next();
      res.status(503).json({ error: "feature_disabled", feature: "AGENT_C9_ENABLED" });
    };
    app.get("/v1/tasks/:id/explain-wait", auth, gate, wrap(async (req, res) => { res.json(await lab.explainWait(callerOf(res), String(req.params["id"]), req.query["locale"])); }));
    app.post("/v1/tasks/:id/compare-policies", auth, gate, wrap(async (req, res) => { res.status(201).json(await lab.comparePolicies(callerOf(res), String(req.params["id"]), req.body)); }));
    app.post("/v1/replays", auth, gate, wrap(async (req, res) => { res.status(201).json(await lab.createReplay(callerOf(res), req.body)); }));
    app.get("/v1/replays/:id", auth, gate, wrap(async (req, res) => { res.json(await lab.getReplay(callerOf(res), String(req.params["id"]))); }));
  }

  /* ---------- 公开行情：主站 poller 每 30s 拉（契约 §10.16；nginx `/pub/` 前缀已分流到本服务） ----------
   * 2026-09-22 扩容到 27 只（执行层 3 档 + 展示层 1 档），一轮约 10 s，故服务端 TTL 60 s、边缘缓存同步放宽。 */
  const unavailable = (res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "unavailable" });
  };
  if (d.market) {
    const market = d.market;
    app.get(
      "/pub/market/xlayer",
      wrap(async (_req, res) => {
        const snap = await market.snapshot();
        if (!snap) {
          unavailable(res);
          return;
        }
        res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
        res.json(snap);
      }),
    );
  } else {
    app.get("/pub/market/xlayer", (_req, res) => unavailable(res));
  }

  /* ================================================================== */
  /* v6 Lane B：上下文（C1）/ 事件 / 任务（C3）/ 理由卡（C7）——每个能力独立开关，缺省开        */
  /* ================================================================== */
  {
    /** 免费档（D-085）：无 key 只给 agent 档；带合法 key 可指定档位（internal/display 只给受信调用方） */
    const optionalAuth = (req: Request, res: Response, next: NextFunction) => {
      const hasKey = !!(req.header("x-api-key") || req.header("authorization"));
      if (hasKey) {
        auth(req, res, next);
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=30");
      if (!rateLimit(`anon:${req.ip ?? "?"}`, d.cfg.RATE_LIMIT_PER_MIN, 60_000)) {
        res.status(429).json({ error: "rate_limited", retryAfterSeconds: 60 });
        return;
      }
      res.locals["callerId"] = "";
      next();
    };
    if (d.context && d.cfg.agentC1) {
      const context = d.context;
      const crowsnest = d.crowsnest;
      app.get(
        "/v1/context",
        optionalAuth,
        wrap(async (req, res) => {
          const callerId = String(res.locals["callerId"] ?? "");
          const requested = req.query["tier"];
          const tier = callerId && isContextTier(requested) ? requested : "agent";
          const assetKey = typeof req.query["assetKey"] === "string" ? req.query["assetKey"].toLowerCase() : undefined;
          let conditions: Condition[] | undefined;
          let underlyingIds: string[] | undefined;
          const taskId = typeof req.query["taskId"] === "string" ? req.query["taskId"] : null;
          if (taskId && d.tasks) {
            if (!callerId) {
              res.status(200).json({ ...(await context.view({ tier })), meta: undefined, error: "task_filter_requires_api_key" });
              return;
            }
            const row = await d.tasks.requireTask(callerId, taskId);
            const set = row.conditionsJson as ConditionSet;
            conditions = set.items;
            const goal = row.goalJson as { legs: Array<{ outputAssetKey: string }>; budget: { inputAssetKeys: string[] }; side: string };
            const stockKey = goal.side === "sell" ? goal.budget.inputAssetKeys[0]! : goal.legs[0]!.outputAssetKey;
            const u = context.underlyingOf(stockKey);
            underlyingIds = u ? [u] : [];
          }
          if (typeof req.query["owner"] === "string" && d.tasks && callerId) {
            // owner 过滤：该 owner 运行中任务涉及的标的
            const rows = await d.tasks.list(callerId, req.query["owner"]);
            underlyingIds = underlyingIds ?? [];
            for (const r of rows) {
              const goal = r.goalJson as { legs: Array<{ outputAssetKey: string }>; budget: { inputAssetKeys: string[] }; side: string };
              const stockKey = goal.side === "sell" ? goal.budget.inputAssetKeys[0]! : goal.legs[0]!.outputAssetKey;
              const u = context.underlyingOf(stockKey);
              if (u && !underlyingIds.includes(u)) underlyingIds.push(u);
            }
          }
          // 永远 200：不可达时字段级 unavailable（interfaces §11.7）
          res.status(200).json(await context.view({ tier, ...(assetKey ? { assetKey } : {}), ...(underlyingIds ? { underlyingIds } : {}), ...(conditions ? { conditions } : {}) }));
        }),
      );
      // 联调 / 回放投递：把一份 context.json 原文交给适配器（验签、schema、staleness 同 pull 路径）；需要 API key
      if (crowsnest) {
        app.post(
          "/v1/context/ingest",
          auth,
          express.text({ type: "*/*", limit: "1mb" }),
          wrap(async (req, res) => {
            const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
            const mode = req.query["mode"] === "REPLAY" ? "REPLAY" : "LIVE";
            const r = await crowsnest.ingest(raw, { endpoint: `ingest:${callerOf(res)}`, mode });
            res.status(r.ok ? 201 : 422).json(r.ok ? { ok: true, snapshotId: r.snapshotId, contextHash: r.contextHash, provenance: r.provenance, fieldStatus: r.fieldStatus, events: r.events } : { ok: false, snapshotId: r.snapshotId, reason: r.reason, detail: r.detail, evidenceId: r.evidence.evidenceId });
          }),
        );
      }
    }
    if (d.events && d.cfg.agentC1) {
      const events = d.events;
      app.get(
        "/v1/events",
        optionalAuth,
        wrap(async (req, res) => {
          const kind = typeof req.query["kind"] === "string" && (EVENT_KINDS as readonly string[]).includes(req.query["kind"]) ? (req.query["kind"] as EventKind) : undefined;
          const list = await events.list({ ...(typeof req.query["from"] === "string" ? { from: req.query["from"] } : {}), ...(typeof req.query["to"] === "string" ? { to: req.query["to"] } : {}), ...(typeof req.query["underlyingId"] === "string" ? { underlyingId: req.query["underlyingId"] } : {}), ...(kind ? { kind } : {}) });
          res.json({ events: list });
        }),
      );
      app.get(
        "/v1/events/:id/revisions",
        optionalAuth,
        wrap(async (req, res) => {
          const id = String(req.params["id"]);
          const revisions = await events.revisions(id);
          if (revisions.length === 0) throw new HttpError(404, "event_not_found");
          res.json({ eventId: id, revisions });
        }),
      );
    }
    if (d.playbooks && d.cfg.agentC3) {
      const catalog = d.playbooks;
      app.get("/v1/playbooks", (_req, res) => {
        res.setHeader("Cache-Control", "public, max-age=300");
        res.json(playbookCatalogView(catalog));
      });
    }
    if (d.tasks && d.cfg.agentC3) {
      const tasks = d.tasks;
      app.post(
        "/v1/tasks",
        auth,
        wrap(async (req, res) => {
          const r = await tasks.create(callerOf(res), req.body);
          res.status(r.status).json(r.body);
        }),
      );
      app.get(
        "/v1/tasks",
        auth,
        wrap(async (req, res) => {
          const owner = typeof req.query["owner"] === "string" ? req.query["owner"] : undefined;
          const rows = await tasks.list(callerOf(res), owner);
          res.json({ tasks: await Promise.all(rows.map((r) => tasks.view(r).then((v) => v["task"]))) });
        }),
      );
      app.get(
        "/v1/tasks/:id",
        auth,
        wrap(async (req, res) => {
          res.json(await tasks.view(await tasks.requireTask(callerOf(res), String(req.params["id"]))));
        }),
      );
      for (const action of ["pause", "resume", "cancel"] as const) {
        app.post(
          `/v1/tasks/:id/${action}`,
          auth,
          wrap(async (req, res) => {
            const { row, note } = await tasks.transition(callerOf(res), String(req.params["id"]), action);
            // D-088：响应体必须写明——服务侧停止只阻止后续签发；已取走且未过期的证书仍可能可执行；彻底停止以链上撤销确认为准
            res.json({ ...(await tasks.view(row)), note, stopSemantics: STOP_SEMANTICS_NOTE });
          }),
        );
      }
      app.post(
        "/v1/tasks/:id/authorize",
        auth,
        wrap(async (req, res) => {
          const r = await tasks.authorize(callerOf(res), String(req.params["id"]), req.body);
          res.status(201).json({ ...(await tasks.view(r.row)), mandate: r.mandate, mandateId: (r.mandate as { mandateId?: string }).mandateId ?? null });
        }),
      );
      app.post(
        "/v1/tasks/:id/prepare-step",
        auth,
        wrap(async (req, res) => {
          const r = await tasks.prepareStep(callerOf(res), String(req.params["id"]));
          res.status(r.httpStatus).json(r.body);
        }),
      );
      app.post(
        "/v1/tasks/:id/conditions",
        auth,
        wrap(async (req, res) => {
          const row = await tasks.updateConditions(callerOf(res), String(req.params["id"]), req.body);
          res.json({ ...(await tasks.view(row)), note: "Conditions changed = new authorization. Previous mandates are paused server-side (not revoked): certificates already pulled may still execute until they expire; revoke on-chain to stop completely (K-09)." });
        }),
      );
      app.get(
        "/v1/tasks/:id/blockers",
        auth,
        wrap(async (req, res) => {
          const row = await tasks.requireTask(callerOf(res), String(req.params["id"]));
          const history = await tasks.blockerHistory(row.id);
          res.json({ taskId: row.id, current: row.blockersJson, nextCheckAt: row.nextCheckAt?.toISOString() ?? null, history: history.map((h) => ({ evaluatedAt: h.evaluatedAt.toISOString(), outcome: h.outcome, blockers: h.blockersJson, nextCheckAt: h.nextCheckAt?.toISOString() ?? null })) });
        }),
      );
      app.get(
        "/v1/tasks/:id/bundle",
        auth,
        wrap(async (req, res) => {
          if (!d.plans || !d.mandates || !d.theses) throw new HttpError(503, "v2_disabled");
          res.json(await buildTaskBundle({ cfg: d.cfg, registry: d.service.registry, signer: d.signer ?? null, jobs: d.service, mandates: d.mandates, plans: d.plans, orders: d.service["d"].orders, tasks, theses: d.theses }, callerOf(res), String(req.params["id"])));
        }),
      );
    }
    if (d.theses && d.cfg.agentC7) {
      const theses = d.theses;
      app.get(
        "/v1/theses/:id",
        auth,
        wrap(async (req, res) => {
          res.json(await theses.view(await theses.require(callerOf(res), String(req.params["id"]))));
        }),
      );
      app.post(
        "/v1/theses",
        auth,
        wrap(async (req, res) => {
          // 独立建卡：必须挂到本调用方的任务上（每任务一张，重复建 → 409）
          if (!d.tasks) throw new HttpError(503, "tasks_disabled");
          const b = (req.body ?? {}) as Record<string, unknown>;
          const taskRow = await d.tasks.requireTask(callerOf(res), String(b["taskId"] ?? ""));
          if (taskRow.thesisId && (await theses.byId(taskRow.thesisId))) throw new HttpError(409, "thesis_exists", "该任务已有理由卡；用 review-items / premises 更新", { thesisId: taskRow.thesisId });
          const row = await theses.create({ callerId: callerOf(res), owner: taskRow.ownerAddress, taskId: taskRow.id, mode: taskRow.mode as "LIVE" | "SIMULATION", raw: b });
          res.status(201).json(await theses.view(row));
        }),
      );
      app.post(
        "/v1/theses/:id/review-items",
        auth,
        wrap(async (req, res) => {
          const addedBy = (req.body ?? {})["addedBy"] === "agent" ? "agent" : "user";
          const row = await theses.addReviewItem(callerOf(res), String(req.params["id"]), req.body, addedBy);
          res.status(201).json({ ...(await theses.view(row)), note: "Review item recorded for the owner to review. This never triggers execution." });
        }),
      );
      app.post(
        "/v1/theses/:id/premises/:pid",
        auth,
        wrap(async (req, res) => {
          const { row, newlyInvalidated } = await theses.markPremise(callerOf(res), String(req.params["id"]), String(req.params["pid"]), (req.body ?? {})["status"]);
          // research 前提失效不触发 onInvalidation（它不是机器前提），只记录；卡片状态由机器前提决定
          res.json({ ...(await theses.view(row)), researchPremiseInvalidated: newlyInvalidated });
        }),
      );
      app.post(
        "/v1/theses/:id/renew",
        auth,
        wrap(async (req, res) => {
          const row = await theses.renew(callerOf(res), String(req.params["id"]), (req.body ?? {})["validUntil"]);
          if (d.tasks) {
            const t = await d.tasks.byId(row.taskId);
            if (t && t.callerId === callerOf(res)) await d.tasks.evaluateTask(t, { issue: false });
          }
          res.json(await theses.view(row));
        }),
      );
      app.post(
        "/v1/theses/:id/end",
        auth,
        wrap(async (req, res) => {
          const row = await theses.end(callerOf(res), String(req.params["id"]));
          if (d.tasks) {
            const t = await d.tasks.byId(row.taskId);
            if (t && t.callerId === callerOf(res)) await d.tasks.evaluateTask(t, { issue: false });
          }
          res.json({ ...(await theses.view(row)), note: "Thesis ended: the task now waits with THESIS_EXPIRED; cancel the task or renew the thesis." });
        }),
      );
      app.post(
        "/v1/theses/:id/check",
        auth,
        wrap(async (req, res) => {
          if (!d.tasks) throw new HttpError(503, "tasks_disabled");
          const r = await d.tasks.checkThesis(callerOf(res), String(req.params["id"]));
          res.json({ thesis: await theses.view(r.thesis), task: (await d.tasks.view(r.task))["task"] });
        }),
      );
    }
  }

  /* v6 Lane D */
  if (d.laneD) {
    const laneD = d.laneD;
    // owner 鉴权：地址绑定的调用方（web:<addr> / 通配 key）只能查自己；非地址绑定的 API key（agent / 脚本）按参数 owner 查——与 ClubService.ownerOf 同一口径
    const ownerOf = (callerId: string, given: unknown): string => {
      const bound = callerId.match(/(0x[0-9a-f]{40})$/)?.[1] ?? null;
      const g = typeof given === "string" && /^0x[0-9a-fA-F]{40}$/.test(given) ? given.toLowerCase() : null;
      if (bound) {
        if (g && g !== bound) throw new HttpError(403, "owner_mismatch", "只能查询与调用方绑定的 owner");
        return bound;
      }
      if (!g) throw new HttpError(400, "owner_required", "需要 owner=<EVM 地址>");
      return g;
    };
    app.get(
      "/v1/event-impacts",
      auth,
      wrap(async (req, res) => {
        const owner = ownerOf(callerOf(res), req.query["owner"]);
        const h = req.query["horizonHours"] === undefined ? 48 : Number(req.query["horizonHours"]);
        if (!Number.isFinite(h) || h <= 0) throw new HttpError(400, "invalid_horizon", "horizonHours 需为正数");
        res.json(await laneD.impacts.impacts(owner, h));
      }),
    );
    app.post(
      "/v1/event-impacts/actions",
      auth,
      wrap(async (req, res) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const owner = ownerOf(callerOf(res), b["owner"] ?? b["ownerAddress"]);
        const action = b["action"];
        if (typeof action !== "string" || !(IMPACT_ACTIONS as readonly string[]).includes(action)) throw new HttpError(400, "invalid_action", `action 需为 ${IMPACT_ACTIONS.join(" | ")}`);
        if (typeof b["eventId"] !== "string" || !b["eventId"]) throw new HttpError(400, "event_required", "需要 eventId");
        const r = await laneD.actions.apply({
          owner,
          eventId: b["eventId"],
          action: action as (typeof IMPACT_ACTIONS)[number],
          taskId: typeof b["taskId"] === "string" ? b["taskId"] : null,
          wholeDayIfDayPrecision: b["wholeDayIfDayPrecision"] === true,
          params: typeof b["params"] === "object" && b["params"] !== null ? (b["params"] as Record<string, unknown>) : undefined,
          clientRequestId: typeof b["clientRequestId"] === "string" ? b["clientRequestId"] : undefined,
        });
        res.status(r.effect === "invalid" ? 400 : r.effect === "not_ready" ? 503 : 200).json(r);
      }),
    );
    app.get(
      "/v1/events/earnings/coverage",
      auth,
      wrap(async (_req, res) => {
        const stocks = d.service.registry.entries.filter((e) => e.role === "stock_output");
        const coverage = await laneD.store.coverage([...new Set(stocks.map((e) => e.underlyingId))]);
        res.json({ source: "finnhub", store: laneD.storeKind, coverage, corporateActions: { status: "not_connected" } });
      }),
    );
    // 运营者 / 脚本触发一轮摄入（地址绑定的网页调用方不可用）；无 Finnhub key → 503
    app.post(
      "/v1/events/earnings/ingest",
      auth,
      wrap(async (_req, res) => {
        if (/(0x[0-9a-f]{40})$/.test(callerOf(res))) throw new HttpError(403, "operator_only");
        if (!laneD.ingestor) throw new HttpError(503, "earnings_source_unavailable", "未配置 FINNHUB_API_KEY");
        const s = await laneD.ingestor.ingestAll();
        res.json({ ...s, runs: s.runs.map((r) => ({ symbol: r.symbol, underlyingId: r.underlyingId, httpStatus: r.httpStatus, ok: r.ok, rowCount: r.rowCount, receivedAt: r.receivedAt, eventIds: r.eventIds })) });
      }),
    );
  }

  /* v6 Lane C */
  if (d.notify) {
    const notify = d.notify;
    app.post("/v1/notify/webhooks", auth, wrap(async (req, res) => { res.status(201).json(await notify.registerWebhook(callerOf(res), req.body)); }));
    app.get("/v1/notify/webhooks/:id", auth, wrap(async (req, res) => { res.json(notify.channelView(await notify.requireChannel(callerOf(res), String(req.params["id"])))); }));
    app.delete("/v1/notify/webhooks/:id", auth, wrap(async (req, res) => { await notify.deleteChannel(callerOf(res), String(req.params["id"])); res.status(204).end(); }));
    app.post("/v1/notify/telegram/link", auth, wrap(async (req, res) => { const r = await notify.telegramLink(callerOf(res), req.body); res.status(r.step === "code_issued" ? 201 : 200).json(r); }));
    app.post("/v1/notify/test", auth, wrap(async (req, res) => { res.json(await notify.sendTest(callerOf(res), req.body)); }));
    app.post("/v1/mandates/:id/executor/heartbeat", auth, wrap(async (req, res) => { await notify.heartbeat(callerOf(res), String(req.params["id"]), req.body); res.status(204).end(); }));
    app.get("/v1/mandates/:id/executor", auth, wrap(async (req, res) => { if (d.mandates) await d.mandates.requireMandate(callerOf(res), String(req.params["id"])); res.json(await notify.presence(String(req.params["id"]))); }));
  }
  if (d.portfolio) {
    const portfolio = d.portfolio;
    app.get("/v1/portfolio/:owner", auth, wrap(async (req, res) => { res.json(await portfolio.view(callerOf(res), String(req.params["owner"]))); }));
    app.post("/v1/portfolio/:owner/cost-overrides", auth, wrap(async (req, res) => { res.status(201).json(await portfolio.addCostOverride(callerOf(res), String(req.params["owner"]), req.body)); }));
  }
  if (d.budget) {
    const budget = d.budget;
    app.post("/v1/budget-groups", auth, wrap(async (req, res) => { res.status(201).json(await budget.create(callerOf(res), req.body)); }));
    app.get("/v1/budget-groups/:id", auth, wrap(async (req, res) => { res.json(await budget.view(callerOf(res), String(req.params["id"]))); }));
    app.post("/v1/budget-groups/:id/allocations", auth, wrap(async (req, res) => { const r = await budget.allocate(callerOf(res), String(req.params["id"]), req.body); res.status(r.status).json(r.body); }));
  }
  if (d.rebalance) {
    const rebalance = d.rebalance;
    app.post("/v1/rebalance/preview", auth, wrap(async (req, res) => { res.json(await rebalance.preview(callerOf(res), req.body)); }));
    app.post("/v1/rebalance/plans", auth, wrap(async (req, res) => { const r = await rebalance.createPlan(callerOf(res), req.body); res.status(r.status).json(r.body); }));
    app.get("/v1/rebalance/plans/:id", auth, wrap(async (req, res) => { res.json(await rebalance.view(callerOf(res), String(req.params["id"]))); }));
    app.post("/v1/rebalance/plans/:id/legs/:n/authorize", auth, wrap(async (req, res) => {
      const n = Number(req.params["n"]);
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "invalid_leg_index");
      res.status(201).json(await rebalance.authorizeLeg(callerOf(res), String(req.params["id"]), n, req.body));
    }));
  }

  /* ---------- OKX AI A2MCP 第二服务 Plan & Monitor（D-083） ---------- */
  if (d.plans && d.mandates) {
    const planHandler = createA2mcpPlanHandler({ cfg: d.cfg, plans: d.plans, paywall: d.paywall });
    app.post(A2MCP_PLAN_PATH, wrap(planHandler));
    app.get(A2MCP_PLAN_PATH, wrap(planHandler));
    const mon = createA2mcpMonitorHandler({ cfg: d.cfg, mandates: d.mandates, paywall: d.paywall });
    app.post(A2MCP_MONITOR_PATH, wrap(mon.register));
    app.get(A2MCP_MONITOR_PATH, wrap(mon.register));
    app.get(`${A2MCP_MONITOR_PATH}/:id`, wrap(mon.status));
  }

  /* v6 Lane F */
  const c5 = d.cfg.AGENT_C5_ENABLED === "true";
  if (c5 && d.recaps) {
    const recaps = d.recaps;
    app.get(
      "/v1/recaps",
      auth,
      wrap(async (req, res) => {
        const owner = typeof req.query["owner"] === "string" ? req.query["owner"] : "";
        const date = typeof req.query["date"] === "string" ? req.query["date"] : undefined;
        res.json(await recaps.forOwner(callerOf(res), owner, date, req.query["refresh"] === "1"));
      }),
    );
    app.get("/v1/recaps/:id", auth, wrap(async (req, res) => { res.json(await recaps.byId(callerOf(res), String(req.params["id"]))); }));
    app.post("/v1/recaps/:id/share", auth, wrap(async (req, res) => { res.json({ recapId: String(req.params["id"]), share: await recaps.setShare(callerOf(res), String(req.params["id"]), req.body) }); }));
    app.get("/pub/recaps/:shareId", (req, res, next) => { recaps.publicView(String(req.params["shareId"])).then((v) => { res.setHeader("Cache-Control", "public, max-age=30"); res.json(v); }).catch(next); });
  }
  if (c5) {
    // Missions：事件日历 × 资产覆盖；事件源未接上 → 标注日期的回放任务
    app.get(
      "/v1/missions",
      auth,
      wrap(async (req, res) => {
        const now = (d.now ?? (() => new Date()))();
        const horizonDays = Math.min(14, Math.max(1, Number(req.query["horizonDays"] ?? 14) || 14));
        const events = d.agentHooks?.events ? await d.agentHooks.events(new Date(now.getTime() - 6 * 3600_000), new Date(now.getTime() + horizonDays * 86_400_000)) : null;
        const focus = typeof req.query["assetKey"] === "string" ? [req.query["assetKey"]] : [];
        const assets = d.service.registry.entries.filter((e) => e.role === "stock_output").map((e) => ({ assetKey: e.assetKey, displaySymbol: e.displaySymbol, underlyingId: e.underlyingId, executionAllowed: e.executionAllowed }));
        res.json({ generatedAt: now.toISOString(), eventsCoverage: events ? "ok" : "unavailable", missions: buildMissions({ now, events, assets, focus, horizonDays }) });
      }),
    );
  }
  {
    const h = createA2mcpAgentTasksHandler({ cfg: d.cfg, registry: d.service.registry, now: d.now, ...(d.agentHooks ?? {}) });
    app.post(A2MCP_AGENT_TASKS_PATH, wrap(h));
    app.get(A2MCP_AGENT_TASKS_PATH, wrap(h));
  }

  /* ---------- OKX AI A2MCP 单端点（平台调用，不带本服务 API key） ---------- */
  const a2mcp = createA2mcpHandler({ cfg: d.cfg, service: d.service, paywall: d.paywall });
  app.post(A2MCP_PATH, wrap(a2mcp));
  app.get(A2MCP_PATH, wrap(a2mcp));

  // OPTIONS 此前落到下面的 404。对外协议路径上任何非 2xx 都可能被判「端点不可达」，
  // 而 OPTIONS 本来就该回 204 + Allow，不该算错误。
  app.options(/^\/a2mcp\//, (_req, res) => {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(204).end();
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // OKX AI 的调用客户端只接受 200/402，任何其它状态码都被判定为「端点不可达」——
    // ASP #13803 第一次上架审核就是这么被驳回的（空探测回 400）。所以 /a2mcp/* 这几条
    // 对外路径上，输入侧的错误一律回 200 + status:"input_required"，把问题写在正文里。
    // 非 a2mcp 路径（v1 API 面向我们自己的客户端）保持标准 HTTP 语义。
    const isA2mcp = req.path.startsWith("/a2mcp/");
    if (err instanceof HttpError) {
      if (isA2mcp && err.status >= 400 && err.status < 500 && err.status !== 402) {
        res.status(200).json({ ok: false, status: "input_required", error: err.code, message: err.message, details: err.details ?? undefined });
        return;
      }
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details ?? undefined });
      return;
    }
    // 上游报价拿不到 / 方向写拧了：不是服务端内部故障，别兜底成 500（V-24）。
    // no_quotes 用 422（请求本身合法，只是此刻这个方向与数量没有可成交报价）；
    // upstream_unavailable 用 503；mixed_sides 是调用方的参数问题，用 400。
    if (err instanceof UpstreamEvidenceError) {
      const status = err.code === "mixed_sides" ? 400 : err.code === "upstream_unavailable" ? 503 : 422;
      const body = { error: err.code, message: err.message, details: err.detail ?? undefined };
      res.status(isA2mcp && status !== 503 ? 200 : status).json(isA2mcp && status !== 503 ? { ok: false, status: "input_required", ...body } : body);
      return;
    }
    // body-parser 抛出的全部读体错误都是「客户端把请求发坏了」，统一按 4xx 处理。
    // 判定只看 `status`/`statusCode`，不看 `type`：解压失败抛的是 zlib 原生错误
    // （`{ code: "Z_DATA_ERROR", status: 400 }`，**没有 type**），此前只认 `type === "entity.parse.failed"`，
    // 于是「声明 content-encoding: gzip 却发明文」落到兜底分支回了 500（线上实测）。
    const bodyErr = err as { type?: string; code?: string; status?: number; statusCode?: number } | null;
    const bodyErrStatus = bodyErr && typeof bodyErr === "object" ? (bodyErr.status ?? bodyErr.statusCode) : undefined;
    if (typeof bodyErrStatus === "number" && bodyErrStatus >= 400 && bodyErrStatus < 500) {
      const parseFailed = bodyErr?.type === "entity.parse.failed";
      const code = parseFailed ? "invalid_json" : (bodyErr?.type?.replace(/\./g, "_") ?? bodyErr?.code ?? "bad_request");
      if (isA2mcp) {
        res.status(200).json({
          ok: false,
          status: "input_required",
          error: code,
          message: parseFailed
            ? "The request body is not valid JSON. Send a JSON object with content-type: application/json, or pass the same fields as a GET query string."
            : "The request body could not be read. Send a small JSON object with content-type: application/json and no content-encoding, or pass the same fields as a GET query string.",
          example: { ownerAddress: "0x1111111111111111111111111111111111111111", outputAssetKey: "AAPLx", amount: "100" },
        });
        return;
      }
      res.status(bodyErrStatus).json({ error: code });
      return;
    }
    log.error("未处理错误", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal" });
  });

  return app;
}
