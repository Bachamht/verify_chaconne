/**
 * Lane D 装配：index.ts 只需 `createLaneD(...)` 一行。开关 AGENT_C6_ENABLED=false → 返回 null（路由不挂）。
 * 存储：AGENT_C6_STORE=db → Drizzle（迁移 0018 后）；memory → 进程内（本地演示，重启即空）。
 * 持仓 / 任务 / 通知 reader 默认 notReady stub，Lane I 合并时替换成 Lane B/C 实现。
 */
import type { AssetRegistry } from "@chaconne/core/verify";
import type { Db } from "@chaconne/db";
import type { VerifyConfig } from "../../config";
import { log } from "../../log";
import { ImpactActions } from "../../impacts/actions";
import { MemoryNotifier, notReadyCommands, notReadyHoldings, notReadyTasks, type HoldingsReader, type Notifier, type TaskCommands, type TasksReader } from "../../impacts/readers";
import { ImpactsService } from "../../impacts/service";
import { FinnhubEarningsClient, type EarningsCalendarSource } from "./finnhubEarnings";
import { EarningsIngestor } from "./ingest";
import { EventRevisionPropagator } from "./propagate";
import { DrizzleEventStore, DrizzleEvidenceSink, MemoryEventStore, MemoryEvidenceSink, type EventStore, type EvidenceSink } from "./store";

export interface LaneDHandles {
  store: EventStore;
  evidence: EvidenceSink;
  ingestor: EarningsIngestor | null;
  propagator: EventRevisionPropagator;
  impacts: ImpactsService;
  actions: ImpactActions;
  notifier: Notifier;
  storeKind: "db" | "memory";
  /** 周期摄入；无 Finnhub key 时为空函数 */
  start(): () => void;
}

export interface LaneDOverrides {
  holdings?: HoldingsReader;
  tasks?: TasksReader;
  commands?: TaskCommands;
  notify?: Notifier;
  source?: EarningsCalendarSource | null;
  clock?: () => Date;
}

export function createLaneD(cfg: VerifyConfig, db: Db | null, registry: AssetRegistry, o: LaneDOverrides = {}): LaneDHandles | null {
  if (cfg.AGENT_C6_ENABLED !== "true") return null;
  const useDb = cfg.AGENT_C6_STORE === "db" && db !== null;
  const store: EventStore = useDb ? new DrizzleEventStore(db!) : new MemoryEventStore();
  const evidence: EvidenceSink = useDb ? new DrizzleEvidenceSink(db!) : new MemoryEvidenceSink();
  const holdings = o.holdings ?? notReadyHoldings;
  const tasks = o.tasks ?? notReadyTasks;
  const commands = o.commands ?? notReadyCommands;
  const notifier = o.notify ?? new MemoryNotifier();
  const clock = o.clock;
  const propagator = new EventRevisionPropagator({ tasks, commands, notify: notifier, clock, publicBaseUrl: cfg.PUBLIC_BASE_URL });
  const source = o.source === undefined ? (cfg.FINNHUB_API_KEY ? new FinnhubEarningsClient(cfg.FINNHUB_API_KEY, fetch, "https://finnhub.io/api/v1", clock) : null) : o.source;
  const ingestor = source
    ? new EarningsIngestor({ source, registry, store, evidence, clock, spacingMs: cfg.EARNINGS_REQUEST_SPACING_MS, horizonDays: cfg.EARNINGS_HORIZON_DAYS, onChange: (r) => propagator.onChange(r).then(() => undefined) })
    : null;
  const impacts = new ImpactsService({ store, registry, holdings, tasks, clock });
  const actions = new ImpactActions({ store, evidence, tasks, commands, registry, clock });
  return {
    store,
    evidence,
    ingestor,
    propagator,
    impacts,
    actions,
    notifier,
    storeKind: useDb ? "db" : "memory",
    start() {
      if (!ingestor) {
        log.warn("C6 财报摄入未启动：无 FINNHUB_API_KEY（事件台显示覆盖未知）");
        return () => {};
      }
      log.info("C6 财报摄入已排程", { intervalMs: cfg.EARNINGS_INGEST_INTERVAL_MS, store: useDb ? "db" : "memory" });
      return ingestor.start(cfg.EARNINGS_INGEST_INTERVAL_MS);
    },
  };
}
