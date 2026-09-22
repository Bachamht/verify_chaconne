/** 测试基建：PGlite + 全部迁移 + 内存 express + mock facilitator + fixture 证据 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@chaconne/db";
import type { Db } from "@chaconne/db";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@okxweb3/x402-core/http";
import type { EvmAddress } from "@chaconne/core/verify";
import { fixtureJob, FIXTURE_OWNER, T_REGULAR } from "@chaconne/core/verify/fixtures";
import { loadConfig, type VerifyConfig } from "../src/config";
import { loadRegistry } from "../src/registry";
import { createAttestationSigner } from "../src/attestation/signer";
import { FixtureEvidenceProvider, type CollectedEvidence, type EvidenceProvider, type FixtureProviderOptions } from "../src/evidence/provider";
import { createMockControl, MockFacilitatorClient, ObservedFacilitator, type MockFacilitatorControl } from "../src/payments/facilitator";
import { Orders } from "../src/payments/orders";
import { VerifyService } from "../src/jobs/service";
import { createPaywall } from "../src/http/paywall";
import { createApp } from "../src/http/app";
import { CorePlanEngine } from "../src/plans/engine";
import { PlansService } from "../src/plans/service";
import { MandatesService } from "../src/mandates/service";
import { ClubService } from "../src/club/service";
import { resetRateLimits } from "../src/http/auth";
import type { XLayerMarket } from "../src/market/xlayer";

export const TEST_API_KEY = "vk_test_alpha";
export const TEST_CALLER = "caller-alpha";
export const OTHER_API_KEY = "vk_test_beta";
export const OTHER_CALLER = "caller-beta";
/** 测试用证明私钥（公开的 anvil 默认账户 #0，仅测试） */
export const TEST_ATTESTATION_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_GUARD: EvmAddress = "0x4444444444444444444444444444444444444444";
export const TEST_PLANGUARD: EvmAddress = "0x7777777777777777777777777777777777777777";
/** 公开的 anvil 测试账户 #1（仅测试）：演示用户/授权计划签署者 */
export const TEST_OWNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const TEST_MERCHANT: EvmAddress = "0xcccccccccccccccccccccccccccccccccccccccc";

export async function testDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "db", "migrations");
  await migrate(drizzle(client), { migrationsFolder });
  return { db, close: () => client.close() };
}

export interface TestEnvOptions {
  priceUsd?: string;
  scenario?: FixtureProviderOptions["scenario"];
  now?: string;
  withSigner?: boolean;
  withGuard?: boolean;
  maxRefreshes?: number;
  extraKeys?: string;
  /** 对 fixture 证据集合做后处理（如把报价 receivedAt 前移，测证书 TTL） */
  evidenceDecorator?: (c: CollectedEvidence, nowIso: string) => CollectedEvidence;
  /** 额外环境变量（v2 商品价格 / PLANGUARD_ADDRESS 等） */
  env?: Record<string, string>;
  /** v2：接上 plans / mandates / club（默认接上，PLANGUARD_ADDRESS=TEST_PLANGUARD） */
  withPlanGuard?: boolean;
  /** 公开行情（默认不接 → /pub/market/xlayer 503） */
  market?: XLayerMarket | null;
}

export interface TestEnv {
  url: string;
  db: Db;
  cfg: VerifyConfig;
  control: MockFacilitatorControl;
  orders: Orders;
  service: VerifyService;
  paywall: ReturnType<typeof createPaywall>;
  plans: PlansService;
  mandates: MandatesService;
  club: ClubService;
  signer: ReturnType<typeof createAttestationSigner> | null;
  setNow(iso: string): void;
  /** 切换 fixture 证据场景（模拟时段变化） */
  setScenario(s: NonNullable<FixtureProviderOptions["scenario"]>): void;
  cfgNow(): string;
  close(): Promise<void>;
}

