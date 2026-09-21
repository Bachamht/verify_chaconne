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
import { startMonitor } from "./mandates/monitor";
import { ClubService } from "./club/service";
import { priorLastTickFromDb } from "./evidence/priorLastTick";
import { log } from "./log";
import type { EvmAddress } from "@chaconne/core/verify";
import { loadRelease } from "./release";

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
      release,
    }),
  });

  const stopReconciler = cfg.paid ? startReconciler(orders, facilitator, cfg.RECONCILE_INTERVAL_MS) : () => {};
  const stopReceipts = cfg.GUARD_ADDRESS
    ? startReceiptVerifier(service, rpcReceiptSource(cfg.XLAYER_RPC_URL), { guard: cfg.GUARD_ADDRESS, confirmations: cfg.RECEIPT_CONFIRMATIONS, unknownAfterMs: cfg.RECEIPT_UNKNOWN_AFTER_MS }, cfg.RECEIPT_INTERVAL_MS)
    : () => {};
  const stopStepReceipts = cfg.PLANGUARD_ADDRESS
    ? startReceiptVerifier(mandates, rpcReceiptSource(cfg.XLAYER_RPC_URL), { guard: cfg.PLANGUARD_ADDRESS, confirmations: cfg.RECEIPT_CONFIRMATIONS, unknownAfterMs: cfg.RECEIPT_UNKNOWN_AFTER_MS, matcher: mandateStepMatcher }, cfg.RECEIPT_INTERVAL_MS)
    : () => {};
  const stopMonitor = cfg.PLANGUARD_ADDRESS ? startMonitor(mandates) : () => {};
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
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("启动失败", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
