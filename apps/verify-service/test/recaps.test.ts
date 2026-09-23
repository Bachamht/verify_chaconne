/**
 * C5 Recap（R 组）：
 *  R-02 账目与时间线一致，收盘时刻随日历（常规 16:00 / 提前收盘 13:00，DST 由 Intl 决定，不硬编码）；
 *  R-03 模拟/回放/真实标识（FIXTURE 绝不标 LIVE）；R-04 默认私密、公开可隐藏资产与金额、owner 恒隐藏；
 *  R-05 无排行榜，只有按可核对行为的个人里程碑与可翻创目录（不含金额/钱包）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { PLANGUARD_ABI } from "../src/execution/planGuardAbi";
import { mandateStepMatcher, verifyReceiptsOnce, type ChainReceipt, type ReceiptSource } from "../src/execution/receipts";
import { ledgerMatchesTimeline, publicRecapView, recapId } from "../src/recaps/build";
import { latestDueRecapDate, nyLocalToUtc, previousTradingDay, recapWindow } from "../src/recaps/window";
import type { Recap, RecapPending } from "../src/recaps/types";
import { api, createTestEnv, signedMandateBody, TEST_CALLER, TEST_PLANGUARD, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const TX = ("0x" + "ef".repeat(32)) as Hex;
const T_AFTER_CLOSE = "2026-09-18T21:00:00.000Z"; // 17:00 ET，收盘 + 60 min（门槛 20:45Z）

function stepLog(mandateDigest: Hex, stepIndex: number, owner: Hex, spent = "100000000") {
  const topics = encodeEventTopics({ abi: PLANGUARD_ABI, eventName: "MandateStep", args: { owner, mandateDigest, stepIndex } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }],
    ["0x2222222222222222222222222222222222222222", BigInt(spent), BigInt(spent), 400_000_000_000_000_000n, 0n, ("0x" + "11".repeat(32)) as Hex, "0x9999999999999999999999999999999999999999"],
  );
  return { address: TEST_PLANGUARD, data, topics };
}
const receipt = (over: Partial<ChainReceipt> = {}): ChainReceipt => ({ status: "success", blockNumber: 100n, blockHash: "0x" + "ab".repeat(32), gasUsed: 620_000n, logs: [], ...over });
const source = (r: ChainReceipt | null, head: bigint): ReceiptSource => ({ getReceipt: async () => r, headBlock: async () => head });

/** 登记 2 步授权，确认第 0 步（真实回执核实器路径），留第 1 步未执行 */
async function oneConfirmedStep(e: TestEnv) {
  const { body, owner } = await signedMandateBody(e, { clientRequestId: "rc1", maxSteps: 2, budgetCap: "200000000", perStepCap: "100000000" });
  const r = await api(e, "POST", "/v1/mandates", body);
  expect(r.status).toBe(201);
  const id = r.json["mandateId"] as string;
  const digest = r.json["mandateDigest"] as Hex;
  await api(e, "POST", `/v1/mandates/${id}/prepare-step`, {});
  await api(e, "POST", `/v1/mandates/${id}/steps/0/submissions`, { txHash: TX });
  const opts = { guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(e.cfgNow()) };
  await verifyReceiptsOnce(e.mandates, source(receipt({ logs: [stepLog(digest, 0, owner as Hex)] }), 200n), opts);
  return { id, owner };
}

