/** v6 Lane C · C3 调仓编排 portfolio_rebalance：Y-07 多腿、先卖后买、买力重算、部分完成（多腿用 helpers 的 pglite + fixture 证据 + 回执注入） */
import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { FIXTURE_STABLE, FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY, T_REGULAR } from "@chaconne/core/verify/fixtures";
import type { AssetRegistry, TradeMandate } from "@chaconne/core/verify";
import { verifyReceiptsOnce } from "../src/execution/receipts";
import { api, createTestEnv, type TestEnv, type TestEnvOptions } from "./helpers";
import { OWNER, receipt, receiptOpts, registerBuyMandate, signDraft, source, stepLog } from "./v6helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const STOCK2: Hex = "0x3333333333333333333333333333333333333333";
const STOCK2_KEY = `eip155:196:${STOCK2}`;
/** 第二只股票：与 fixture 股票同形（rebasing、18 位），fixture 证据按登记表条目对齐地址 */
const twoStocks = (reg: AssetRegistry): AssetRegistry => {
  const base = reg.entries.find((e) => e.assetKey === FIXTURE_STOCK_KEY)!;
  reg.entries.push({ ...base, assetKey: STOCK2_KEY, tokenAddress: STOCK2, displaySymbol: "FAKE2x", underlyingId: "us-equity:FAKE2" });
  return reg;
};
const PRICES = { [FIXTURE_STOCK_KEY]: "100", [STOCK2_KEY]: "50", [FIXTURE_STABLE_KEY]: "1" };
type Leg = { legIndex: number; side: string; assetKey: string; amountRaw: string; estUsd: string; state: string; mandateId: string | null; draft: { mandate: TradeMandate; typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Hex } }; registerBody: Record<string, unknown> } | null; result: Record<string, unknown> | null };

/**
 * fixture 证据只按「买入形状」对齐地址（src/evidence/provider.ts 不在本 lane 目录）；卖出腿的证据在这里按
 * core `verify.sell.test.ts` 的形状修正：稳定币证据指向稳定币、代币/参考证据指向被卖出的股票、报价按 $250/股反算到 6 位稳定币。
 */
const STOCKS: Record<string, string> = { [FIXTURE_STOCK.toLowerCase()]: "us-equity:FAKE", [STOCK2.toLowerCase()]: "us-equity:FAKE2" };
const sellSideFixup: NonNullable<TestEnvOptions["evidenceDecorator"]> = (c) => {
  const quote = c.evidence.find((e) => e.payload.kind === "okx_quote");
  if (!quote || quote.payload.kind !== "okx_quote") return c;
  const stock = quote.payload.fromToken.toLowerCase();
  if (!(stock in STOCKS)) {
    // 买入形状：fixture 报价的 expectedOut 固定为「100 USDG → 0.4 股」，按本腿金额等比放大（仍 $250/股）
    quote.payload.expectedOutRaw = ((BigInt(quote.payload.amountInRaw) * 10n ** 18n) / 250_000_000n).toString();
    return c;
  }
  quote.payload.expectedOutRaw = ((BigInt(quote.payload.amountInRaw) * 250_000_000n) / 10n ** 18n).toString();
  for (const e of c.evidence) {
    const p = e.payload;
    if (p.kind === "stablecoin_usd") p.tokenAddress = FIXTURE_STABLE;
    if (p.kind === "token_meta") { p.tokenAddress = stock as Hex; p.decimals = 18; }
    if (p.kind === "okx_rwa_token") p.tokenAddress = stock as Hex;
    if (p.kind === "pyth_reference" || p.kind === "ref_close") p.underlyingId = STOCKS[stock]!;
  }
  return c;
};

async function setup(cash = "400000000") {
  const e = await createTestEnv({ now: T_REGULAR, registry: twoStocks, pricesUsd: PRICES, evidenceDecorator: sellSideFixup });
  await registerBuyMandate(e, { clientRequestId: "rel", nonce: "999" }); // 建立 caller↔owner 关系
  e.reader.set(OWNER, FIXTURE_STABLE_KEY, cash);
  e.reader.set(OWNER, FIXTURE_STOCK_KEY, "10000000000000000000"); // 10 FAKEx = $1000
  return e;
}
const body = (extra: Record<string, unknown> = {}) => ({ ownerAddress: OWNER, inputAssetKey: FIXTURE_STABLE_KEY, cashFloorRaw: "100000000", targets: [{ assetKey: FIXTURE_STOCK_KEY, weightBps: 2500 }, { assetKey: STOCK2_KEY, weightBps: 5000 }], ...extra });

