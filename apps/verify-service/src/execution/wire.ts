/**
 * v7 Lane X 装配（src/index.ts 只调这一个函数）：链只读、permit 域、作业仓储、作业终结处理、委托服务；
 * 后台：清扫器（2 s：补建作业 / 未发送作业过期与回队 / 在途对账 / 自动重签）、链上回填器（CHAIN_RECONCILE_INTERVAL_MS，近 48 h 有活动的授权）。
 * 所有开关都关时不启动任何后台循环（v6 行为）；钩子照样装配（视图里的 v7 字段只对 v7 任务出现）。
 */
import { and, gte, inArray } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyMandates } from "@chaconne/db";
import { p6FromUsdPerShare, type AssetRegistry } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { log } from "../log";
import type { MandatesService } from "../mandates/service";
import type { TasksService } from "../tasks/service";
import type { Orders } from "../payments/orders";
import type { XLayerMarket } from "../market/xlayer";
import type { ReceiptStore } from "./receipts";
import { viemServiceChain, type ServiceChain } from "./chain";
import { OpsState } from "./ops";
import { FeeBudget } from "./fees";
import { ExecutionJobs } from "./jobs";
import { JobOutcomeHandler } from "./recertify";
import { PermitDomains } from "../delegation/domains";
import { DelegationService, type AgentHooksForX } from "../delegation/service";
import type { V7XHandles } from "../http/routes/v7x";

export interface V7XWiring {
  handles: V7XHandles;
  start(): () => void;
}

export function createV7X(a: { db: Db; cfg: VerifyConfig; registry: AssetRegistry; mandates: MandatesService; tasks: TasksService; orders: Orders; market?: XLayerMarket | null; receiptStore?: ReceiptStore; chain?: ServiceChain | null; domains?: PermitDomains; p6For?: (assetKey: string) => Promise<string | null>; agent?: AgentHooksForX | null; operatorAlert?: ((code: string, text: string) => Promise<unknown>) | null; now?: () => Date }): V7XWiring {
  const { db, cfg } = a;
  const on = cfg.v7.delegation || cfg.v7.hostedExecutor || cfg.v7.sell;
  const chain = a.chain !== undefined ? a.chain : on && cfg.PLANGUARD_ADDRESS ? viemServiceChain(cfg.XLAYER_RPC_URL) : null;
  const ops = new OpsState(a.now);
  const domains = a.domains ?? PermitDomains.load(cfg.PERMIT_DOMAINS_FILE, cfg.EXECUTION_CHAIN_ID);
  const fees = new FeeBudget({ db, cfg, chain, operatorAlert: a.operatorAlert ?? null, ...(a.now ? { now: a.now } : {}) });
  const outcomes = new JobOutcomeHandler({ db, cfg, tasks: a.tasks, ops, fees, ...(a.now ? { now: a.now } : {}), ...(a.agent ? { onExecutionFailed: (taskId, info) => a.agent!.onExecutionFailed(taskId, info) } : {}) });
  let delegation: DelegationService | null = null;
  const jobs = cfg.PLANGUARD_ADDRESS ? new ExecutionJobs({ db, cfg, mandates: a.mandates, ops, chain, fees, ...(a.now ? { now: a.now } : {}), onTerminal: (i) => outcomes.onTerminal(i), onPermitResult: (id, ok, info) => delegation!.onPermitResult(id, ok, info) }) : null;
  const p6For = a.p6For ?? (a.market
    ? async (assetKey: string) => {
        const snap = await a.market!.snapshot();
        const tok = snap?.tokens.find((t) => t.address.toLowerCase() === assetKey.split(":").pop()!.toLowerCase());
        return tok && typeof tok.priceUsd === "number" && Number.isFinite(tok.priceUsd) && tok.priceUsd > 0 ? p6FromUsdPerShare(tok.priceUsd.toFixed(6)) : null;
      }
    : undefined);
  delegation = new DelegationService({ db, cfg, registry: a.registry, tasks: a.tasks, mandates: a.mandates, orders: a.orders, jobs, chain, ops, domains, fees, ...(p6For ? { p6For } : {}), ...(a.agent ? { agent: a.agent } : {}), ...(a.now ? { now: a.now } : {}) });
  a.tasks.setV7Hooks(delegation);
  a.mandates.setExecutionHooks({ chain, ops, marginS: cfg.EXECUTION_EXPIRY_MARGIN_S, ...(jobs ? { onStepState: (stepId, state) => jobs.onStepState(stepId, state) } : {}), ...(a.receiptStore ? { receiptStore: a.receiptStore } : {}) });
  const handles: V7XHandles = { lane: "x", delegation, jobs, ops, domains, outcomes, fees };
  return {
    handles,
    start() {
      if (!on) return () => {};
      if (chain) void domains.verifyOnChain(chain).then((r) => log.info("permit 域启动比对", r)).catch(() => undefined);
      let sweeping = false;
      const sweeper = setInterval(() => {
        if (sweeping || !jobs) return;
        sweeping = true;
        jobs
          .sweep()
          .then(() => outcomes.tick())
          .catch((err) => log.warn("作业清扫失败", { error: err instanceof Error ? err.message : String(err) }))
          .finally(() => {
            sweeping = false;
          });
      }, 2000);
      sweeper.unref();
      let reconciling = false;
      const reconciler = setInterval(() => {
        if (reconciling || !chain) return;
        reconciling = true;
        reconcileOnce(db, a.mandates)
          .catch((err) => log.warn("链上回填失败", { error: err instanceof Error ? err.message : String(err) }))
          .finally(() => {
            reconciling = false;
          });
      }, cfg.CHAIN_RECONCILE_INTERVAL_MS);
      reconciler.unref();
      return () => {
        clearInterval(sweeper);
        clearInterval(reconciler);
      };
    },
  };
}

/** 链上回填器一轮：近 48 h 有活动的 ACTIVE / PAUSED / COMPLETED 授权 */
export async function reconcileOnce(db: Db, mandates: MandatesService): Promise<number> {
  const since = new Date(Date.now() - 48 * 3600_000);
  const rows = await db.select().from(verifyMandates).where(and(inArray(verifyMandates.state, ["ACTIVE", "PAUSED", "COMPLETED"]), gte(verifyMandates.updatedAt, since)));
  let n = 0;
  for (const m of rows) n += (await mandates.backfillMandate(m)).backfilled;
  return n;
}