describe("R-02 · 生成时刻随日历（session.ts 时区）", () => {
  it("常规日 16:00 ET + 45 min；提前收盘日 13:00 ET + 45 min；周末/假日不生成；DST 由 Intl 决定", () => {
    const w = recapWindow("2026-09-18"); // 周五，EDT
    expect(w.tradingDay).toBe(true);
    expect(w.earlyClose).toBe(false);
    expect(w.closeAtUtc?.toISOString()).toBe("2026-09-18T20:00:00.000Z");
    expect(w.generateAfterUtc?.toISOString()).toBe("2026-09-18T20:45:00.000Z");
    const half = recapWindow("2026-11-27"); // 感恩节次日，EST
    expect(half.earlyClose).toBe(true);
    expect(half.closeAtUtc?.toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(half.generateAfterUtc?.toISOString()).toBe("2026-11-27T18:45:00.000Z");
    expect(recapWindow("2026-09-19").tradingDay).toBe(false); // 周六
    expect(recapWindow("2026-11-26").tradingDay).toBe(false); // 感恩节
    // 夏令时切换日（2026-11-01 02:00 回拨）：反解仍收敛
    expect(nyLocalToUtc("2026-11-02", 16 * 60).toISOString()).toBe("2026-11-02T21:00:00.000Z");
    expect(nyLocalToUtc("2026-10-30", 16 * 60).toISOString()).toBe("2026-10-30T20:00:00.000Z");
    expect(latestDueRecapDate(new Date("2026-09-18T20:44:59Z"))).toBe("2026-09-17");
    expect(latestDueRecapDate(new Date("2026-09-18T20:45:00Z"))).toBe("2026-09-18");
    expect(latestDueRecapDate(new Date("2026-09-20T02:00:00Z"))).toBe("2026-09-18"); // 周六看周五
    expect(previousTradingDay("2026-09-21")).toBe("2026-09-18");
    expect(previousTradingDay("2026-09-08")).toBe("2026-09-04"); // 跳过 Labor Day
  });

  it("门槛未到 → 200 pending（不提前编内容）；到点后账目 = 时间线之和，等待原因带原因码，剩余工作与决策项齐全", async () => {
    env = await createTestEnv();
    const { id, owner } = await oneConfirmedStep(env);
    const early = await api(env, "GET", `/v1/recaps?owner=${owner}`);
    expect(early.status).toBe(200);
    // 11:00 ET 时最近已到门槛的是前一交易日：给的是 9/17 的（空）日志，不是今天的半成品
    const yesterday = early.json as unknown as Recap;
    expect(yesterday.date).toBe("2026-09-17");
    expect(yesterday.sections.trades).toHaveLength(0);
    const notYet = await api(env, "GET", `/v1/recaps?owner=${owner}&date=2026-09-18`);
    expect((notYet.json as unknown as RecapPending).status).toBe("pending");
    expect((notYet.json as unknown as RecapPending).generateAfterUtc).toBe("2026-09-18T20:45:00.000Z");

    env.setNow(T_AFTER_CLOSE);
    const r = await api(env, "GET", `/v1/recaps?owner=${owner}`);
    expect(r.status).toBe(200);
    const recap = r.json as unknown as Recap;
    expect(recap.date).toBe("2026-09-18");
    expect(recap.id).toBe(recapId(TEST_CALLER, owner, "2026-09-18"));
    expect(recap.closeAtUtc).toBe("2026-09-18T20:00:00.000Z");
    // 账目：一步确认 100 USDG；时间线里 step_confirmed 带同一 amountRaw（R-02 可复算）
    expect(recap.ledger).toHaveLength(1);
    expect(recap.ledger[0]!.spentRaw).toBe("100000000");
    expect(recap.ledger[0]!.steps).toBe(1);
    expect(ledgerMatchesTimeline(recap)).toBe(true);
    expect(recap.timeline.filter((t) => t.type === "step_confirmed")).toHaveLength(1);
    expect(recap.timeline.find((t) => t.type === "step_confirmed")?.txHash).toBe(TX);
    expect(recap.sections.trades).toHaveLength(1);
    expect(recap.sections.trades[0]!.amountInRaw).toBe("100000000");
    // 处理了哪些任务 / 剩余工作 / 需决策
    expect(recap.sections.handled.map((h) => h.refId)).toContain(id);
    expect(recap.sections.remaining[0]).toMatchObject({ refId: id, stepsLeft: 1 });
    expect(recap.sections.decisions.some((d) => d.refId === id && d.code === "EXPIRING")).toBe(true); // 24h 期限内到期
    // 篡改账目后复算失败
    expect(ledgerMatchesTimeline({ ...recap, ledger: [{ ...recap.ledger[0]!, spentRaw: "1" }] })).toBe(false);
    // GET /v1/recaps/:id 同一份；别的调用方拿不到
    expect((await api(env, "GET", `/v1/recaps/${recap.id}`)).json["id"]).toBe(recap.id);
    expect((await api(env, "GET", `/v1/recaps/${recap.id}`, undefined, {}, "vk_test_beta")).status).toBe(404);
  });

  it("等待原因：休市评估的 WAIT 进 waited（原因码 + 文案），不写涨跌", async () => {
    env = await createTestEnv({ now: "2026-09-18T12:00:00.000Z", scenario: "closed" }); // 08:00 ET 盘前
    const { body, owner } = await signedMandateBody(env, { clientRequestId: "rw1", policyId: "STRICT_LIVE" });
    const r = await api(env, "POST", "/v1/mandates", body);
    const id = r.json["mandateId"] as string;
    const p = await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    expect(p.status).toBe(409);
    env.setNow(T_AFTER_CLOSE);
    const recap = (await api(env, "GET", `/v1/recaps?owner=${owner}&date=2026-09-18`)).json as unknown as Recap;
    const w = recap.sections.waited.find((x) => x.refId === id)!;
    expect(w.reasons.map((x) => x.code)).toContain("MARKET_OUTSIDE_REGULAR");
    expect(w.reasons.find((x) => x.code === "MARKET_OUTSIDE_REGULAR")!.text).toMatch(/regular hours/);
    expect(recap.ledger).toHaveLength(0);
    expect(JSON.stringify(recap)).not.toMatch(/will rise|will fall|涨|跌/);
  });
});

describe("R-03 · 模式标识", () => {
  it("夹具证据标 FIXTURE，绝不标 LIVE；未接上的来源 coverage=unavailable", async () => {
    env = await createTestEnv();
    const { owner } = await oneConfirmedStep(env);
    env.setNow(T_AFTER_CLOSE);
    const recap = (await api(env, "GET", `/v1/recaps?owner=${owner}`)).json as unknown as Recap;
    expect(recap.modes).toEqual(["FIXTURE"]);
    expect(recap.sections.trades[0]!.mode).toBe("FIXTURE");
    expect(recap.coverage).toEqual({ mandates: "ok", tasks: "unavailable", events: "unavailable" });
  });

  it("Lane B 任务钩子接上后：任务标 SIMULATION（授权前），coverage.tasks=ok", async () => {
    env = await createTestEnv({
      recapHooks: {
        tasksForOwner: async () => [{ id: "tsk_1", owner: "0x0000000000000000000000000000000000000001", playbookId: "session_dca", goal: { ownerAddress: "0x0000000000000000000000000000000000000001", recipientAddress: "0x0000000000000000000000000000000000000001", executionChainId: 196, legs: [{ outputAssetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", weightBps: 10000 }], budget: { inputAssetKeys: ["eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8"], amountInRaw: "1" }, side: "buy", policyId: "REFERENCE_CONTEXT", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: null, maxReferenceDeviationBps: null, deadline: "2026-09-19T00:00:00Z" }, conditions: { version: "conditions/1", items: [], hash: ("0x" + "00".repeat(32)) as `0x${string}` }, mandateIds: [], status: "WAITING", blockers: [{ code: "EVENT_WINDOW_ACTIVE", evidenceIds: [], evidenceAt: null, nextCheckAt: "2026-09-21T13:30:00Z", userActionRequired: false, text: "inside an event window" }], nextCheckAt: "2026-09-21T13:30:00Z", executorPresence: "offline", createdAt: "2026-09-18T10:00:00Z", updatedAt: "2026-09-18T10:00:00Z" }],
        eventsBetween: async () => [],
      },
    });
    env.setNow(T_AFTER_CLOSE);
    const recap = (await api(env, "GET", `/v1/recaps?owner=0x0000000000000000000000000000000000000001`)).json as unknown as Recap;
    expect(recap.coverage).toEqual({ mandates: "ok", tasks: "ok", events: "ok" });
    expect(recap.modes).toContain("SIMULATION");
    expect(recap.sections.waited[0]).toMatchObject({ refId: "tsk_1", nextCheckAt: "2026-09-21T13:30:00Z" });
    expect(recap.sections.waited[0]!.reasons[0]!.code).toBe("EVENT_WINDOW_ACTIVE");
  });
});

describe("R-04 · 分享默认私密", () => {
  it("默认 public=false 且无 shareId；公开视图不含 owner，可隐藏资产与金额；私密时 /pub 404", async () => {
    env = await createTestEnv();
    const { owner } = await oneConfirmedStep(env);
    env.setNow(T_AFTER_CLOSE);
    const recap = (await api(env, "GET", `/v1/recaps?owner=${owner}`)).json as unknown as Recap;
    expect(recap.share).toEqual({ public: false, hideAssets: true, hideAmounts: true, shareId: null, publicUrl: null });
    const pubBefore = await fetch(`${env.url}/pub/recaps/anything`);
    expect(pubBefore.status).toBe(404);
    const shared = await api(env, "POST", `/v1/recaps/${recap.id}/share`, { public: true });
    const share = shared.json["share"] as Recap["share"];
    expect(share.public).toBe(true);
    expect(share.shareId).toMatch(/^rsh_/);
    const pub = (await (await fetch(`${env.url}${share.publicUrl}`)).json()) as Record<string, unknown>;
    expect(JSON.stringify(pub).toLowerCase()).not.toContain(owner.toLowerCase());
    expect((pub["privacy"] as Record<string, string>)["owner"]).toBe("hidden");
    expect((pub["ledger"] as Array<{ assetKey: string; spentRaw: string | null }>)[0]).toEqual({ assetKey: "hidden", spentRaw: null, receivedRaw: null, steps: 1 });
    // 选择公开资产与金额
    await api(env, "POST", `/v1/recaps/${recap.id}/share`, { public: true, hideAssets: false, hideAmounts: false });
    const pub2 = (await (await fetch(`${env.url}${share.publicUrl}`)).json()) as Record<string, unknown>;
    expect((pub2["ledger"] as Array<{ assetKey: string; spentRaw: string }>)[0]!.spentRaw).toBe("100000000");
    expect((pub2["ledger"] as Array<{ assetKey: string }>)[0]!.assetKey).toMatch(/^eip155:/);
    expect(JSON.stringify(pub2).toLowerCase()).not.toContain(owner.toLowerCase());
    // 重新设为私密 → 404
    await api(env, "POST", `/v1/recaps/${recap.id}/share`, { public: false });
    expect((await fetch(`${env.url}${share.publicUrl}`)).status).toBe(404);
    // 纯函数也不泄露 owner
    expect(JSON.stringify(publicRecapView({ ...recap, share: { ...recap.share, public: true, hideAssets: false, hideAmounts: false } }))).not.toContain(owner.toLowerCase());
  });

  it("owner 鉴权：web 通配调用方只能读自己地址的 recap", async () => {
    env = await createTestEnv({ extraKeys: "vk_web:web:*" });
    const me = "0x1111111111111111111111111111111111111111";
    const ok = await api(env, "GET", `/v1/recaps?owner=${me}&date=2026-09-17`, undefined, { "x-verify-caller": me }, "vk_web");
    expect(ok.status).toBe(200);
    const other = await api(env, "GET", `/v1/recaps?owner=0x2222222222222222222222222222222222222222&date=2026-09-17`, undefined, { "x-verify-caller": me }, "vk_web");
    expect(other.status).toBe(403);
    expect(other.json["error"]).toBe("owner_mismatch");
    expect((await api(env, "GET", `/v1/recaps?owner=nope`)).status).toBe(400);
  });
});

describe("R-05 · 无排行榜", () => {
  it("响应没有任何排行/排名字段；里程碑只按可核对行为并带证据指针；翻创目录不含金额与钱包", async () => {
    env = await createTestEnv();
    const { id, owner } = await oneConfirmedStep(env);
    env.setNow(T_AFTER_CLOSE);
    const recap = (await api(env, "GET", `/v1/recaps?owner=${owner}`)).json as unknown as Recap;
    expect(Object.keys(recap).some((k) => /rank|leaderboard|score|streak|compliance/i.test(k))).toBe(false);
    expect(JSON.stringify(recap)).not.toMatch(/leaderboard|"rank"|streak/i);
    const ids = recap.milestones.map((m) => m.id);
    expect(ids).toContain("first_authorization");
    expect(ids).toContain("first_step_confirmed");
    expect(recap.milestones.find((m) => m.id === "first_step_confirmed")!.evidence).toEqual({ refId: id, txHash: TX });
    const rm = recap.remixable[0]!;
    expect(rm.structure).not.toHaveProperty("budgetCap");
    expect(rm.structure).not.toHaveProperty("owner");
    expect(JSON.stringify(rm)).not.toContain(owner.toLowerCase());
    expect(rm.remixHref).toBe(`/agent?remix=mandate:${id}`);
  });
});

describe("开关", () => {
  it("AGENT_C5_ENABLED=false → /v1/recaps 与 /v1/missions 404（页面据此显示「尚未就绪」）", async () => {
    env = await createTestEnv({ env: { AGENT_C5_ENABLED: "false" } });
    expect((await api(env, "GET", "/v1/recaps?owner=0x1111111111111111111111111111111111111111")).status).toBe(404);
    expect((await api(env, "GET", "/v1/missions")).status).toBe(404);
  });
});
