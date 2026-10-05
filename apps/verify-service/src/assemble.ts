/**
 * verify-service 装配（index.ts 与本地分叉 e2e 共用同一份生产装配）：配置 → 各服务 → express app；后台循环由 start() 启动、返回停止函数。
 * 可注入项只给本地分叉 e2e 用：已迁移的 db（pglite）、证据提供者（fixture 证据 + 分叉上的本地路由）。生产 index.ts 不传任何注入项。
 */
import type { Db } from "@chaconne/db";
import type { EvmAddress } from "@chaconne/core/verify";
import type { VerifyConfig } from "./config";
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
import { loadRelease } from "./release";
/* v6 Lane B */
import { EventStore } from "./events/store";
import { CrowsnestAdapter } from "./context/crowsnest";
import { ContextService } from "./context/service";
import { startContextPoller } from "./context/poller";
import { ThesesService } from "./theses/service";
import { TasksService } from "./tasks/service";
import { ApiKeysService } from "./keys/service";
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
import { AgentRuntime, type AgentRuntimeProviders } from "./agent/service";
import { RebalanceService } from "./rebalance/service";
import { withBudgetSettlement } from "./budget/receiptHook";
/* v6 Lane E */
import { LabService } from "./lab/service";
import { DbReplayArchive } from "./lab/archive";
/* v6 Lane F */
import { RecapsService } from "./recaps/service";
import { dbRecapSources } from "./recaps/sources";
import { DbRecapStore } from "./recaps/store";
/* v7 Lane X */
import { createV7X } from "./execution/wire";
import { executorHealth, type ExecutorHealth } from "./execution/health";

export interface AssembleOptions {
  /** 已打开（并已迁移）的数据库 */
  db: Db;
  /** 只给本地分叉 e2e：替换证据提供者（生产按 EVIDENCE_MODE 构造） */
  evidence?: EvidenceProvider;
  /** 只给本地分叉 e2e：卖出上限公式的 P6 来源（生产 = 公开行情快照；fixture 模式没有行情） */
  p6For?: (assetKey: string) => Promise<string | null>;
}

export type AssembledService = Awaited<ReturnType<typeof assembleService>>;

