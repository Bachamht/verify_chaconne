/** v7 Lane X · 自主减仓（pglite + 假链）：X-19（集成）、X-20、X-22（卖出授权不被计划驱动签发）、任务持仓、SIMULATION 卖出；
 *  D-092 运营者确认 2026-10-02 简化：卖出上限 = 链上全部持仓（已有 + 本任务买入），合约上限 = 委托时余额 + 买入派生公式 */
import { afterEach, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { eq } from "drizzle-orm";
import { verifyBudgetLedger, verifyExecutionJobs, verifyMandateSteps, verifyTasks } from "@chaconne/db";
import { api, TEST_PLANGUARD } from "./helpers";
import { mandateStepMatcher, verifyReceiptsOnce } from "../src/execution/receipts";
import { checklist, createV7Env, ex, EXEC_ADDR, FIXTURE_STOCK_KEY, goalBody, intent, owner, rawTx, runPermitJob, signMandate, signPermit, STABLE, STOCK, type V7Env } from "./v7xHelpers";

let v: V7Env | null = null;
afterEach(async () => {
  await v?.e.close();
  v = null;
});

const STOCK_KEY = FIXTURE_STOCK_KEY.toLowerCase();
type Claimed = { id: string; attempt: number; stepId: string };

async function confirm(env: V7Env) {
  env.chain.mine(10n);
  await verifyReceiptsOnce(env.e.stepReceipts, { getReceipt: (h) => env.chain.getReceipt(h), headBlock: async () => env.chain.head_.number }, { guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(env.e.cfgNow()) });
}
/** 领取 → 提交点 → 假链执行（received / spent 可指定）→ sent → 回执确认 */
async function execute(env: V7Env, f: { received?: string; spent?: string } = {}) {
  const c = await ex.claim(env, EXEC_ADDR);
  expect(c.status, JSON.stringify(c.json).slice(0, 300)).toBe(200);
  const job = (c.json["jobs"] as Claimed[])[0]!;
  const raw = rawTx(job.id);
  const h = keccak256(raw);
  expect((await ex.event(env, job.id, { attempt: job.attempt, type: "sending", rawTxHash: h, nonce: "1", rawTx: raw })).status).toBe(200);
  const st = (await env.e.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.id, job.stepId)))[0]!;
  const s = (st.stepJson as { step: { mandateDigest: string; outputToken: string; amountIn: string; evidenceHash: string } }).step;
  env.chain.landStep(h, { digest: s.mandateDigest, stepIndex: st.stepIndex, outputToken: s.outputToken, amountIn: s.amountIn, evidenceHash: s.evidenceHash, ...f });
  await ex.event(env, job.id, { attempt: job.attempt, type: "sent", txHash: h as Hex });
  await confirm(env);
  return job;
}
/** 签全部 mandate；permit 只签 tokens 里的 */
async function delegate(env: V7Env, taskId: string, opts: { sell: boolean }) {
  let c = await checklist(env, taskId);
  for (const it of c.items.filter((i) => i.kind !== "permit" && i.status === "todo" && (opts.sell || i.kind === "mandate_buy"))) expect((await api(env.e, "POST", `/v1/tasks/${taskId}/authorize`, { itemId: it.id, signature: await signMandate(it.typedData!) })).status).toBe(201);
  for (;;) {
    c = await checklist(env, taskId);
    const todo = c.items.find((i) => i.kind === "permit" && i.status === "todo" && i.permitRequestId && (opts.sell || i.id === `permit:${STABLE}`));
    if (!todo) break;
    expect((await api(env.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: todo.permitRequestId, signature: await signPermit(todo.typedData!) })).status).toBe(202);
    await runPermitJob(env);
  }
}
const sellIntent = (amountInRaw: string, over: Record<string, unknown> = {}) => intent({ kind: "sell", assetKey: FIXTURE_STOCK_KEY, outputAssetKey: undefined, amountInRaw, ...over });
const codes = (j: Record<string, unknown>) => ((j["intent"] as { checks: Array<{ reasons: Array<{ code: string }> }> }).checks.flatMap((c) => c.reasons.map((r) => r.code)));

