/** v6 Lane C · core 纯函数：资金组不变量（B-02）、成本覆盖（Q-02/Q-04）、调仓（Y-07）、在线态（Q-08）、通知键（Q-05） */
import { describe, expect, it } from "vitest";
import type { BudgetAllocation, BudgetGroup } from "../src/verify/contracts";
import { adjustForRatio, aggregateFills, buildNotificationPayload, canRelease, cashFloorCheck, costCoverage, executorPresence, forbiddenKeysIn, invariantHolds, markPending, notificationKey, orderByPriority, planRebalance, reassignWaiting, recomputeBuys, release, requiresPeriodAttribution, settle, summarize, tryReserve } from "../src/verify/budget";

const group: BudgetGroup = { id: "bgp_1", owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "week", inputAssetKey: "eip155:196:0x1111111111111111111111111111111111111111", periodStart: "2026-09-21T00:00:00.000Z", periodEnd: "2026-09-28T00:00:00.000Z", capRaw: "500000000", cashFloorRaw: "100000000", priorityRule: "priority_then_created" };
const alloc = (o: Partial<BudgetAllocation> & { mandateId: string }): BudgetAllocation => ({ groupId: group.id, taskId: `t_${o.mandateId}`, priority: 1, reservedRaw: "0", spentRaw: "0", pendingRaw: "0", state: "reserved", ...o });

describe("B-02 资金组不变量 spent + Σ reserved ≤ cap（pending 不重复计）", () => {
  it("预留全额或 0；超出可安排额度 → 0", () => {
    const a = alloc({ mandateId: "m1", reservedRaw: "300000000" });
    expect(tryReserve(group, [a], "200000000")).toEqual({ granted: true, reservedRaw: "200000000", schedulableRaw: "0" });
    expect(tryReserve(group, [a], "200000001").granted).toBe(false);
    expect(tryReserve(group, [a], "0").granted).toBe(false);
  });
  it("结算：spent += actual，reserved −= actual，pending −= actual；不变量成立；pending ≤ reserved", () => {
    let a = alloc({ mandateId: "m1", reservedRaw: "300000000" });
    a = markPending(a, "100000000");
    expect(a.pendingRaw).toBe("100000000");
    expect(summarize(group, [a]).pendingRaw).toBe("100000000");
    expect(summarize(group, [a]).reservedRaw).toBe("300000000"); // pending 计入 reserved 内，不重复
    expect(invariantHolds(group, [a]).ok).toBe(true);
    a = settle(a, "100000000");
    expect(a).toMatchObject({ spentRaw: "100000000", reservedRaw: "200000000", pendingRaw: "0", state: "reserved" });
    expect(invariantHolds(group, [a])).toEqual({ ok: true, lhsRaw: "300000000", capRaw: "500000000" });
    a = settle(a, "200000000");
    expect(a.state).toBe("settled");
    // pending 超过 reserved 会被夹住
    expect(markPending(alloc({ mandateId: "m2", reservedRaw: "10" }), "20").pendingRaw).toBe("10");
  });
  it("释放只放未花出的预留，已成交支出保留；在途 > 0 不能释放（B-03）", () => {
    const a = settle(markPending(alloc({ mandateId: "m1", reservedRaw: "300000000" }), "300000000"), "100000000");
    expect(canRelease(a)).toBe(false);
    const r = release(a);
    expect(r).toMatchObject({ reservedRaw: "0", pendingRaw: "0", spentRaw: "100000000", state: "released" });
    expect(summarize(group, [r]).spentRaw).toBe("100000000");
    expect(summarize(group, [r]).schedulableRaw).toBe("400000000");
  });
  it("priority → createdAt 顺序；释放后 waiting 依次取得预留（放不下的不阻塞后面更小的）", () => {
    const xs = [
      { priority: 2, createdAt: "2026-09-21T01:00:00Z", id: "c" },
      { priority: 1, createdAt: "2026-09-21T02:00:00Z", id: "b" },
      { priority: 1, createdAt: "2026-09-21T01:00:00Z", id: "a" },
    ];
    expect(orderByPriority(xs).map((x) => x.id)).toEqual(["a", "b", "c"]);
    const w = (mandateId: string, priority: number, requestedRaw: string, createdAt: string) => ({ ...alloc({ mandateId, priority, state: "waiting" }), requestedRaw, createdAt });
    const reserved = { ...alloc({ mandateId: "m0", reservedRaw: "300000000" }), requestedRaw: "300000000", createdAt: "2026-09-21T00:00:00Z" };
    const { promoted } = reassignWaiting(group, [reserved, w("big", 1, "250000000", "2026-09-21T01:00:00Z"), w("small", 2, "150000000", "2026-09-21T02:00:00Z"), w("tiny", 3, "100000000", "2026-09-21T03:00:00Z")]);
    expect(promoted.map((p) => p.mandateId)).toEqual(["small"]);
    expect(promoted[0]!.state).toBe("reserved");
    expect(promoted[0]!.reservedRaw).toBe("150000000");
  });
  it("B-05 现金下限用真实余额；跨周期授权须指定归属周期", () => {
    expect(cashFloorCheck("150000000", "100000000", "50000000").ok).toBe(true);
    expect(cashFloorCheck("149999999", "100000000", "50000000")).toMatchObject({ ok: false, shortfallRaw: "1" });
    expect(requiresPeriodAttribution(group, "2026-09-27T00:00:00.000Z")).toBe(false);
    expect(requiresPeriodAttribution(group, "2026-09-29T00:00:00.000Z")).toBe(true);
    expect(requiresPeriodAttribution(group, "2026-09-27T00:00:00.000Z", "2026-09-20T00:00:00.000Z")).toBe(true);
  });
});

