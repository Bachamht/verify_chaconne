/**
 * verify-service 启动：独立进程、独立 .env、独立端口（D-080）。
 * 启动护栏：配置组合（O-01）、私钥范围（只允许证明签名私钥）、登记表校验、fixture/生产互斥。
 */
import { assertOnlyAttestationKey, loadConfig } from "./config";
import { openDb } from "./db";
import { loadRegistry } from "./registry";
import { createAttestationSigner } from "./attestation/signer";
import { FixtureEvidenceProvider, type EvidenceProvider } from "./evidence/provider";
import { LiveEvidenceProvider } from "./evidence/live";
import { OkxClient } from "./adapters/okx/client";
import { XLayerMarket } from "./market/xlayer";
import { FinnhubClient } from "./adapters/finnhub";
import { createFacilitator } from "./payments/facilitator";
import { Orders } from "./payments/orders";
import { VerifyService } from "./jobs/service";
import { createPaywall } from "./http/paywall";
import { createApp } from "./http/app";
import { startReconciler } from "./jobs/reconcile";
import { mandateStepMatcher, rpcReceiptSource, startReceiptVerifier } from "./execution/receipts";
import { CorePlanEngine, liveQuoteLadder } from "./plans/engine";
import { PlansService } from "./plans/service";
import { MandatesService } from "./mandates/service";
import { viemRevokedLogReader } from "./tasks/revocations";
import { startMonitor } from "./mandates/monitor";
import { ClubService } from "./club/service";
import { priorLastTickFromDb } from "./evidence/priorLastTick";
import { log } from "./log";
import type { EvmAddress } from "@chaconne/core/verify";
import { loadRelease } from "./release";
/* v6 Lane B */
import { EventStore } from "./events/store";
import { CrowsnestAdapter } from "./context/crowsnest";
import { ContextService } from "./context/service";
import { startContextPoller } from "./context/poller";
import { ThesesService } from "./theses/service";
import { TasksService } from "./tasks/service";
import { loadPlaybooks } from "./tasks/playbooks";
import { FullReserveBudgetCoordinator } from "./tasks/budget";
import { NoopTaskNotifier } from "./tasks/notify";
import { executorPresenceFromNotify, holdingsForLaneD, laneBConditionEvaluator, LaneCBudgetAdapter, LaneCNotifierAdapter, taskCommandsForLaneD, taskReaderForLaneE, tasksForOwnerHook, tasksReaderForLaneD, taskTimelineSink } from "./tasks/integrations";
import { createLaneD } from "./events/earnings/wire";
/* v6 Lane C */
import { DbBudgetCoordinator } from "./budget/coordinator";
import { BudgetService } from "./budget/service";
import { ChainPortfolioReader } from "./portfolio/chain";
import { marketPriceSource, noPriceSource, PortfolioService } from "./portfolio/service";
import { NotifyService, startNotifyDispatcher, telegramSender } from "./notify/service";
import { RebalanceService } from "./rebalance/service";
import { withBudgetSettlement } from "./budget/receiptHook";
/* v6 Lane E */
import { LabService } from "./lab/service";
import { DbReplayArchive } from "./lab/archive";
/* v6 Lane F */
import { RecapsService } from "./recaps/service";
import { dbRecapSources } from "./recaps/sources";
import { DbRecapStore } from "./recaps/store";