export async function createTestEnv(opts: TestEnvOptions = {}): Promise<TestEnv> {
  resetRateLimits();
  let nowIso = opts.now ?? T_REGULAR;
  const now = () => new Date(nowIso);
  const cfg = loadConfig({
    DATABASE_URL: "pglite://memory",
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    PAYMENT_NETWORK: "eip155:1952",
    REPORT_PRICE_USD: opts.priceUsd ?? "0",
    MERCHANT_RECIPIENT_ADDRESS: TEST_MERCHANT,
    EVIDENCE_MODE: "fixture",
    REGISTRY_MODE: "fixture",
    EXECUTION_CHAIN_ID: "196",
    GUARD_ADDRESS: opts.withGuard === false ? "" : TEST_GUARD,
    PLANGUARD_ADDRESS: opts.withPlanGuard === false ? "" : TEST_PLANGUARD,
    ATTESTATION_PRIVATE_KEY: opts.withSigner === false ? "" : TEST_ATTESTATION_KEY,
    VERIFY_API_KEYS: `${TEST_API_KEY}:${TEST_CALLER},${OTHER_API_KEY}:${OTHER_CALLER}${opts.extraKeys ? "," + opts.extraKeys : ""}`,
    ENTITLEMENT_MAX_REFRESHES: String(opts.maxRefreshes ?? 2),
    ENTITLEMENT_WINDOW_SECONDS: "300",
    RATE_LIMIT_PER_MIN: "1000",
    SETTLE_POLL_DEADLINE_MS: "300",
    ...(opts.env ?? {}),
  });
  // 测试里“fixture 证据 + 收费”是被 O-01 护栏禁止的组合；这里通过 mock 支付模式绕开的是支付网络，不是证据真实性
  const { db, close } = await testDb();
  const registry = loadRegistry(cfg);
  const signer = cfg.ATTESTATION_PRIVATE_KEY ? createAttestationSigner(cfg.ATTESTATION_PRIVATE_KEY, cfg.SIGNER_EPOCH) : null;
  const fixtureOpts: FixtureProviderOptions = {
    router: "0x5555555555555555555555555555555555555555",
    spender: "0x6666666666666666666666666666666666666666",
    scenario: opts.scenario ?? "live",
  };
  const fixtureProvider = new FixtureEvidenceProvider(fixtureOpts);
  const decorate = opts.evidenceDecorator;
  const evidence: EvidenceProvider = decorate
    ? { mode: "FIXTURE", collect: async (job, reg, nowIso) => decorate(await fixtureProvider.collect(job, reg, nowIso), nowIso) }
    : fixtureProvider;
  const control = createMockControl();
  const facilitator = new ObservedFacilitator(new MockFacilitatorClient(cfg.PAYMENT_NETWORK, control));
  const orders = new Orders({ db, now, entitlement: { maxRefreshes: cfg.ENTITLEMENT_MAX_REFRESHES, windowSeconds: cfg.ENTITLEMENT_WINDOW_SECONDS } });
  const service = new VerifyService({ db, cfg, registry, evidence, signer, orders, now });
  const paywall = createPaywall(cfg, facilitator, orders);
  await paywall.initialize();
  const engine = new CorePlanEngine();
  const plans = new PlansService({ db, cfg, registry, evidence, engine, orders, jobs: service, now });
  const mandates = new MandatesService({ db, cfg, registry, evidence, signer, orders, now });
  const club = new ClubService({ db, cfg, registry, evidence, engine, jobs: service, plans, mandates, orders, now });
  const app = createApp({ cfg, service, paywall, plans, mandates, club, signer, market: opts.market ?? null, health: () => ({}) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    db,
    cfg,
    control,
    orders,
    service,
    paywall,
    plans,
    mandates,
    club,
    signer,
    setNow: (iso) => {
      nowIso = iso;
    },
    setScenario: (sc) => {
      fixtureOpts.scenario = sc;
    },
    cfgNow: () => nowIso,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await close();
    },
  };
}