describe("Q-02 / Q-04 成本覆盖率与乘数换算", () => {
  it("覆盖率 = traced/balance；外部转入 → unknown；外部转出 → externalOutflow", () => {
    expect(costCoverage("1000", "600")).toMatchObject({ coverageBps: 6000, unknownQtyRaw: "400", externalOutflowRaw: "0" });
    expect(costCoverage("1000", "1200")).toMatchObject({ coverageBps: 10_000, unknownQtyRaw: "0", externalOutflowRaw: "200" });
    expect(costCoverage("0", "5").coverageBps).toBeNull();
  });
  it("乘数变化按 ratioNow/ratioAtFill 换算并标注；缺任一乘数 → null", () => {
    expect(adjustForRatio("1000000", "1.000000", "1.003269")).toMatchObject({ adjustedQtyRaw: "1003269", changed: true });
    expect(adjustForRatio("1000000", "1.5", "1.5")!.changed).toBe(false);
    expect(adjustForRatio("1000000", null, "1.5")).toBeNull();
  });
  it("成交序列：买入累加，卖出按平均成本冲减，卖超只减到 0", () => {
    expect(aggregateFills([{ side: "buy", qtyRaw: "100", inputRaw: "1000" }, { side: "buy", qtyRaw: "100", inputRaw: "3000" }, { side: "sell", qtyRaw: "50", inputRaw: "1200" }])).toEqual({ tracedQtyRaw: "150", costRaw: "3000" });
    expect(aggregateFills([{ side: "buy", qtyRaw: "100", inputRaw: "1000" }, { side: "sell", qtyRaw: "500", inputRaw: "9" }])).toEqual({ tracedQtyRaw: "0", costRaw: "0" });
  });
});

