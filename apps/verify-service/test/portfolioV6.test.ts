/** v6 Lane C · C4 组合：Q-01～Q-04 */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY, T_REGULAR } from "@chaconne/core/verify/fixtures";
import { verifyReceiptsOnce } from "../src/execution/receipts";
import { api, createTestEnv, OTHER_API_KEY, type TestEnv } from "./helpers";
import { OWNER, receipt, receiptOpts, registerBuyMandate, source, stepLog } from "./v6helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

type Holding = { assetKey: string; balanceRaw: string; coverage: { coverageBps: number | null; unknownQtyRaw: string; externalOutflowRaw: string; note: string }; traced: { qtyRaw: string; costRaw: string; ratio: { note: string; ratioNow: string | null } }; userReported: { source: string; qtyRaw: string; costRaw: string } | null };

/** 买入一步并链上确认：received 0.4e18 FAKEx，spent 100 USDG */
async function confirmedBuy(e: TestEnv, id: string, nonce: string) {
  const m = await registerBuyMandate(e, { clientRequestId: id, nonce, budgetCap: "100000000", perStepCap: "100000000", maxSteps: 1 });
  await api(e, "POST", `/v1/mandates/${m.id}/prepare-step`, {});
  await api(e, "POST", `/v1/mandates/${m.id}/steps/0/submissions`, { txHash: "0x" + "ef".repeat(32) });
  await verifyReceiptsOnce(e.stepReceipts, source(receipt({ logs: [stepLog(m.digest, 0, OWNER, { spent: "100000000", received: "400000000000000000" })] })), receiptOpts(e));
  return m;
}