export async function assembleService(cfg: VerifyConfig, opts: AssembleOptions) {
  const { db } = opts;
  const registry = loadRegistry(cfg);
  const signer = cfg.ATTESTATION_PRIVATE_KEY ? createAttestationSigner(cfg.ATTESTATION_PRIVATE_KEY, cfg.SIGNER_EPOCH) : null;
  let evidence: EvidenceProvider;
  let live: LiveEvidenceProvider | null = null;
  let market: XLayerMarket | null = null;
  if (opts.evidence) {
    evidence = opts.evidence;
  } else if (cfg.EVIDENCE_MODE === "fixture") {
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
      // 单笔核验的路由证据：以 PlanGuard 作执行合约取 OKX calldata（Agent 交易真正走的合约；Guard 单笔执行 10/5 起删除）
      guardAddress: (cfg.PLANGUARD_ADDRESS || null) as EvmAddress | null,
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
  const keys = new ApiKeysService({ db, now: () => new Date() });
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

  /* v7 Lane A：托管 Agent 运行时（HOSTED_AGENT_ENABLED=false 时路由回 503、钩子不动作；价格缺失 = 不启用并告警） */
  notify?.setOperatorChannel(cfg.OPERATOR_TELEGRAM_CHAT_ID);
  /* v7 Lane X → Lane A：决策上下文的数据提供者（v7x 装配后填入） */
  const agentProviders: AgentRuntimeProviders = {};
  const agentRuntime = new AgentRuntime({ db, cfg, tasks, theses, context, evidence, registry, providers: agentProviders, notifier: notify ? new LaneCNotifierAdapter(notify) : null, operatorAlert: notify ? (code, text) => notify.operatorAlert(code, text) : null });
  agentRuntime.attachOutcomeHooks(events.outcomeHooks, async (id) => events.byId(id));
  if (laneD) agentRuntime.attachOutcomeHooks(laneD.outcomeHooks, async (id) => laneD.store.get(id));
  let agentHealth: Record<string, unknown> = { enabled: agentRuntime.enabled, lastHeartbeatAt: null, lastRunAt: null, costTodayUsdMicros: "0" };
  const refreshAgentHealth = () => agentRuntime.status().then((st) => { agentHealth = { enabled: st.enabled, pricesConfigured: st.pricesConfigured, lastHeartbeatAt: st.lastHeartbeatAt, lastRunAt: st.lastRunAt, costTodayUsdMicros: st.costTodayUsdMicros }; }).catch(() => undefined);
  /* v7 Lane X：委托 / 执行作业 / 自主减仓（开关全关 = v6 行为，不启动后台循环） */
  const stepReceipts = budget ? withBudgetSettlement(db, mandates, budget.coordinator) : mandates;
  const v7x = createV7X({ db, cfg, registry, mandates, tasks, orders, market, agent: agentRuntime, operatorAlert: notify ? (code: string, text: string) => notify.operatorAlert(code, text) : null, receiptStore: stepReceipts, ...(opts.p6For ? { p6For: opts.p6For } : {}) });
  Object.assign(agentProviders, v7x.handles.delegation.agentProviders());
  /* /healthz 的 executor 段（§12.15）：最近一次心跳的执行身份 */
  const executorEnabled = cfg.v7.hostedExecutor && !!v7x.handles.jobs;
  let executorSection: ExecutorHealth = { enabled: executorEnabled, address: null, gasOk: null, lastHeartbeatAt: null };
  const refreshExecutorHealth = async () => {
    const jobs = v7x.handles.jobs;
    if (!jobs) return;
    try {
      executorSection = executorHealth(executorEnabled, await jobs.executorStatuses(), (e) => jobs.gasLow(e));
    } catch {
      /* 读失败：保留上一次 */
    }
  };

  const startedAt = Date.now();
  const release = loadRelease();
  const app = createApp({
    cfg,
    service,
    keys,
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
    v7: { a: { runtime: agentRuntime }, r: { lane: "r", runtime: (row) => v7x.handles.delegation.runtime(row) }, x: v7x.handles },
    // A2MCP agent-tasks / GET /v1/missions 的事件影响与事件列表 = 与 /v1/event-impacts、/v1/events 同一实现（V-25：此前未接，字段永远 unavailable）
    agentHooks: {
      ...(laneD ? { impacts: async (owner: string, horizonHours: number) => (await laneD.impacts.impacts(owner, horizonHours)).impacts } : {}),
      events: async (fromUtc: Date, toUtc: Date) => events.list({ from: fromUtc.toISOString().slice(0, 10), to: toUtc.toISOString().slice(0, 10) }),
    },
    health: () => ({
      startedAt: new Date(startedAt).toISOString(),
      evidenceMode: opts.evidence ? opts.evidence.mode.toLowerCase() : cfg.EVIDENCE_MODE,
      registryVersion: registry.version,
      paymentNetwork: cfg.PAYMENT_NETWORK,
      paid: cfg.paid,
      attestation: signer ? { signer: signer.address, epoch: signer.epoch } : null,
      planGuard: cfg.PLANGUARD_ADDRESS || null,
      publicMarket: market ? "/pub/market/xlayer" : null,
      agentC6: laneD ? { store: laneD.storeKind, earningsSource: laneD.ingestor ? "finnhub" : null } : null,
      agent: { c4: c4, c8: c8, rebalance: Boolean(rebalance), telegram: Boolean(notify?.telegramConfigured), c5: cfg.AGENT_C5_ENABLED === "true", a2mcpAgentTasks: "/a2mcp/agent-tasks" },
      agentHosted: agentHealth,
      executor: executorSection,
      agentC9: cfg.agentC9Enabled ? { evaluator: lab.evaluatorId, taskReader: "lane-b/verify_tasks" } : null,
      release,
      /* v6 Lane B */
      agentB: { c1: cfg.agentC1, c2: cfg.agentC2, c3: cfg.agentC3, c7: cfg.agentC7, crowsnestKeys: keyring.ids, contextUrl: cfg.CROWSNEST_CONTEXT_URL || null, playbooks: playbooks.version },
    }),
  });

  /** 启动全部后台循环；返回停止函数 */
  const start = (): (() => void) => {
    void refreshAgentHealth();
    void refreshExecutorHealth();
    const healthTimer = setInterval(() => {
      void refreshAgentHealth();
      void refreshExecutorHealth();
    }, 30_000);
    healthTimer.unref();
    agentRuntime.start();
    const stopReconciler = cfg.paid ? startReconciler(orders, facilitator, cfg.RECONCILE_INTERVAL_MS) : () => {};
    const stopStepReceipts = cfg.PLANGUARD_ADDRESS
      ? startReceiptVerifier(stepReceipts, rpcReceiptSource(cfg.XLAYER_RPC_URL), { guard: cfg.PLANGUARD_ADDRESS, confirmations: cfg.RECEIPT_CONFIRMATIONS, unknownAfterMs: cfg.RECEIPT_UNKNOWN_AFTER_MS, matcher: mandateStepMatcher }, cfg.RECEIPT_INTERVAL_MS)
      : () => {};
    // v6：任务层与授权层同一 tick；无 PlanGuard 时只跑任务（SIMULATION 任务不需要 PlanGuard）
    // 链上撤销确认（D-088）：有 PlanGuard 地址时才能查 MandateRevoked 日志；没有就不接（任务停在 REVOKE_PENDING 如实显示）
    const revocations = cfg.PLANGUARD_ADDRESS && cfg.agentC3 ? { db, reader: viemRevokedLogReader({ rpcUrl: cfg.XLAYER_RPC_URL, planGuard: cfg.PLANGUARD_ADDRESS as `0x${string}` }) } : null;
    const stopMonitor = cfg.PLANGUARD_ADDRESS || cfg.agentC3 ? startMonitor(mandates, cfg.agentC3 ? tasks : null, revocations) : () => {};
    const stopContext = cfg.agentC1 && cfg.CROWSNEST_CONTEXT_URL ? startContextPoller(crowsnest, events, { contextUrl: cfg.CROWSNEST_CONTEXT_URL, ...(cfg.CROWSNEST_EVENTS_URL ? { eventsUrl: cfg.CROWSNEST_EVENTS_URL } : {}), intervalMs: cfg.CONTEXT_POLL_INTERVAL_MS }) : () => {};
    const stopLaneD = laneD ? laneD.start() : () => {};
    const stopNotify = notify ? startNotifyDispatcher(notify, cfg.NOTIFY_DISPATCH_INTERVAL_MS) : () => {};
    const stopV7X = v7x.start();
    return () => {
      stopReconciler();
      stopStepReceipts();
      stopMonitor();
      stopContext();
      stopLaneD();
      stopNotify();
      stopV7X();
      agentRuntime.stop();
      clearInterval(healthTimer);
    };
  };

  return { app, start, registry, signer, evidence, service, mandates, tasks, crowsnest, events, notify, agentRuntime, v7x: v7x.handles, stepReceipts };
}
