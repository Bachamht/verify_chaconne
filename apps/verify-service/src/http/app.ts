/**
 * HTTP 入口（技术设计 §6.1 冻结路径）。所有业务经 VerifyService；付费闸门经 Paywall。
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { POLICIES, policyDefinitionHash, registryHash } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { apiKeyAuth, callerOf } from "./auth";
import type { Paywall } from "./paywall";
import { HttpError, type VerifyService } from "../jobs/service";
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

  /* ---------- 公开行情：主站 poller 每 30s 拉（契约 §10.16；nginx `/pub/` 前缀已分流到本服务） ---------- */
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
        res.setHeader("Cache-Control", "public, max-age=15, s-maxage=30");
        res.json(snap);
      }),
    );
  } else {
    app.get("/pub/market/xlayer", (_req, res) => unavailable(res));
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

  /* ---------- OKX AI A2MCP 单端点（平台调用，不带本服务 API key） ---------- */
  const a2mcp = createA2mcpHandler({ cfg: d.cfg, service: d.service, paywall: d.paywall });
  app.post(A2MCP_PATH, wrap(a2mcp));
  app.get(A2MCP_PATH, wrap(a2mcp));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details ?? undefined });
      return;
    }
    if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    log.error("未处理错误", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal" });
  });

  return app;
}
