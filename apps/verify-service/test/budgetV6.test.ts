/** v6 Lane C · C8 资金组（D-086）：B-01～B-07 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { verifyBudgetLedger, verifyMandates, verifyNotificationOutbox } from "@chaconne/db";
import { T_REGULAR } from "@chaconne/core/verify/fixtures";
import { FIXTURE_STABLE_KEY } from "@chaconne/core/verify/fixtures";
import { verifyReceiptsOnce } from "../src/execution/receipts";
import { api, createTestEnv, OTHER_API_KEY, type TestEnv } from "./helpers";
import { OWNER, receipt, receiptOpts, registerBuyMandate, source, stepLog } from "./v6helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const PERIOD = { periodStart: "2026-09-14T00:00:00.000Z", periodEnd: "2026-09-21T00:00:00.000Z" };
async function group(e: TestEnv, capRaw = "200000000", extra: Record<string, unknown> = {}) {
  const r = await api(e, "POST", "/v1/budget-groups", { ownerAddress: OWNER, name: "week", inputAssetKey: FIXTURE_STABLE_KEY, ...PERIOD, capRaw, cashFloorRaw: "100000000", ...extra });
  expect(r.status).toBe(201);
  return (r.json["group"] as { id: string }).id;
}

describe("B-01 两任务并发注册只一个取得预留", () => {
  it("cap 200：两份 150 授权并发分配 → 恰一个 reserved、一个 waiting(BUDGET_GROUP_CONFLICT)，budget.conflict 入队一次", async () => {
    env = await createTestEnv();
    const m1 = await registerBuyMandate(env, { clientRequestId: "b01-1", nonce: "11", budgetCap: "150000000", perStepCap: "150000000", maxSteps: 1 });
    const m2 = await registerBuyMandate(env, { clientRequestId: "b01-2", nonce: "12", budgetCap: "150000000", perStepCap: "150000000", maxSteps: 1 });
    const gid = await group(env);
    const [a, b] = await Promise.all([
      api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "task-1", mandateId: m1.id, priority: 1 }),
      api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "task-2", mandateId: m2.id, priority: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(winner.json["state"]).toBe("reserved");
    expect(winner.json["reservedRaw"]).toBe("150000000");
    expect(loser.json).toMatchObject({ state: "waiting", reservedRaw: "0", reasonCode: "BUDGET_GROUP_CONFLICT" });
    const v = await api(env, "GET", `/v1/budget-groups/${gid}`);
    expect(v.json["summary"]).toMatchObject({ capRaw: "200000000", spentRaw: "0", reservedRaw: "150000000", schedulableRaw: "50000000" });
    expect((v.json["invariant"] as { ok: boolean }).ok).toBe(true);
    const conflicts = await env.db.select().from(verifyNotificationOutbox).where(eq(verifyNotificationOutbox.type, "budget.conflict"));
    expect(conflicts).toHaveLength(1);
    // 同一授权重复注册 → 幂等返回同一分配（状态不变）
    const first = a.json["allocationId"] as string;
    const again = await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "task-1", mandateId: m1.id, priority: 1 });
    expect(again.status).toBe(a.status);
    expect(again.json["allocationId"]).toBe(first);
  });

  it("owner 鉴权：别的调用方看不到组；跨周期授权不指定归属周期 → 400", async () => {
    env = await createTestEnv();
    const m = await registerBuyMandate(env, { clientRequestId: "b01-3", nonce: "13", deadline: Math.floor(Date.parse("2026-09-25T00:00:00Z") / 1000) });
    const gid = await group(env);
    expect((await api(env, "GET", `/v1/budget-groups/${gid}`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
    const r = await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t", mandateId: m.id });
    expect(r.status).toBe(400);
    expect(r.json["error"]).toBe("period_attribution_required");
    const ok = await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t", mandateId: m.id, attributedPeriod: PERIOD });
    expect(ok.status).toBe(201);
  });
});

describe("B-02 不变量在每次分配/结算后成立", () => {
  it("回执 CONFRIMED → spent += actual、reserved −= actual；流水每行 invariantOk；卖出授权不占预算", async () => {
    env = await createTestEnv();
    const m = await registerBuyMandate(env, { clientRequestId: "b02", nonce: "21", budgetCap: "200000000", perStepCap: "100000000", maxSteps: 2 });
    const gid = await group(env, "250000000");
    const alloc = await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t", mandateId: m.id });
    expect(alloc.status).toBe(201);
    // 步骤 0：拉证书 → 在途；回执确认 → 结算
    await api(env, "POST", `/v1/mandates/${m.id}/prepare-step`, {});
    await env.budget.coordinator.markPending(m.id, 0, "100000000");
    await api(env, "POST", `/v1/mandates/${m.id}/steps/0/submissions`, { txHash: "0x" + "ef".repeat(32) });
    await verifyReceiptsOnce(env.stepReceipts, source(receipt({ logs: [stepLog(m.digest, 0, OWNER, { spent: "100000000", received: "400000000000000000000" })] })), receiptOpts(env));
    const v = await api(env, "GET", `/v1/budget-groups/${gid}`);
    expect(v.json["summary"]).toMatchObject({ spentRaw: "100000000", reservedRaw: "100000000", pendingRaw: "0", schedulableRaw: "50000000" });
    const a = (v.json["allocations"] as Array<Record<string, unknown>>)[0]!;
    expect(a).toMatchObject({ spentRaw: "100000000", reservedRaw: "100000000", state: "reserved" });
    // 链上额度与服务额度分别展示（B-07）
    expect(a["onchain"]).toMatchObject({ budgetCapRaw: "200000000", spentRaw: "100000000", remainingRaw: "100000000" });
    const ledger = await env.db.select().from(verifyBudgetLedger).where(eq(verifyBudgetLedger.groupId, gid));
    expect(ledger.map((l) => l.kind)).toEqual(["reserve", "pending", "settle"]);
    expect(ledger.every((l) => l.invariantOk)).toBe(true);
    // 同一步重复回执不重复记账
    const again = await env.budget.coordinator.settle(m.id, 0, "100000000", { txHash: null });
    expect(again?.applied).toBe(false);
    // 卖出授权不占预算
    const sell = await registerBuyMandate(env, { clientRequestId: "b02-sell", nonce: "22", side: "sell" });
    const rs = await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t2", mandateId: sell.id });
    expect(rs.status).toBe(400);
    expect(rs.json["error"]).toBe("sell_mandate_not_budgeted");
  });
});

describe("B-03 在途不提前释放 / B-04 链上撤销确认后才释放", () => {
  it("pending > 0 → release 拒绝；服务侧 CANCELLED 不释放；DB 记 REVOKED（链上确认）→ 释放并让 waiting 取得预留", async () => {
    env = await createTestEnv();
    const m1 = await registerBuyMandate(env, { clientRequestId: "b03-1", nonce: "31", budgetCap: "150000000", perStepCap: "150000000", maxSteps: 1 });
    const m2 = await registerBuyMandate(env, { clientRequestId: "b03-2", nonce: "32", budgetCap: "100000000", perStepCap: "100000000", maxSteps: 1 });
    const gid = await group(env);
    expect((await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t1", mandateId: m1.id, priority: 1 })).status).toBe(201);
    expect((await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t2", mandateId: m2.id, priority: 2 })).status).toBe(409);
    await env.budget.coordinator.markPending(m1.id, 0, "150000000");
    const refused = await env.budget.coordinator.release(m1.id, "revoked");
    expect(refused).toMatchObject({ released: false, refusedReason: "pending_in_flight" });
    // 服务侧取消：只是停止签发（D-088），不释放
    await api(env, "POST", `/v1/mandates/${m1.id}/cancel`, {});
    await env.budget.coordinator.unpend(m1.id, 0, "150000000", "expired");
    let v = await api(env, "GET", `/v1/budget-groups/${gid}`);
    expect(v.json["summary"]).toMatchObject({ reservedRaw: "150000000" });
    expect((v.json["allocations"] as Array<{ mandateId: string; state: string }>).find((a) => a.mandateId === m2.id)!.state).toBe("waiting");
    // 链上撤销确认（由任务层在 revokeMandate 回执后写 REVOKED）
    await env.db.update(verifyMandates).set({ state: "REVOKED" }).where(eq(verifyMandates.id, m1.id));
    v = await api(env, "GET", `/v1/budget-groups/${gid}`);
    const allocs = v.json["allocations"] as Array<{ mandateId: string; state: string; reservedRaw: string; releaseReason: string | null }>;
    expect(allocs.find((a) => a.mandateId === m1.id)).toMatchObject({ state: "released", reservedRaw: "0", releaseReason: "revoked" });
    expect(allocs.find((a) => a.mandateId === m2.id)).toMatchObject({ state: "reserved", reservedRaw: "100000000" });
    expect(v.json["summary"]).toMatchObject({ reservedRaw: "100000000", schedulableRaw: "100000000" });
    const released = await env.db.select().from(verifyNotificationOutbox).where(eq(verifyNotificationOutbox.type, "budget.released"));
    expect(released).toHaveLength(1);
  });

  it("已成交支出在释放后保留（周期内不恢复）", async () => {
    env = await createTestEnv();
    const m = await registerBuyMandate(env, { clientRequestId: "b04", nonce: "41", budgetCap: "200000000", perStepCap: "100000000", maxSteps: 2 });
    const gid = await group(env, "300000000");
    await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t", mandateId: m.id });
    await api(env, "POST", `/v1/mandates/${m.id}/prepare-step`, {});
    await api(env, "POST", `/v1/mandates/${m.id}/steps/0/submissions`, { txHash: "0x" + "ee".repeat(32) });
    await verifyReceiptsOnce(env.stepReceipts, source(receipt({ logs: [stepLog(m.digest, 0, OWNER)] })), receiptOpts(env));
    await env.db.update(verifyMandates).set({ state: "EXPIRED" }).where(eq(verifyMandates.id, m.id));
    const v = await api(env, "GET", `/v1/budget-groups/${gid}`);
    expect(v.json["summary"]).toMatchObject({ spentRaw: "100000000", reservedRaw: "0", schedulableRaw: "200000000" });
  });
});

describe("B-05 现金下限用链上余额 / B-06 外部余额下降阻止无资金执行", () => {
  it("余额 150、下限 100：花 50 通过，花 51 → CASH_FLOOR_BLOCK；外部转走后同一笔被拦下并带区块号", async () => {
    env = await createTestEnv({ now: T_REGULAR });
    env.reader.set(OWNER, FIXTURE_STABLE_KEY, "150000000");
    const ok = await env.budget.coordinator.checkCashFloor({ owner: OWNER, inputAssetKey: FIXTURE_STABLE_KEY, cashFloorRaw: "100000000", amountRaw: "50000000" });
    expect(ok).toMatchObject({ ok: true, reasonCode: null, balanceRaw: "150000000" });
    const no = await env.budget.coordinator.checkCashFloor({ owner: OWNER, inputAssetKey: FIXTURE_STABLE_KEY, cashFloorRaw: "100000000", amountRaw: "50000001" });
    expect(no).toMatchObject({ ok: false, reasonCode: "CASH_FLOOR_BLOCK", shortfallRaw: "1" });
    // B-06：服务侧预留仍在，但外部把余额转走了 → 用真实余额判定，不看预留
    const m = await registerBuyMandate(env, { clientRequestId: "b06", nonce: "61", budgetCap: "50000000", perStepCap: "50000000", maxSteps: 1 });
    const gid = await group(env);
    expect((await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t", mandateId: m.id })).status).toBe(201);
    env.reader.set(OWNER, FIXTURE_STABLE_KEY, "40000000");
    const blocked = await env.budget.coordinator.checkCashFloor({ owner: OWNER, inputAssetKey: FIXTURE_STABLE_KEY, cashFloorRaw: "100000000", amountRaw: "50000000" });
    expect(blocked).toMatchObject({ ok: false, reasonCode: "CASH_FLOOR_BLOCK", balanceRaw: "40000000", shortfallRaw: "110000000" });
    expect(Number(blocked.blockNumber)).toBeGreaterThan(0);
  });
});

describe("B-07 服务额度与链上额度分别展示", () => {
  it("组合视图 authorizations[].onchain 与 .service 分列；资金组视图带 coordinationScope", async () => {
    env = await createTestEnv();
    const m = await registerBuyMandate(env, { clientRequestId: "b07", nonce: "71", budgetCap: "120000000", perStepCap: "60000000", maxSteps: 2 });
    const gid = await group(env);
    await api(env, "POST", `/v1/budget-groups/${gid}/allocations`, { taskId: "t", mandateId: m.id, amountRaw: "100000000" });
    const p = await api(env, "GET", `/v1/portfolio/${OWNER}`);
    expect(p.status).toBe(200);
    const auth = (p.json["authorizations"] as Array<Record<string, unknown>>).find((a) => a["mandateId"] === m.id)!;
    expect(auth["onchain"]).toMatchObject({ budgetCapRaw: "120000000", spentRaw: "0", remainingRaw: "120000000" });
    expect(auth["service"]).toMatchObject({ groupId: gid, state: "reserved", reservedRaw: "100000000", requestedRaw: "100000000" });
    expect((p.json["budgetGroups"] as Array<{ groupId: string }>)[0]!.groupId).toBe(gid);
    const g = await api(env, "GET", `/v1/budget-groups/${gid}`);
    expect(String(g.json["coordinationScope"])).toMatch(/not on-chain freezes/);
  });
});