describe("Q-01 余额与区块号", () => {
  it("快照钉在同一区块；现金与持仓分开；portfolio_snapshot 证据带 blockNumber；owner 鉴权 403", async () => {
    env = await createTestEnv({ now: T_REGULAR });
    await registerBuyMandate(env, { clientRequestId: "q01", nonce: "101" });
    env.reader.set(OWNER, FIXTURE_STABLE_KEY, "123000000");
    env.reader.set(OWNER, FIXTURE_STOCK_KEY, "1000000000000000000");
    const r = await api(env, "GET", `/v1/portfolio/${OWNER}`);
    expect(r.status).toBe(200);
    expect(r.json["owner"]).toBe(OWNER);
    const block = r.json["block"] as { number: string; hash: string };
    expect(Number(block.number)).toBeGreaterThan(0);
    expect((r.json["cash"] as Array<{ assetKey: string; balanceRaw: string }>)[0]).toMatchObject({ assetKey: FIXTURE_STABLE_KEY, balanceRaw: "123000000" });
    const h = (r.json["holdings"] as Holding[])[0]!;
    expect(h).toMatchObject({ assetKey: FIXTURE_STOCK_KEY, balanceRaw: "1000000000000000000" });
    const ev = r.json["evidence"] as { payload: { kind: string; blockNumber: number; holdings: Array<{ tracedQtyRaw: string | null }> }; block: { blockNumber: string } };
    expect(ev.payload.kind).toBe("portfolio_snapshot");
    expect(ev.payload.blockNumber).toBe(Number(block.number));
    expect(ev.block.blockNumber).toBe(block.number);
    expect(ev.payload.holdings[0]!.tracedQtyRaw).toBe("0");
    expect((await api(env, "GET", `/v1/portfolio/${OWNER}`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
    expect((await api(env, "GET", `/v1/portfolio/not-an-address`)).status).toBe(400);
  });
});

describe("Q-02 成本覆盖率与未知部分", () => {
  it("平台成交 0.4 / 余额 1.0 → 40%，未知 0.6（外部转入）；余额降到 0.3 → 外部转出 0.1 明示", async () => {
    env = await createTestEnv({ now: T_REGULAR });
    await confirmedBuy(env, "q02", "102");
    env.reader.set(OWNER, FIXTURE_STOCK_KEY, "1000000000000000000");
    let h = ((await api(env, "GET", `/v1/portfolio/${OWNER}`)).json["holdings"] as Holding[])[0]!;
    expect(h.traced).toMatchObject({ qtyRaw: "400000000000000000", costRaw: "100000000" });
    expect(h.coverage).toMatchObject({ coverageBps: 4000, unknownQtyRaw: "600000000000000000", externalOutflowRaw: "0", note: "cost_unknown_for_part_of_balance" });
    env.reader.set(OWNER, FIXTURE_STOCK_KEY, "300000000000000000");
    h = ((await api(env, "GET", `/v1/portfolio/${OWNER}`)).json["holdings"] as Holding[])[0]!;
    expect(h.coverage).toMatchObject({ coverageBps: 10_000, unknownQtyRaw: "0", externalOutflowRaw: "100000000000000000", note: "fully_traced" });
    const notes = (await api(env, "GET", `/v1/portfolio/${OWNER}`)).json["notes"] as { cost: string };
    expect(notes.cost).toMatch(/never spread over the whole wallet/);
  });
});

describe("Q-03 自报成本标记", () => {
  it("POST cost-overrides → 201 source=user_reported；组合里单列，不进 coverage", async () => {
    env = await createTestEnv({ now: T_REGULAR });
    await registerBuyMandate(env, { clientRequestId: "q03", nonce: "103" });
    env.reader.set(OWNER, FIXTURE_STOCK_KEY, "1000000000000000000");
    const bad = await api(env, "POST", `/v1/portfolio/${OWNER}/cost-overrides`, { assetKey: FIXTURE_STOCK_KEY, qtyRaw: "x" });
    expect(bad.status).toBe(400);
    const r = await api(env, "POST", `/v1/portfolio/${OWNER}/cost-overrides`, { assetKey: FIXTURE_STOCK_KEY, qtyRaw: "600000000000000000", costRaw: "150000000", inputAssetKey: FIXTURE_STABLE_KEY, note: "bought elsewhere" });
    expect(r.status).toBe(201);
    expect((r.json["override"] as { source: string }).source).toBe("user_reported");
    const h = ((await api(env, "GET", `/v1/portfolio/${OWNER}`)).json["holdings"] as Holding[])[0]!;
    expect(h.userReported).toMatchObject({ source: "user_reported", qtyRaw: "600000000000000000", costRaw: "150000000" });
    expect(h.coverage.coverageBps).toBe(0); // 自报不算可追溯
    expect(h.traced.qtyRaw).toBe("0");
    expect((await api(env, "POST", `/v1/portfolio/${OWNER}/cost-overrides`, { assetKey: FIXTURE_STOCK_KEY, qtyRaw: "1", costRaw: "1", inputAssetKey: FIXTURE_STABLE_KEY }, {}, OTHER_API_KEY)).status).toBe(403);
  });
});

describe("Q-04 乘数调整换算标注", () => {
  it("成交时乘数 1.000000、现在 1.003269 → 可追溯量按比例换算并标 adjusted；无成交时乘数 → ratio_unknown", async () => {
    env = await createTestEnv({
      now: T_REGULAR,
      evidenceDecorator: (c) => {
        for (const e of c.evidence) if (e.payload.kind === "token_meta") e.payload.multiplier = "1.000000";
        return c;
      },
    });
    await confirmedBuy(env, "q04", "104");
    env.reader.multipliers.set(FIXTURE_STOCK_KEY.toLowerCase(), "1.003269");
    env.reader.set(OWNER, FIXTURE_STOCK_KEY, "401307600000000000");
    const h = ((await api(env, "GET", `/v1/portfolio/${OWNER}`)).json["holdings"] as Holding[])[0]!;
    expect(h.traced.qtyRaw).toBe("401307600000000000");
    expect(h.traced.ratio).toMatchObject({ note: "adjusted", ratioNow: "1.003269" });
    expect(h.coverage.coverageBps).toBe(10_000);
    // 快照没有乘数 → 不换算、明确 ratio_unknown
    env.reader.multipliers.delete(FIXTURE_STOCK_KEY.toLowerCase());
    const h2 = ((await api(env, "GET", `/v1/portfolio/${OWNER}`)).json["holdings"] as Holding[])[0]!;
    expect(h2.traced.qtyRaw).toBe("400000000000000000");
    expect(h2.traced.ratio.note).toBe("ratio_unknown");
  });
});