describe("Y-07 调仓编排：先卖后买、买力重算、部分完成说明", () => {
  const holdings = [
    { assetKey: "A", balanceRaw: "10000000000000000000", decimals: 18, priceUsd: "100", costCoverageBps: 10_000 }, // 10 × $100 = $1000
    { assetKey: "B", balanceRaw: "2000000000000000000", decimals: 18, priceUsd: "50", costCoverageBps: 5000 }, // 2 × $50 = $100
    { assetKey: "X", balanceRaw: "1", decimals: 18, priceUsd: null, costCoverageBps: null },
  ];
  const cash = { assetKey: "USD", balanceRaw: "400000000", decimals: 6 }; // $400
  it("总值 1500，下限 100 → 可投 1400；A 目标 25%=350 卖 650；B 目标 50%=700 买 600；卖出腿在前", () => {
    const p = planRebalance({ holdings, cash, cashFloorRaw: "100000000", targets: [{ assetKey: "A", weightBps: 2500 }, { assetKey: "B", weightBps: 5000 }] });
    expect(p.totalUsd).toBe("1500");
    expect(p.investableUsd).toBe("1400");
    expect(p.unknownPriceAssets).toEqual(["X"]);
    expect(p.legs.map((l) => [l.side, l.assetKey, l.estUsd])).toEqual([["sell", "A", "650"], ["buy", "B", "600"]]);
    expect(p.legs[0]!.amountRaw).toBe("6500000000000000000");
    expect(p.legs[1]!.amountRaw).toBe("600000000");
    expect(p.buysScaled).toBe(false);
    expect(p.partialOutcomes.some((s) => /PARTIAL/.test(s))).toBe(true);
    expect(p.partialOutcomes.some((s) => /atomic/.test(s))).toBe(true);
  });
  it("目标不含 A → 全卖；买入超过预计现金 → 等比缩减并保住下限", () => {
    const p = planRebalance({ holdings: holdings.slice(0, 2), cash: { ...cash, balanceRaw: "0" }, cashFloorRaw: "1000000000", targets: [{ assetKey: "B", weightBps: 10_000 }] });
    // 总值 1100，下限 1000 → 可投 100；A 目标 0 → 卖 1000（全额）；B 目标 100 → 当前 100 → 不买
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]).toMatchObject({ side: "sell", assetKey: "A", amountRaw: holdings[0]!.balanceRaw });
    const q = planRebalance({ holdings: holdings.slice(0, 2), cash: { ...cash, balanceRaw: "0" }, cashFloorRaw: "0", targets: [{ assetKey: "B", weightBps: 10_000 }] });
    expect(q.legs.map((l) => l.side)).toEqual(["sell", "buy"]);
    expect(q.legs[1]!.estUsd).toBe("1000");
  });
  it("recomputeBuys：真实现金不足时按原预估等比缩减", () => {
    const r = recomputeBuys([{ legIndex: 1, estUsd: "600" }, { legIndex: 2, estUsd: "200" }], "500000000", 6, "100000000");
    expect(r).toEqual([
      { legIndex: 1, amountRaw: "300000000", estUsd: "300", scaled: true },
      { legIndex: 2, amountRaw: "100000000", estUsd: "100", scaled: true },
    ]);
    expect(recomputeBuys([{ legIndex: 1, estUsd: "600" }], "900000000", 6, "100000000")[0]).toMatchObject({ amountRaw: "600000000", scaled: false });
  });
});

describe("Q-08 执行器三态", () => {
  const now = "2026-09-23T10:00:00.000Z";
  it("3 分钟内 agent 心跳 = online；浏览器路径 = awaiting_signature；都无 = offline", () => {
    expect(executorPresence([{ path: "agent_wallet", lastSeenAt: "2026-09-23T09:58:00.000Z" }], now).presence).toBe("online");
    expect(executorPresence([{ path: "agent_wallet", lastSeenAt: "2026-09-23T09:56:59.000Z" }], now).presence).toBe("offline");
    expect(executorPresence([{ path: "browser_wallet", lastSeenAt: "2026-09-23T08:00:00.000Z" }], now).presence).toBe("awaiting_signature");
    expect(executorPresence([], now)).toMatchObject({ presence: "offline", lastSeenAt: null });
    expect(executorPresence([{ path: "browser_wallet", lastSeenAt: "2026-09-23T09:59:00.000Z" }, { path: "agent_wallet", lastSeenAt: "2026-09-23T09:59:30.000Z" }], now).presence).toBe("online");
  });
});

describe("Q-05 通知幂等键与载荷白名单", () => {
  it("键 = type:entityId:version；载荷不含签名/证书/calldata", () => {
    expect(notificationKey("task.step_ready", "tsk_1", 3)).toBe("task.step_ready:tsk_1:3");
    const p = buildNotificationPayload("task.step_ready", "tsk_1", 3, "step 1 ready", "https://x/tasks/tsk_1", "2026-09-23T10:00:00.000Z");
    expect(Object.keys(p).sort()).toEqual(["at", "entityId", "idempotencyKey", "summary", "type", "url", "version"]);
    expect(forbiddenKeysIn(p)).toEqual([]);
    expect(forbiddenKeysIn({ a: { routerCalldata: "0x" }, Signature: "x" })).toEqual(["a.routerCalldata", "Signature"]);
    expect(() => buildNotificationPayload("nope" as never, "e", 1, "", "", "")).toThrow();
  });
});