describe("X-19 / X-20 卖出意图与资金组账目", () => {
  it("无卖出授权 → SELL_NOT_DELEGATED；超链上余额 → BALANCE_INSUFFICIENT；合规 → 证书 → 作业 → 成交；卖出不改资金组账目；issuance=agent 不按 stepsPlanned 完成，卖光后 COMPLETED", async () => {
    v = await createV7Env();
    const r = await api(v.e, "POST", "/v1/tasks", goalBody({}, { maxSteps: 1, budgetCapRaw: "100000000", perStepCapRaw: "100000000" }));
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
    const taskId = (r.json["task"] as { id: string }).id;
    await delegate(v, taskId, { sell: false });
    // 只签了买入：卖出意图 → SELL_NOT_DELEGATED
    const noSell = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, sellIntent("1000"));
    expect(noSell.status).toBe(422);
    expect(codes(noSell.json)).toContain("SELL_NOT_DELEGATED");
    await delegate(v, taskId, { sell: true });
    expect((await checklist(v, taskId)).complete).toBe(true);
    // 买入一步（maxSteps = 1 → 买入授权 COMPLETED）
    const b = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, intent({ amountInRaw: "100000000" }));
    expect(b.status, JSON.stringify(b.json).slice(0, 400)).toBe(201);
    await execute(v, { received: "200000000000000000" });
    v.chain.setBalance(STOCK, 200000000000000000n);
    let task = (await v.e.db.select().from(verifyTasks).where(eq(verifyTasks.id, taskId)))[0]!;
    expect(task.stepsConfirmed).toBe(1);
    expect(task.status).not.toBe("COMPLETED"); // 旧规则 1/1 步就会 COMPLETED；委托任务还有可卖持仓
    const pos = await api(v.e, "GET", `/v1/tasks/${taskId}/positions`);
    expect(pos.status).toBe(200);
    expect((pos.json["positions"] as Array<{ assetKey: string; netRaw: string; sellableRaw: string }>).find((p) => p.assetKey === STOCK_KEY)).toMatchObject({ netRaw: "200000000000000000", sellableRaw: "200000000000000000" });
    // 超链上余额（D-092 简化后服务上限 = 链上余额，不再是任务净持仓）
    const over = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, sellIntent("300000000000000000"));
    expect(over.status).toBe(422);
    expect(codes(over.json)).toContain("BALANCE_INSUFFICIENT");
    expect(codes(over.json)).not.toContain("SELL_EXCEEDS_TASK_POSITION");
    // outputAssetKey 给了但不是资金币种 → 越界
    expect(codes((await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, sellIntent("1000", { outputAssetKey: FIXTURE_STOCK_KEY }))).json)).toContain("INTENT_OUT_OF_SCOPE");
    const ledgerBefore = await v.e.db.select().from(verifyBudgetLedger);
    const s = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, sellIntent("200000000000000000"));
    expect(s.status, JSON.stringify(s.json).slice(0, 600)).toBe(201);
    expect((s.json["intent"] as { status: string; assetKey: string }).status).toBe("certified");
    const jobId = (s.json["execution"] as { jobId: string }).jobId;
    const job = (await v.e.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.id, jobId)))[0]!;
    expect(job.tokenAddress).toBe(STOCK); // 卖出：PlanGuard 拉股票
    const st = (await v.e.db.select().from(verifyMandateSteps).where(eq(verifyMandateSteps.id, job.stepId!)))[0]!;
    expect((st.stepJson as { step: { outputToken: string; amountIn: string } }).step).toMatchObject({ outputToken: STABLE, amountIn: "200000000000000000" });
    await execute(v, { spent: "200000000000000000", received: "99000000" });
    v.chain.setBalance(STOCK, 0n);
    task = (await v.e.db.select().from(verifyTasks).where(eq(verifyTasks.id, taskId)))[0]!;
    expect(task.sellStepsConfirmed).toBe(1);
    expect(task.stepsConfirmed).toBe(1);
    const ledgerAfter = await v.e.db.select().from(verifyBudgetLedger);
    expect(ledgerAfter.length).toBe(ledgerBefore.length); // 卖出成交不改资金组账目
    expect(task.status).toBe("COMPLETED");
    const pos2 = await api(v.e, "GET", `/v1/tasks/${taskId}/positions`);
    expect((pos2.json["positions"] as Array<{ assetKey: string; netRaw: string; soldRaw: string }>).find((p) => p.assetKey === STOCK_KEY)).toMatchObject({ netRaw: "0", soldRaw: "200000000000000000" });
  });
  it("X-22 卖出授权不会被计划驱动签发（evaluate 不签、不改状态）；SIMULATION 卖出走卖出方向核验", async () => {
    v = await createV7Env();
    const r = await api(v.e, "POST", "/v1/tasks", goalBody());
    const taskId = (r.json["task"] as { id: string }).id;
    await delegate(v, taskId, { sell: true });
    const view = await api(v.e, "GET", `/v1/tasks/${taskId}`);
    const mids = (view.json["mandates"] as Array<{ mandateId: string }>).map((m) => m.mandateId);
    const sellRow = (await Promise.all(mids.map((id) => v!.e.mandates.byId(id)))).find((m) => m!.side === "sell")!;
    expect(sellRow.assetKey).toBe(STOCK_KEY);
    const ev = await v.e.mandates.evaluate(sellRow, { issue: true });
    expect(ev.step).toBeNull();
    expect((await v.e.mandates.byId(sellRow.id))!.state).toBe("ACTIVE");
    // SIMULATION：同一目标的观察任务，卖出意图只核验不签
    const sim = await api(v.e, "POST", "/v1/tasks", goalBody({ mode: "SIMULATION", executor: undefined }));
    expect(sim.status, JSON.stringify(sim.json).slice(0, 300)).toBe(201);
    const simId = (sim.json["task"] as { id: string }).id;
    const ss = await api(v.e, "POST", `/v1/tasks/${simId}/intents`, sellIntent("100000000000000000"));
    expect([201, 422]).toContain(ss.status);
    const simIntent = ss.json["intent"] as { status: string; checks: Array<{ id: string; ok: boolean; detail: Record<string, unknown> }> };
    expect(simIntent.checks.find((c) => c.id === "scope")!.ok).toBe(true);
    expect(simIntent.checks.find((c) => c.id === "execution")!.detail["simulation"]).toBe(true);
    void owner;
  });
});