async function main(): Promise<void> {
  assertOnlyAttestationKey();
  const cfg = loadConfig();
  const registry = loadRegistry(cfg);
  const { db } = await openDb(cfg.DATABASE_URL);

  const signer = cfg.ATTESTATION_PRIVATE_KEY ? createAttestationSigner(cfg.ATTESTATION_PRIVATE_KEY, cfg.SIGNER_EPOCH) : null;
  let evidence: EvidenceProvider;
  let live: LiveEvidenceProvider | null = null;
  let market: XLayerMarket | null = null;
  if (cfg.EVIDENCE_MODE === "fixture") {
    evidence = new FixtureEvidenceProvider({
      router: (cfg.ROUTER_ADDRESS || "0x5555555555555555555555555555555555555555") as EvmAddress,
      spender: (cfg.SPENDER_ADDRESS || "0x6666666666666666666666666666666666666666") as EvmAddress,
    });
  } else {
    const okx = new OkxClient({ apiKey: cfg.OKX_API_KEY, secretKey: cfg.OKX_SECRET_KEY, passphrase: cfg.OKX_PASSPHRASE, baseUrl: cfg.OKX_API_BASE_URL });
    live = new LiveEvidenceProvider({
      okx,
      finnhub: cfg.FINNHUB_API_KEY ? new FinnhubClient(cfg.FINNHUB_API_KEY) : null,
      rpcUrl: cfg.XLAYER_RPC_URL,
      guardAddress: (cfg.GUARD_ADDRESS || null) as EvmAddress | null,
      approvedRouter: (cfg.ROUTER_ADDRESS || null) as EvmAddress | null,
      approvedSpender: (cfg.SPENDER_ADDRESS || null) as EvmAddress | null,
      priorLastTick: priorLastTickFromDb(db),
    });
    evidence = live;
    // 公开行情与付费核验共用同一把 OKX key（串行 + 间隔 + 30s 缓存，见 market/xlayer.ts 头注）
    market = new XLayerMarket({ okx, registry, publicBaseUrl: cfg.PUBLIC_BASE_URL || undefined });
  }

  const orders = new Orders({ db, now: () => new Date(), entitlement: { maxRefreshes: cfg.ENTITLEMENT_MAX_REFRESHES, windowSeconds: cfg.ENTITLEMENT_WINDOW_SECONDS } });
  const facilitator = createFacilitator(cfg);
  const service = new VerifyService({ db, cfg, registry, evidence, signer, orders });
  const paywall = createPaywall(cfg, facilitator, orders);
  const engine = new CorePlanEngine(live ? liveQuoteLadder(live) : undefined);
  const plans = new PlansService({ db, cfg, registry, evidence, engine, orders, jobs: service });
  const mandates = new MandatesService({ db, cfg, registry, evidence, signer, orders });
  const club = new ClubService({ db, cfg, registry, evidence, engine, jobs: service, plans, mandates, orders });
  if (cfg.paid || cfg.PRODUCT_PRICE_PLAN_USD !== "0" || cfg.PRODUCT_PRICE_TASK_BUNDLE_USD !== "0" || cfg.PRODUCT_PRICE_MONITOR_WINDOW_USD !== "0") await paywall.initialize();

  /* v6 Lane C：C4 组合/通知/心跳、C8 资金组、C3 调仓编排（C4 && C8） */
  const c4 = cfg.AGENT_C4_ENABLED === "true";
  const c8 = cfg.AGENT_C8_ENABLED === "true";
  const reader = new ChainPortfolioReader({ rpcUrl: cfg.XLAYER_RPC_URL });
  const notify = c4 ? new NotifyService({ db, telegram: cfg.VERIFY_TG_BOT_TOKEN ? telegramSender(cfg.VERIFY_TG_BOT_TOKEN) : null, webhookTimeoutMs: cfg.NOTIFY_WEBHOOK_TIMEOUT_MS, publicBaseUrl: cfg.PUBLIC_BASE_URL, allowInsecureWebhook: !cfg.isProd }) : null;
  const budget = c8 ? new BudgetService({ db, registry, coordinator: new DbBudgetCoordinator({ db, balances: reader }), notify, publicBaseUrl: cfg.PUBLIC_BASE_URL }) : null;
  const portfolio = c4 ? new PortfolioService({ db, registry, reader, prices: cfg.PORTFOLIO_PRICE_SOURCE === "market" && market ? marketPriceSource(market) : noPriceSource, budget, notify, evidenceMode: cfg.EVIDENCE_MODE === "live" ? "LIVE" : "FIXTURE" }) : null;
  const rebalance = c4 && c8 && portfolio ? new RebalanceService({ db, cfg, registry, portfolio, reader, mandates, orders, budget, notify }) : null;

  /* ---- v6 Lane B：上下文 / 事件 / 任务 / 理由卡（公钥来自 env；没有公钥 = 一切摄入拒收 → CONTEXT_UNAVAILABLE，不伪装）。
   *      资金组 / 通知 / 执行器在线态经适配器接 C（C4/C8 关闭时退回 stub）；事件台 reader 与命令给 D；任务读取与求值器给 E。 ---- */
  const events = new EventStore(db);
  const keyring = CrowsnestAdapter.keyringFromEnv(cfg.CROWSNEST_PUBKEY_ED25519);
  const crowsnest = new CrowsnestAdapter({ db, events, keyring });
  const context = new ContextService({ db, registry, events, evidenceMode: evidence.mode });
  const playbooks = loadPlaybooks();
  const theses = new ThesesService({ db });
  const tasks = new TasksService({
    db, cfg, registry, evidence, engine, mandates, theses, context, orders, playbooks,
    budget: budget ? new LaneCBudgetAdapter(budget.coordinator) : new FullReserveBudgetCoordinator(),
    notifier: notify ? new LaneCNotifierAdapter(notify) : new NoopTaskNotifier(),
    ...(notify ? { executorPresence: executorPresenceFromNotify(notify) } : {}),
  });
  if (notify) notify.setTimelineSink(taskTimelineSink(db));
  /* v6 Lane D：个人事件台（财报摄入 / 影响清单 / 动作）；任务 reader / 命令 = Lane B，通知 = C outbox */
  const laneD = createLaneD(cfg, db, registry, {
    tasks: tasksReaderForLaneD(tasks),
    commands: taskCommandsForLaneD(tasks),
    ...(portfolio ? { holdings: holdingsForLaneD(portfolio) } : {}),
    ...(notify ? { notify: { enqueue: async (p) => { await notify.notify(p.type, p.entityId, p.version, p.summary, p.url, ""); } } } : {}),
  });
  // 宏观事件（crowsnest 摄入）的改期 / 发布 → Lane D 传播：重算受影响任务的 nextCheckAt / 阻塞 + event.revised|released 通知
  if (laneD) crowsnest.setEventChangeSink((r) => laneD.propagator.onChange(r));
  /* v6 Lane E：求值器 = Lane B evaluateConditions；任务读取 = verify_tasks + 最近一次求值（含证据 / 上下文 / 事件版本） */
  const lab = new LabService({ db, cfg, registry, evaluator: laneBConditionEvaluator(), taskReader: taskReaderForLaneE(tasks), archive: new DbReplayArchive(db) });
  /* v6 Lane F：C5 Recap——任务钩子 = Lane B（callerId+owner 鉴权），事件钩子 = verify_events（D 财报 + B 宏观同一张表） */
  const recaps = cfg.AGENT_C5_ENABLED === "true"
    ? new RecapsService({ sources: dbRecapSources(db, () => (cfg.EVIDENCE_MODE === "live" ? "LIVE" : "FIXTURE"), { tasksForOwner: tasksForOwnerHook(tasks), eventsBetween: async (fromUtc, toUtc) => events.list({ from: fromUtc.toISOString().slice(0, 10), to: toUtc.toISOString().slice(0, 10) }) }), store: new DbRecapStore(db) })
    : null;

  const startedAt = Date.now();
  const release = loadRelease();
  const app = createApp({
    cfg,
    service,
    paywall,
    plans,
    mandates,
    club,
    signer,
    market,
    /* v6 Lane B */
    context,
    crowsnest,
    events,
    tasks,
    theses,
    playbooks,
    laneD,
    budget,
    portfolio,
    rebalance,
    notify,
    lab,
    recaps,
    health: () => ({
      startedAt: new Date(startedAt).toISOString(),
      evidenceMode: cfg.EVIDENCE_MODE,
      registryVersion: registry.version,
      paymentNetwork: cfg.PAYMENT_NETWORK,
      paid: cfg.paid,
      attestation: signer ? { signer: signer.address, epoch: signer.epoch } : null,
      guard: cfg.GUARD_ADDRESS || null,
      planGuard: cfg.PLANGUARD_ADDRESS || null,
      publicMarket: market ? "/pub/market/xlayer" : null,
      agentC6: laneD ? { store: laneD.storeKind, earningsSource: laneD.ingestor ? "finnhub" : null } : null,
      agent: { c4: c4, c8: c8, rebalance: Boolean(rebalance), telegram: Boolean(notify?.telegramConfigured), c5: cfg.AGENT_C5_ENABLED === "true", a2mcpAgentTasks: "/a2mcp/agent-tasks" },
      agentC9: cfg.agentC9Enabled ? { evaluator: lab.evaluatorId, taskReader: "lane-b/verify_tasks" } : null,
      release,
      /* v6 Lane B */
      agentB: { c1: cfg.agentC1, c2: cfg.agentC2, c3: cfg.agentC3, c7: cfg.agentC7, crowsnestKeys: keyring.ids, contextUrl: cfg.CROWSNEST_CONTEXT_URL || null, playbooks: playbooks.version },
    }),
  });

  const stopReconciler = cfg.paid ? startReconciler(orders, facilitator, cfg.RECONCILE_INTERVAL_MS) : () => {};
  const stopReceipts = cfg.GUARD_ADDRESS
    ? startReceiptVerifier(service, rpcReceiptSource(cfg.XLAYER_RPC_URL), { guard: cfg.GUARD_ADDRESS, confirmations: cfg.RECEIPT_CONFIRMATIONS, unknownAfterMs: cfg.RECEIPT_UNKNOWN_AFTER_MS }, cfg.RECEIPT_INTERVAL_MS)
    : () => {};
  const stopStepReceipts = cfg.PLANGUARD_ADDRESS
    ? startReceiptVerifier(budget ? withBudgetSettlement(db, mandates, budget.coordinator) : mandates, rpcReceiptSource(cfg.XLAYER_RPC_URL), { guard: cfg.PLANGUARD_ADDRESS, confirmations: cfg.RECEIPT_CONFIRMATIONS, unknownAfterMs: cfg.RECEIPT_UNKNOWN_AFTER_MS, matcher: mandateStepMatcher }, cfg.RECEIPT_INTERVAL_MS)
    : () => {};
  // v6：任务层与授权层同一 tick；无 PlanGuard 时只跑任务（SIMULATION 任务不需要 PlanGuard）
  // 链上撤销确认（D-088）：有 PlanGuard 地址时才能查 MandateRevoked 日志；没有就不接（任务停在 REVOKE_PENDING 如实显示）
  const revocations = cfg.PLANGUARD_ADDRESS && cfg.agentC3 ? { db, reader: viemRevokedLogReader({ rpcUrl: cfg.XLAYER_RPC_URL, planGuard: cfg.PLANGUARD_ADDRESS as `0x${string}` }) } : null;
  const stopMonitor = cfg.PLANGUARD_ADDRESS || cfg.agentC3 ? startMonitor(mandates, cfg.agentC3 ? tasks : null, revocations) : () => {};
  const stopContext = cfg.agentC1 && cfg.CROWSNEST_CONTEXT_URL ? startContextPoller(crowsnest, events, { contextUrl: cfg.CROWSNEST_CONTEXT_URL, ...(cfg.CROWSNEST_EVENTS_URL ? { eventsUrl: cfg.CROWSNEST_EVENTS_URL } : {}), intervalMs: cfg.CONTEXT_POLL_INTERVAL_MS }) : () => {};
  const stopLaneD = laneD ? laneD.start() : () => {};
  const stopNotify = notify ? startNotifyDispatcher(notify, cfg.NOTIFY_DISPATCH_INTERVAL_MS) : () => {};
  const server = app.listen(cfg.VERIFY_PORT, cfg.VERIFY_HOST, () => {
    log.info("verify-service 已启动", {
      host: cfg.VERIFY_HOST,
      port: cfg.VERIFY_PORT,
      evidenceMode: cfg.EVIDENCE_MODE,
      registry: registry.version,
      paid: cfg.paid,
      network: cfg.PAYMENT_NETWORK,
      attestation: signer ? signer.address : "disabled",
    });
  });
  const shutdown = () => {
    stopReconciler();
    stopReceipts();
    stopStepReceipts();
    stopMonitor();
    stopContext();
    stopLaneD();
    stopNotify();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("启动失败", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