export async function api(env: TestEnv, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, apiKey = TEST_API_KEY) {
  const res = await fetch(env.url + path, {
    method,
    headers: { "content-type": "application/json", "x-api-key": apiKey, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json: json as Record<string, unknown> & { [k: string]: unknown } };
}

export function jobBody(overrides: Parameters<typeof fixtureJob>[0] = {}) {
  const j = fixtureJob({ ...overrides });
  // fixture 登记表在 EXECUTION_CHAIN_ID=196 下 assetKey 保持不变
  return j;
}

/**
 * 从 402 响应构造 x402 v2 付款凭证（EIP-3009 形态；签名为占位，mock facilitator 只校验绑定字段）。
 * 真实网络下由 Agentic Wallet / x402 client 用私钥签名，本函数不代替那一步。
 */
export function buildPaymentHeader(paymentRequiredHeader: string, payer: string = FIXTURE_OWNER, nonceSeed = "1"): string {
  const pr = decodePaymentRequiredHeader(paymentRequiredHeader);
  const accepted = pr.accepts[0]!;
  const payload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: payer,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${nonceSeed.padStart(64, "0")}`,
      },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

/* ---------------- v2 测试工具（规划 / 授权计划 / Club） ---------------- */

import { privateKeyToAccount } from "viem/accounts";
import { EIP712_TYPES_V2, makePlanGuardDomain, outputSetHash, buildEffectivePolicy, findPolicy, resolveParams, registryHash as computeRegistryHash, type PolicyId, type TradeMandate } from "@chaconne/core/verify";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";

export function planBody(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: `plan-${Math.random().toString(16).slice(2, 10)}`,
    ownerAddress: FIXTURE_OWNER,
    legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }],
    budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "100000000" },
    side: "buy",
    policyId: "STRICT_LIVE",
    policyVersion: "1.1.0",
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: 300,
    deadline: new Date(Date.parse(T_REGULAR) + 3600_000).toISOString(),
    ...overrides,
  };
}

/** 构造并用 owner 私钥签一份 TradeMandate（PlanGuard domain），返回可直接 POST /v1/mandates 的 body */
/** side="sell" 时：链上输入 = 股票代币，输出集 = [资金币种]（V-18）；登记表仍按 inputAssetKey=资金币种 / legs=股票 书写 */
export async function signedMandateBody(env: TestEnv, overrides: { budgetCap?: string; perStepCap?: string; maxSteps?: number; validFrom?: number; deadline?: number; policyId?: string; policyVersion?: string; sku?: string; clientRequestId?: string; nonce?: string; side?: "buy" | "sell" } = {}) {
  const owner = privateKeyToAccount(TEST_OWNER_KEY);
  const reg = env.service.registry;
  const inEntry = reg.entries.find((e) => e.assetKey === FIXTURE_STABLE_KEY)!;
  const outEntry = reg.entries.find((e) => e.assetKey === FIXTURE_STOCK_KEY)!;
  const policyId = (overrides.policyId ?? "STRICT_LIVE") as PolicyId;
  const policyVersion = overrides.policyVersion ?? "1.1.0";
  const def = findPolicy(policyId, policyVersion)!;
  const params = resolveParams(def, { maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: policyId === "QUOTE_ONLY" ? null : 300 });
  if (!params.ok) throw new Error("bad params");
  const policy = buildEffectivePolicy(def, params.params);
  const nowSec = Math.floor(Date.parse(env.cfgNow()) / 1000);
  const mandate: TradeMandate = {
    owner: owner.address.toLowerCase() as `0x${string}`,
    recipient: owner.address.toLowerCase() as `0x${string}`,
    inputToken: overrides.side === "sell" ? outEntry.tokenAddress : inEntry.tokenAddress,
    outputSetHash: outputSetHash(overrides.side === "sell" ? [inEntry.tokenAddress] : [outEntry.tokenAddress]),
    budgetCap: overrides.budgetCap ?? "200000000",
    perStepCap: overrides.perStepCap ?? "100000000",
    maxSteps: String(overrides.maxSteps ?? 2),
    policyDefinitionHash: policy.policyDefinitionHash,
    effectivePolicyHash: policy.effectivePolicyHash,
    registryHash: computeRegistryHash(reg),
    validFrom: String(overrides.validFrom ?? nowSec - 60),
    deadline: String(overrides.deadline ?? nowSec + 86_400),
    nonce: overrides.nonce ?? "1",
  };
  const domain = makePlanGuardDomain(env.cfg.EXECUTION_CHAIN_ID, TEST_PLANGUARD);
  const signature = await owner.signTypedData({
    domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    types: EIP712_TYPES_V2,
    primaryType: "TradeMandate",
    message: { ...mandate, budgetCap: BigInt(mandate.budgetCap), perStepCap: BigInt(mandate.perStepCap), maxSteps: Number(mandate.maxSteps), validFrom: BigInt(mandate.validFrom), deadline: BigInt(mandate.deadline), nonce: BigInt(mandate.nonce) },
  });
  return {
    body: {
      clientRequestId: overrides.clientRequestId ?? `mnd-${Math.random().toString(16).slice(2, 10)}`,
      mandate,
      signature,
      inputAssetKey: FIXTURE_STABLE_KEY,
      legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }],
      side: overrides.side ?? "buy",
      policyId,
      policyVersion,
      maxSlippageBps: 50,
      maxPriceImpactBps: 100,
      maxReferenceDeviationBps: 300,
      sku: overrides.sku ?? "task_bundle",
    },
    mandate,
    owner: owner.address.toLowerCase(),
  };
}
