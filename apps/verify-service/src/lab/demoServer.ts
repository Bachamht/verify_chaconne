/**
 * Lane E 本地演示服务器（仅截图/联调；**不是生产入口**）：
 *   VERIFY_PORT=8790 npx tsx apps/verify-service/src/lab/demoServer.ts
 * PGlite 内存库 + FIXTURE 证据 + 内存 TaskReader（一个 WAITING 的 session_dca 任务，评估证据全是 fixture）+ 内存回放档案
 * （sample 上下文 = crowsnest 黄金样本形态，provenance.mode="sample"）。所有产物都标 FIXTURE / SIMULATION / REPLAY，不会出现 LIVE。
 * 页面 verify-web 用 VERIFY_SERVICE_URL=http://127.0.0.1:8790 VERIFY_WEB_API_KEY=vk_lab_demo 指过来。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@chaconne/db";
import type { Db } from "@chaconne/db";
import { buildConditionSet, createReferenceEvaluator, type CtxField, type EvidenceRecord, type LabTaskRecord, type MarketContext, type MarketEvent, type PlanGoal, type ReplayArchive } from "@chaconne/core/verify";
import { FIXTURE_OWNER, FIXTURE_RECIPIENT, FIXTURE_STABLE, FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY, quoteEvidence } from "@chaconne/core/verify/fixtures";
import { loadConfig } from "../config";
import { loadRegistry } from "../registry";
import { FixtureEvidenceProvider } from "../evidence/provider";
import { createMockControl, MockFacilitatorClient, ObservedFacilitator } from "../payments/facilitator";
import { Orders } from "../payments/orders";
import { VerifyService } from "../jobs/service";
import { createPaywall } from "../http/paywall";
import { createApp } from "../http/app";
import { CorePlanEngine } from "../plans/engine";
import { PlansService } from "../plans/service";
import { MandatesService } from "../mandates/service";
import { ClubService } from "../club/service";
import { LabService } from "./service";
import { InMemoryReplayArchive } from "./archive";
import { InMemoryTaskReader } from "./tasks";
import { ensureLabTables } from "./store";
import { log } from "../log";

const field = <T,>(value: T | null, at: string, status: CtxField<T>["status"] = "ok", note?: string): CtxField<T> => ({ value, source: "fixture", observedAt: value === null ? null : at, fetchedAt: at, status, purposes: ["agent"], ...(note ? { note } : {}) });
function ctx(packagedAt: string, vix: string | null, mode: "sample" | "backfill"): MarketContext {
  const f = <T,>(v: T) => field<T>(v, packagedAt);
  const nil = field<string>(null, packagedAt, "unavailable", "回填源无此字段");
  const str = field<string | null>(null, packagedAt);
  return {
    schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt, signature: "0x00", signatureAlg: "ed25519", publicKeyId: "demo",
    session: { label: f<"US_REGULAR">("US_REGULAR"), usTradingDay: f(true), holiday: str, earlyClose: f(false), hoursToUsOpen: f("0"), hoursToUsClose: f("3"), etDate: f(packagedAt.slice(0, 10)) },
    events: [], fed: { blackout: f(false), blackoutUntil: str, hikeProb: nil, hikeProbDrift24hPp: nil },
    rates: { y2: nil, y10: nil, y30: nil, s2s30Bp: nil, curveShape: str, realYield10: nil, move: nil },
    risk: { vix: vix === null ? nil : field<string>(vix, packagedAt), nqOvernightPct: nil, esOvernightPct: nil, dxy: nil, dxyPct1d: nil },
    crossAsset: { lastDataRelease: field<{ eventId: string; state: "relief"; atUtc: string } | null>(null, packagedAt) },
    driftVerdict: field<string>(null, packagedAt, "unavailable"),
    provenance: { mode },
  };
}
function event(id: string, revision: number, scheduledAtUtc: string, firstKnownAt: string): MarketEvent {
  return { id, kind: "MACRO_TIER1", name: "Fixture macro release", underlyingIds: [], scheduledAtUtc, dateLocal: scheduledAtUtc.slice(0, 10), datePrecision: "exact", sessionHint: null, status: revision > 1 ? "revised" : "confirmed", revision, source: "fixture", sourceFetchedAt: firstKnownAt, firstKnownAt, tz: "America/New_York" };
}
function ctxEvidence(id: string, receivedAt: string, packagedAt: string): EvidenceRecord {
  return { evidenceId: id, provider: "crowsnest", endpoint: "/context/latest.json", requestFingerprint: "ctx", time: { requestedAt: receivedAt, receivedAt, sourcePublishedAt: packagedAt, sourceTimeKind: "published" }, block: null, rawHash: `0x${"11".repeat(32)}`, parserVersion: "demo", mode: "FIXTURE", payload: { kind: "market_context", schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt, publicKeyId: "demo", signatureValid: true, contextHash: `0x${"22".repeat(32)}`, fieldStatus: {} } };
}

async function main(): Promise<void> {
  const port = Number(process.env["VERIFY_PORT"] ?? 8790);
  const cfg = loadConfig({ DATABASE_URL: "pglite://memory", NODE_ENV: "development", PAYMENT_MODE: "mock", REPORT_PRICE_USD: "0", EVIDENCE_MODE: "fixture", REGISTRY_MODE: "fixture", EXECUTION_CHAIN_ID: "196", VERIFY_API_KEYS: "vk_lab_demo:web*,vk_lab_cli:lab-cli", RATE_LIMIT_PER_MIN: "1000", VERIFY_PORT: String(port) });
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(drizzle(client), { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "db", "migrations") });
  await ensureLabTables(db);
  const registry = loadRegistry(cfg);
  const now = () => new Date();
  const evidence = new FixtureEvidenceProvider({ router: "0x5555555555555555555555555555555555555555", spender: "0x6666666666666666666666666666666666666666", scenario: "live" });
  const orders = new Orders({ db, now, entitlement: { maxRefreshes: 2, windowSeconds: 300 } });
  const service = new VerifyService({ db, cfg, registry, evidence, signer: null, orders, now });
  const paywall = createPaywall(cfg, new ObservedFacilitator(new MockFacilitatorClient(cfg.PAYMENT_NETWORK, createMockControl())), orders);
  await paywall.initialize();
  const engine = new CorePlanEngine();
  const plans = new PlansService({ db, cfg, registry, evidence, engine, orders, jobs: service, now });
  const mandates = new MandatesService({ db, cfg, registry, evidence, signer: null, orders, now });
  const club = new ClubService({ db, cfg, registry, evidence, engine, jobs: service, plans, mandates, orders, now });

  // 演示任务：最近一次评估 = 2 分钟前；事件 = 评估前 9 分钟的一级宏观发布（→ wait20 等待 / wait5 放行）；vix "28"（→ max_vix 20 阻塞）
  const t0 = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const evalAt = iso(t0 - 2 * 60_000);
  const goal: PlanGoal = { ownerAddress: FIXTURE_OWNER, recipientAddress: FIXTURE_RECIPIENT, executionChainId: 196, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }], budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "100000000" }, side: "buy", policyId: "STRICT_LIVE", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, deadline: iso(t0 + 86_400_000) };
  const task: LabTaskRecord = {
    task: { id: "task_demo_dca", owner: FIXTURE_OWNER, playbookId: "session_dca", goal, conditions: buildConditionSet([{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }, { type: "max_vix", value: 20 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }]), mandateIds: [], status: "WAITING", blockers: [], nextCheckAt: null, executorPresence: "offline", createdAt: iso(t0 - 3600_000), updatedAt: evalAt },
    callerId: `web:${FIXTURE_OWNER}`,
    taskState: { lastConfirmedStepAt: null, stepsConfirmedToday: 0, stepsConfirmed: 0 },
    goal,
    latestEvaluation: {
      evaluatedAt: evalAt,
      evaluation: null,
      evidence: {
        records: [quoteEvidence({ receivedAt: iso(t0 - 2 * 60_000 - 2000), amountInRaw: "100000000", fromToken: FIXTURE_STABLE, toToken: FIXTURE_STOCK, id: "ev_demo_quote" }), ctxEvidence("ev_demo_ctx", iso(t0 - 2 * 60_000 - 30_000), iso(t0 - 3 * 60_000))],
        context: ctx(iso(t0 - 3 * 60_000), "28", "sample"),
        events: [event("fixture:MACRO_TIER1:demo:cpi", 1, iso(t0 - 11 * 60_000), iso(t0 - 86_400_000))],
      },
    },
  };
  const taskReader = new InMemoryTaskReader().put(task);

  // 演示回放档案（过去 3 天）：sample 上下文每小时一份（只有前 2 天）、第 3 天无档案；事件一个修订（改期后来才可知）；一个报价；参考价断供 2 小时
  const dayMs = 86_400_000;
  const contextSnapshots: ReplayArchive["contextSnapshots"] = [];
  for (let t = t0 - 3 * dayMs; t < t0 - 1 * dayMs; t += 3600_000) contextSnapshots.push({ receivedAt: iso(t), context: ctx(iso(t), t % (2 * 3600_000) === 0 ? "17.9" : "22.4", "backfill") });
  const evT = t0 - 2 * dayMs + 6 * 3600_000;
  const archive: ReplayArchive = {
    records: [quoteEvidence({ receivedAt: iso(t0 - 2 * dayMs + 7 * 3600_000), fromToken: FIXTURE_STABLE, toToken: FIXTURE_STOCK, id: "ev_demo_rp_quote" })],
    contextSnapshots,
    eventVersions: [event("fixture:MACRO_TIER1:demo:release", 1, iso(evT), iso(t0 - 10 * dayMs)), event("fixture:MACRO_TIER1:demo:release", 2, iso(evT + 2 * 3600_000), iso(evT + 30 * 60_000))],
    referenceBars: [],
    referencePurged: [{ from: iso(t0 - 2 * dayMs + 10 * 3600_000), to: iso(t0 - 2 * dayMs + 12 * 3600_000) }],
  };
  const lab = new LabService({ db, cfg, registry, evaluator: createReferenceEvaluator(), taskReader, archive: new InMemoryReplayArchive(archive), now });
  const app = createApp({ cfg, service, paywall, plans, mandates, club, signer: null, market: null, lab, health: () => ({ demo: "lane-e", evidenceMode: "fixture", agentC9: { evaluator: lab.evaluatorId, taskReader: "in-memory-demo" } }) });
  app.listen(port, "127.0.0.1", () => log.info("Lane E demo server（FIXTURE，只用于截图/联调）", { port, taskId: task.task.id, owner: FIXTURE_OWNER }));
}

main().catch((e) => {
  log.error("demo server 启动失败", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