describe("D-092 简化（运营者确认 2026-10-02）：可卖出全部持仓", () => {
  it("委托前已有持仓：卖出合约上限 = 余额 + 公式；没买过也能卖已有持仓；不超过链上余额；positions.sellableRaw = 链上余额", async () => {
    v = await createV7Env();
    v.chain.setBalance(STOCK, 1_000000000000000000n); // 委托前已持有 1 股
    const r = await api(v.e, "POST", "/v1/tasks", goalBody());
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
    const taskId = (r.json["task"] as { id: string }).id;
    const c = await checklist(v, taskId);
    const sellItem = c.items.find((i) => i.kind === "mandate_sell")!;
    // 500 USDG × 2 / 250 USD = 4 股（买入派生）+ 已有 1 股
    expect((sellItem.typedData!.message as Record<string, string>)["budgetCap"]).toBe("5000000000000000000");
    expect((sellItem as unknown as { explain: { zh: string } }).explain.zh).toMatch(/最多可卖出你的全部持仓；换回的 USDG 只进你的钱包|最多可卖出你的全部持仓；换回的 .+ 只进你的钱包/);
    await delegate(v, taskId, { sell: true });
    expect((await checklist(v, taskId)).complete).toBe(true);
    const pos = await api(v.e, "GET", `/v1/tasks/${taskId}/positions`);
    expect((pos.json["positions"] as Array<{ assetKey: string; netRaw: string; sellableRaw: string }>).find((p) => p.assetKey === STOCK_KEY)).toMatchObject({ netRaw: "0", sellableRaw: "1000000000000000000" });
    expect(String(pos.json["note"])).toMatch(/full holdings/);
    // 超出链上余额 → BALANCE_INSUFFICIENT
    const over = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, sellIntent("1500000000000000000"));
    expect(over.status).toBe(422);
    expect(codes(over.json)).toContain("BALANCE_INSUFFICIENT");
    // 本任务没买过，也能卖出全部已有持仓（旧规则会以 SELL_EXCEEDS_TASK_POSITION 拒绝）
    const s = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, sellIntent("1000000000000000000"));
    expect(s.status, JSON.stringify(s.json).slice(0, 800)).toBe(201);
    expect((s.json["intent"] as { status: string }).status).toBe("certified");
    const job = await execute(v, { spent: "1000000000000000000", received: "249000000" });
    expect(job.id).toBe((s.json["execution"] as { jobId: string }).jobId);
    const task = (await v.e.db.select().from(verifyTasks).where(eq(verifyTasks.id, taskId)))[0]!;
    expect(task.sellStepsConfirmed).toBe(1);
  });
  it("卖出草案生成时读不到链上余额 → failed{balance_unavailable}；恢复后 refresh 成功", async () => {
    v = await createV7Env();
    const orig = v.chain.balanceOf.bind(v.chain);
    v.chain.balanceOf = async (token: Hex, o: Hex) => {
      if (token.toLowerCase() === STOCK) throw new Error("rpc down");
      return orig(token, o);
    };
    const r = await api(v.e, "POST", "/v1/tasks", goalBody());
    const taskId = (r.json["task"] as { id: string }).id;
    const c = await checklist(v, taskId);
    const sell = c.items.find((i) => i.kind === "mandate_sell")!;
    expect(sell.status).toBe("failed");
    expect(sell.error?.code).toBe("balance_unavailable");
    v.chain.balanceOf = orig;
    const rf = await api(v.e, "POST", `/v1/tasks/${taskId}/delegation/refresh`);
    expect(rf.status).toBe(200);
    const sell2 = (rf.json["items"] as Array<{ kind: string; status: string; typedData: { message: Record<string, string> } | null }>).find((i) => i.kind === "mandate_sell")!;
    expect(sell2.status).toBe("todo");
    expect(sell2.typedData!.message["budgetCap"]).toBe("4000000000000000000");
  });
});