async function authorize(e: TestEnv, planId: string, leg: Leg, nonce: string) {
  const signed = await signDraft(e, leg.draft!, nonce);
  const r = await api(e, "POST", `/v1/rebalance/plans/${planId}/legs/${leg.legIndex}/authorize`, { ...signed, clientRequestId: `leg-${planId}-${leg.legIndex}` });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json["mandateId"] as string;
}
async function executeStep(e: TestEnv, mandateId: string, fill: { spent: string; received: string }, ok = true) {
  const prep = await api(e, "POST", `/v1/mandates/${mandateId}/prepare-step`, {});
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const digest = (await api(e, "GET", `/v1/mandates/${mandateId}`)).json["mandateDigest"] as Hex;
  const tx = ("0x" + mandateId.slice(-8).padStart(64, "a")) as Hex;
  await api(e, "POST", `/v1/mandates/${mandateId}/steps/0/submissions`, { txHash: tx });
  const rc = ok ? receipt({ logs: [stepLog(digest, 0, OWNER, fill)] }) : receipt({ status: "reverted" });
  const res = await verifyReceiptsOnce(e.stepReceipts, source(rc), receiptOpts(e));
  expect(res.updated).toBe(1);
}

describe("Y-07 调仓多腿、先卖后买、买力重算、部分完成", () => {
  it("preview：总值 1400、下限 100 → 卖 FAKEx $675（草案齐）、买 FAKE2x $650（等卖出确认后再出草案）；顺序先卖后买；部分完成说明", async () => {
    env = await setup();
    const r = await api(env, "POST", "/v1/rebalance/preview", body());
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const legs = r.json["legs"] as Leg[];
    expect(legs.map((l) => [l.side, l.assetKey, l.estUsd, l.state])).toEqual([
      ["sell", FIXTURE_STOCK_KEY, "675", "READY_TO_AUTHORIZE"],
      ["buy", STOCK2_KEY, "650", "PLANNED"],
    ]);
    expect(legs[0]!.amountRaw).toBe("6750000000000000000");
    const d = legs[0]!.draft!;
    expect(d.mandate).toMatchObject({ inputToken: FIXTURE_STOCK, budgetCap: "6750000000000000000", perStepCap: "6750000000000000000", maxSteps: "1", owner: OWNER });
    expect(d.registerBody).toMatchObject({ side: "sell", inputAssetKey: FIXTURE_STABLE_KEY, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }] });
    expect(legs[1]!.draft).toBeNull();
    const preview = r.json["preview"] as { totalUsd: string; investableUsd: string; partialOutcomes: string[]; buysScaled: boolean };
    expect(preview).toMatchObject({ totalUsd: "1400", investableUsd: "1300", buysScaled: false });
    expect(preview.partialOutcomes.join(" ")).toMatch(/PARTIAL/);
    expect(preview.partialOutcomes.join(" ")).toMatch(/does not promise an atomic/);
    expect((r.json["snapshot"] as { evidence: { payload: { kind: string } } }).evidence.payload.kind).toBe("portfolio_snapshot");
    // 价格来源为静态注入；用户自报价格路径
    expect((r.json["prices"] as { source: string }).source).toBe("static");
    expect((await api(env, "POST", "/v1/rebalance/preview", body({ targets: [{ assetKey: FIXTURE_STOCK_KEY, weightBps: 6000 }, { assetKey: STOCK2_KEY, weightBps: 6000 }] }))).status).toBe(400);
  });

  it("plans：卖出腿授权 → 一步确认 → 用真实现金（比预计少）重算买力 → 买入腿草案缩减 → 授权确认 → COMPLETED", async () => {
    env = await setup();
    const created = await api(env, "POST", "/v1/rebalance/plans", body({ clientRequestId: "rb-1" }));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const planId = created.json["planId"] as string;
    expect(created.json).toMatchObject({ state: "DRAFT", phase: "selling" });
    expect((await api(env, "POST", "/v1/rebalance/plans", body({ clientRequestId: "rb-1" }))).status).toBe(200); // 幂等
    let legs = created.json["legs"] as Leg[];
    // 买入腿此时不能授权
    expect((await api(env, "POST", `/v1/rebalance/plans/${planId}/legs/1/authorize`, { mandate: {} })).status).toBe(409);
    // 卖出腿：签草案 → 登记 → ACTIVE
    const sellMandate = await authorize(env, planId, legs[0]!, "7001");
    let v = await api(env, "GET", `/v1/rebalance/plans/${planId}`);
    expect(v.json["state"]).toBe("ACTIVE");
    legs = v.json["legs"] as Leg[];
    expect(legs[0]).toMatchObject({ state: "AUTHORIZED", mandateId: sellMandate, mandateState: "ACTIVE", mandateSide: "sell" });
    // 卖出成交：卖 6.75 FAKEx 收 670 USDG（预计现金 1075 → 买力 975 ≥ 650）；但外部转走一部分 → 真实现金 500 → 买力 400 < 650 → 缩减
    await executeStep(env, sellMandate, { spent: "6750000000000000000", received: "670000000" });
    env.reader.set(OWNER, FIXTURE_STABLE_KEY, "500000000");
    v = await api(env, "GET", `/v1/rebalance/plans/${planId}`);
    expect(v.json["phase"]).toBe("buying");
    legs = v.json["legs"] as Leg[];
    expect(legs[0]).toMatchObject({ state: "CONFIRMED", result: { spentRaw: "6750000000000000000", receivedRaw: "670000000" } });
    expect(legs[1]).toMatchObject({ state: "READY_TO_AUTHORIZE", amountRaw: "400000000", estUsd: "400" });
    expect((legs[1]!.result as { buyingPower: { cashBalanceRaw: string; scaled: boolean } }).buyingPower).toMatchObject({ cashBalanceRaw: "500000000", scaled: true });
    expect(legs[1]!.draft!.mandate).toMatchObject({ inputToken: FIXTURE_STABLE, budgetCap: "400000000", maxSteps: "1" });
    // 买入腿授权 → 确认 → COMPLETED
    const buyMandate = await authorize(env, planId, legs[1]!, "7002");
    await executeStep(env, buyMandate, { spent: "400000000", received: "8000000000000000000" });
    v = await api(env, "GET", `/v1/rebalance/plans/${planId}`);
    expect(v.json).toMatchObject({ state: "COMPLETED", phase: "done", partial: null });
    expect((v.json["legs"] as Leg[]).map((l) => l.state)).toEqual(["CONFIRMED", "CONFIRMED"]);
    // 组合：两笔可追溯成交都进成本（卖出冲减 / 买入累加）
    const port = await api(env, "GET", `/v1/portfolio/${OWNER}`);
    const h2 = (port.json["holdings"] as Array<{ assetKey: string; traced: { qtyRaw: string; costRaw: string } }>).find((h) => h.assetKey === STOCK2_KEY)!;
    expect(h2.traced).toMatchObject({ qtyRaw: "8000000000000000000", costRaw: "400000000" });
  });

  it("任一腿失败 → PARTIAL：卖出腿链上 revert，买入腿仍按真实现金出草案，不承诺原子回到目标", async () => {
    env = await setup("800000000");
    const created = await api(env, "POST", "/v1/rebalance/plans", body({ clientRequestId: "rb-2" }));
    const planId = created.json["planId"] as string;
    const legs = created.json["legs"] as Leg[];
    const sellMandate = await authorize(env, planId, legs[0]!, "7003");
    await executeStep(env, sellMandate, { spent: "0", received: "0" }, false);
    const v = await api(env, "GET", `/v1/rebalance/plans/${planId}`);
    expect(v.json).toMatchObject({ state: "PARTIAL", phase: "buying" });
    expect(v.json["partial"]).toMatchObject({ failedLegs: [0] });
    expect(String((v.json["partial"] as { note: string }).note)).toMatch(/does not return to the target atomically/);
    const after = v.json["legs"] as Leg[];
    expect(after[0]).toMatchObject({ state: "FAILED", result: { reason: "step_reverted" } });
    // 本计划建在现金 800 上：总值 1800、可投 1700 → 买 FAKE2x 预估 850；卖出失败后真实现金仍 800 − 下限 100 = 700 < 850 → 缩到 700（不拿卖出预估收入）
    expect((created.json["legs"] as Leg[])[1]!.estUsd).toBe("850");
    expect(after[1]).toMatchObject({ state: "READY_TO_AUTHORIZE", amountRaw: "700000000", estUsd: "700" });
    expect((after[1]!.result as { buyingPower: { scaled: boolean; cashBalanceRaw: string } }).buyingPower).toMatchObject({ scaled: true, cashBalanceRaw: "800000000" });
    // 没有可买力 → 买入腿 SKIPPED，计划仍 PARTIAL
    env = await (async () => { await env!.close(); return setup("50000000"); })();
    const c2 = await api(env, "POST", "/v1/rebalance/plans", body({ clientRequestId: "rb-3" }));
    const p2 = c2.json["planId"] as string;
    const m2 = await authorize(env, p2, (c2.json["legs"] as Leg[])[0]!, "7004");
    await executeStep(env, m2, { spent: "0", received: "0" }, false);
    const v2 = await api(env, "GET", `/v1/rebalance/plans/${p2}`);
    expect((v2.json["legs"] as Leg[]).map((l) => l.state)).toEqual(["FAILED", "SKIPPED"]);
    expect(v2.json).toMatchObject({ state: "PARTIAL", phase: "done" });
  });
});
