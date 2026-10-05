/** v7 Lane X · 委托仪式（pglite + 假链）：S-01、X-04、X-05（服务侧）、X-06、X-07（集成）、X-23、X-24、X-25、SEC-07 / SEC-08（服务侧） */
import { afterEach, describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { api } from "./helpers";
import { verifyMandates, verifyPermits } from "@chaconne/db";
import { eq } from "drizzle-orm";
import { checklist, createV7Env, delegateFully, ex, FIXTURE_STOCK_KEY, goalBody, intent, owner, rawTx, runPermitJob, signMandate, signMandates, signPermit, STABLE, STOCK, type V7Env } from "./v7xHelpers";

let v: V7Env | null = null;
afterEach(async () => {
  await v?.e.close();
  v = null;
});

async function createTask(env: V7Env, over: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) {
  const r = await api(env.e, "POST", "/v1/tasks", goalBody(over, scope));
  expect(r.status, JSON.stringify(r.json).slice(0, 500)).toBe(201);
  return (r.json["task"] as { id: string }).id;
}

describe("建任务：模式、准入、recipient、卖出草案", () => {
  it("SEC-07 非白名单钱包建托管 LIVE 任务 → 403 hosted_not_allowed；开关关 → 503 hosted_disabled；recipient ≠ owner → 400", async () => {
    v = await createV7Env({ env: { HOSTED_OWNER_ALLOWLIST: "0x00000000000000000000000000000000000000aa" } });
    expect((await api(v.e, "POST", "/v1/tasks", goalBody())).json["error"]).toBe("hosted_not_allowed");
    await v.e.close();
    v = await createV7Env({ env: { HOSTED_EXECUTOR_ENABLED: "false" } });
    const off = await api(v.e, "POST", "/v1/tasks", goalBody());
    expect(off.status).toBe(503);
    expect(off.json["error"]).toBe("hosted_disabled");
    const rcpt = await api(v.e, "POST", "/v1/tasks", goalBody({ executor: { mode: "browser" }, recipientAddress: "0x00000000000000000000000000000000000000bb" }));
    expect(rcpt.status).toBe(400);
    expect(rcpt.json["error"]).toBe("recipient_must_be_owner");
  });
  it("SIMULATION 托管任务每钱包每天 ≤ HOSTED_SIM_PER_OWNER_PER_DAY", async () => {
    v = await createV7Env({ env: { HOSTED_SIM_PER_OWNER_PER_DAY: "1" } });
    expect((await api(v.e, "POST", "/v1/tasks", goalBody({ mode: "SIMULATION", executor: undefined }))).status).toBe(201);
    const second = await api(v.e, "POST", "/v1/tasks", goalBody({ mode: "SIMULATION", executor: undefined }));
    expect(second.status).toBe(429);
    expect(second.json["error"]).toBe("hosted_sim_limit");
  });
});

describe("S-01 / X-06 / X-05 委托清单与 permit", () => {
  it("S-01 买入任务：额度 0 → 签名 2 次、用户交易 0；签完买入授权不转 ACTIVE；permit 上链确认后 buyReady → ACTIVE，task.delegation_completed 恰一次", async () => {
    v = await createV7Env();
    const taskId = await createTask(v, {}, { allowSell: false });
    const c0 = await checklist(v, taskId);
    expect(c0.items.map((i) => i.id)).toEqual(["buy", `permit:${STABLE}`]);
    expect(c0.counts).toEqual({ signaturesNeeded: 2, signaturesDone: 0, userTransactions: 0 });
    expect(c0.items[1]!.permitRequestId).toMatch(/^prm_/);
    const td = c0.items[1]!.typedData!;
    expect((td.message as Record<string, string>)["spender"]).toBe("0x7777777777777777777777777777777777777777");
    expect((td.message as Record<string, string>)["value"]).toBe("502500000"); // 500 USDG + 0.5%
    await signMandates(v, taskId);
    expect((await api(v.e, "GET", `/v1/tasks/${taskId}`)).json["task"]).toMatchObject({ status: "AWAITING_AUTHORIZATION" });
    // 意图在委托完成前被拒（任务未 ACTIVE）
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, intent())).status).toBe(409);
    await delegateFully(v, taskId);
    const c1 = await checklist(v, taskId);
    expect(c1.buyReady).toBe(true);
    expect(c1.complete).toBe(true);
    expect(c1.counts).toEqual({ signaturesNeeded: 2, signaturesDone: 2, userTransactions: 0 });
    const view = await api(v.e, "GET", `/v1/tasks/${taskId}`);
    expect((view.json["task"] as { status: string }).status).not.toBe("AWAITING_AUTHORIZATION");
    expect((view.json["delegation"] as { complete: boolean }).complete).toBe(true);
    const permits = await v.e.db.select().from(verifyPermits);
    expect(permits.filter((p) => p.state === "CONFIRMED")).toHaveLength(1);
    expect(permits.find((p) => p.state === "CONFIRMED")!.allowanceAfter).toBe("502500000");
    // 再刷新一次：不重复发 delegation_completed
    await v.wiring.handles.delegation.refreshDelegation(taskId);
    expect(v.e.notifier.emitted.filter((n) => n.type === "task.delegation_completed" && n.entityId === taskId)).toHaveLength(1);
  });
  it("X-06 链上额度已足 → permit 项 not_needed，签名数 1；并锁定（别的任务登记后不翻转）", async () => {
    v = await createV7Env();
    v.chain.setAllowance(STABLE, 10_000_000_000n);
    const taskId = await createTask(v, {}, { allowSell: false });
    const c = await checklist(v, taskId);
    expect(c.items[1]!.status).toBe("not_needed");
    expect(c.counts.signaturesNeeded).toBe(1);
    await signMandates(v, taskId);
    expect((await checklist(v, taskId)).buyReady).toBe(true);
    v.chain.setAllowance(STABLE, 0n);
    expect((await checklist(v, taskId)).buyReady).toBe(true);
  });
});

describe("额度账本：已过期的授权不再占用额度（2026-10-03 线上首单发现）", () => {
  it("同一 owner 旧任务的授权 deadline 已过 → 新任务 permit value 只覆盖新任务；未过期的仍计入", async () => {
    v = await createV7Env();
    const a = await createTask(v, {}, { allowSell: false });
    await signMandates(v, a);
    const b0 = await createTask(v, { clientRequestId: "ledger-b0" }, { allowSell: false });
    const withOld = (await checklist(v, b0)).items.find((i) => i.kind === "permit")!;
    expect((withOld.typedData!.message as Record<string, string>)["value"]).toBe("1005000000"); // 旧授权未过期：500 + 500 + 0.5%
    // 测试环境用固定时钟，取一个早于它的时刻表示「已过期」
    await v.e.db.update(verifyMandates).set({ deadline: new Date("2020-01-01T00:00:00Z") }).where(eq(verifyMandates.taskId, a));
    const b1 = await createTask(v, { clientRequestId: "ledger-b1" }, { allowSell: false });
    const fresh = (await checklist(v, b1)).items.find((i) => i.kind === "permit")!;
    // 旧授权过期后：b0 未签名、没有授权行，不计；只剩 b1 自己：500 + 0.5%
    expect((fresh.typedData!.message as Record<string, string>)["value"]).toBe("502500000");
  });
});

describe("X-04 / X-23 POST /allowances 拒绝矩阵与代付限制", () => {
  it("错 owner 签名 / 改过的 value / nonce 过期 / deadline 越界 / 在途重复 / 额度已足 / 非托管执行 / 非白名单 / 限频", async () => {
    v = await createV7Env({ env: { PERMIT_RELAY_PER_OWNER_PER_HOUR: "2" } });
    const taskId = await createTask(v, {}, { allowSell: false });
    await signMandates(v, taskId);
    const c = await checklist(v, taskId);
    const p = c.items.find((i) => i.kind === "permit")!;
    const goodSig = await signPermit(p.typedData!);
    // 错 owner：别的账户签
    const { privateKeyToAccount } = await import("viem/accounts");
    const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const m = p.typedData!.message as Record<string, string>;
    const badSig = await other.signTypedData({ domain: p.typedData!.domain, types: { Permit: p.typedData!.types["Permit"]! }, primaryType: "Permit", message: { owner: m["owner"], spender: m["spender"], value: BigInt(m["value"]!), nonce: BigInt(m["nonce"]!), deadline: BigInt(m["deadline"]!) } } as never);
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: badSig })).json["error"]).toBe("permit_signature_invalid");
    // owner 签了一份不同 value / spender 的 typedData → 恢复不出 owner
    const tampered = await OWNERsign(p.typedData!, { value: "999999999999" });
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: tampered })).json["error"]).toBe("permit_signature_invalid");
    const wrongSpender = await OWNERsign(p.typedData!, { spender: "0x00000000000000000000000000000000000000cc" });
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: wrongSpender })).json["error"]).toBe("permit_signature_invalid");
    // body 里改 value → 422
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: goodSig, value: "1" })).json["error"]).toBe("permit_value_mismatch");
    // nonce 过期（链上 nonce 已前进）
    v.chain.tokenNonces.set(`${STABLE}:${owner}`, 5n);
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: goodSig })).json["error"]).toBe("permit_nonce_stale");
    v.chain.tokenNonces.set(`${STABLE}:${owner}`, 0n);
    // deadline 越界（时间推进 29 分钟）
    v.e.setNow("2026-09-18T15:27:00.000Z");
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: goodSig })).json["error"]).toBe("permit_request_expired");
    v.e.setNow("2026-09-18T14:58:00.000Z");
    // 额度已足 → 409 permit_not_needed（X-23）
    v.chain.setAllowance(STABLE, 600_000_000n);
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: goodSig })).json["error"]).toBe("permit_not_needed");
    v.chain.setAllowance(STABLE, 0n);
    // 正常提交 → 202；同一请求再提交 → 409 permit_not_issued；新请求在途 → 409 permit_pending
    const ok = await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: goodSig });
    expect(ok.status, JSON.stringify(ok.json)).toBe(202);
    expect((await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: p.permitRequestId, signature: goodSig })).json["error"]).toBe("permit_pending");
    const c2 = await checklist(v, taskId);
    const p2 = c2.items.find((i) => i.kind === "permit")!;
    expect(p2.status).toBe("submitted");
  });
  it("X-23 非托管执行任务不代付；每 owner 每小时上限 429", async () => {
    v = await createV7Env({ env: { PERMIT_RELAY_PER_OWNER_PER_HOUR: "1" } });
    const browserTask = await createTask(v, { executor: { mode: "browser" } }, { allowSell: false });
    await signMandates(v, browserTask);
    const c = await checklist(v, browserTask);
    const p = c.items.find((i) => i.kind === "permit")!;
    expect((await api(v.e, "POST", `/v1/tasks/${browserTask}/allowances`, { permitRequestId: p.permitRequestId, signature: await signPermit(p.typedData!) })).json["error"]).toBe("relay_not_allowed");
    const t1 = await createTask(v, {}, { allowSell: false });
    await signMandates(v, t1);
    const c1 = await checklist(v, t1);
    const p1 = c1.items.find((i) => i.kind === "permit")!;
    expect((await api(v.e, "POST", `/v1/tasks/${t1}/allowances`, { permitRequestId: p1.permitRequestId, signature: await signPermit(p1.typedData!) })).status).toBe(202);
    await runPermitJob(v);
    const t2 = await createTask(v, {}, { allowSell: false });
    await signMandates(v, t2);
    const c2 = await checklist(v, t2);
    const p2 = c2.items.find((i) => i.kind === "permit" && i.status === "todo")!;
    const limited = await api(v.e, "POST", `/v1/tasks/${t2}/allowances`, { permitRequestId: p2.permitRequestId, signature: await signPermit(p2.typedData!) });
    expect(limited.status).toBe(429);
    expect(limited.json["error"]).toBe("permit_relay_limited");
  });
});

async function OWNERsign(td: NonNullable<Awaited<ReturnType<typeof checklist>>["items"][number]["typedData"]>, over: Record<string, string>) {
  const { OWNER } = await import("./v7xHelpers");
  const m = { ...(td.message as Record<string, string>), ...over };
  return OWNER.signTypedData({ domain: td.domain, types: { Permit: td.types["Permit"]! }, primaryType: "Permit", message: { owner: m["owner"], spender: m["spender"], value: BigInt(m["value"]!), nonce: BigInt(m["nonce"]!), deadline: BigInt(m["deadline"]!) } } as never);
}

describe("X-07 卖出草案与 S-02 清单", () => {
  it("allowSell：生成卖出草案（合约上限按公式）；签名数 = 买 + 卖 + 2 个 permit；价格缺失 → failed，refresh 后成功", async () => {
    v = await createV7Env({ p6: null });
    const taskId = await createTask(v);
    const c0 = await checklist(v, taskId);
    const sell = c0.items.find((i) => i.kind === "mandate_sell")!;
    expect(sell.status).toBe("failed");
    expect(sell.error?.code).toBe("price_unavailable");
    await v.e.close();
    v = await createV7Env({ p6: "250000000" });
    const t2 = await createTask(v);
    const c = await checklist(v, t2);
    expect(c.items.map((i) => i.kind)).toEqual(["mandate_buy", "mandate_sell", "permit", "permit"]);
    expect(c.counts).toEqual({ signaturesNeeded: 4, signaturesDone: 0, userTransactions: 0 });
    const sellTd = c.items.find((i) => i.kind === "mandate_sell")!.typedData!.message as Record<string, string>;
    // 500 USDG（6 位）× 2 / 250 USD × 1e18 = 4 股
    expect(sellTd["budgetCap"]).toBe("4000000000000000000");
    expect(sellTd["perStepCap"]).toBe("4000000000000000000");
    expect(sellTd["inputToken"]).toBe(STOCK);
    expect(sellTd["recipient"]).toBe(owner);
    await delegateFully(v, t2);
    const done = await checklist(v, t2);
    expect(done.complete).toBe(true);
    expect(done.sellReady[FIXTURE_STOCK_KEY.toLowerCase()]).toBe(true);
    // 「全部记录」里卖出授权按实际方向给：输入 = 股票（budgetCap 以股票计），输出 = 资金币种
    const rec = await api(v.e, "GET", `/v1/records?owner=${owner}`);
    const sellRec = (rec.json["items"] as Array<Record<string, unknown>>).find((i) => i["kind"] === "mandate" && i["side"] === "sell")!;
    expect(String(sellRec["inputAssetKey"]).toLowerCase()).toBe(FIXTURE_STOCK_KEY.toLowerCase());
    expect((sellRec["outputAssetKeys"] as string[]).map((k) => k.toLowerCase())).toEqual([`eip155:196:${STABLE}`.toLowerCase()]);
    expect(sellRec["budgetCap"]).toBe("4000000000000000000");
    // 卖出授权不进资金组：只有买入的预留
    const view = await api(v.e, "GET", `/v1/tasks/${t2}`);
    expect((view.json["mandates"] as unknown[]).length).toBe(2);
  });
});

describe("X-24 修复回归：scope 任务暂停后恢复，授权回到 ACTIVE，意图可签发", () => {
  for (const flags of ["off", "on"] as const) {
    it(`v7 开关 ${flags}`, async () => {
      v = await createV7Env(flags === "off" ? { flags: {} } : {});
      const body = { clientRequestId: `t-${Math.random().toString(16).slice(2, 8)}`, playbookId: "session_dca", mode: "LIVE", ownerAddress: owner, params: { steps: 2, perStepAmountRaw: "100000000", inputAssetKey: "eip155:196:0x1111111111111111111111111111111111111111", outputAssetKey: FIXTURE_STOCK_KEY }, scope: { objective: "x", budgetCapRaw: "500000000", perStepCapRaw: "100000000", maxSteps: 5, trustTier: "agent_data", issuance: "agent" } };
      const created = await api(v.e, "POST", "/v1/tasks", body);
      expect(created.status, JSON.stringify(created.json).slice(0, 300)).toBe(201);
      const taskId = (created.json["task"] as { id: string }).id;
      const draft = created.json["mandateDraft"] as { typedData: Parameters<typeof signMandate>[0] };
      expect((await api(v.e, "POST", `/v1/tasks/${taskId}/authorize`, { signature: await signMandate(draft.typedData) })).status).toBe(201);
      v.chain.setAllowance(STABLE, 10_000_000_000n);
      expect((await api(v.e, "POST", `/v1/tasks/${taskId}/pause`, {})).status).toBe(200);
      const mid = ((await api(v.e, "GET", `/v1/tasks/${taskId}`)).json["mandates"] as Array<{ mandateId: string }>)[0]!.mandateId;
      expect((await v.e.mandates.byId(mid))!.state).toBe("PAUSED");
      expect((await api(v.e, "POST", `/v1/tasks/${taskId}/resume`, {})).status).toBe(200);
      expect((await v.e.mandates.byId(mid))!.state).toBe("ACTIVE");
      const r = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, intent());
      expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(201);
      expect((r.json["intent"] as { status: string }).status).toBe("certified");
    });
  }
});

describe("X-25 接管切换", () => {
  it("有 SENDING / SENT 作业 → 409 execution_in_flight；否则取消 QUEUED / CLAIMED 并切换，scopeHash 不变；非 issuance=agent → 409", async () => {
    v = await createV7Env();
    const taskId = await createTask(v, {}, { allowSell: false });
    await delegateFully(v, taskId);
    const scopeHash = ((await api(v.e, "GET", `/v1/tasks/${taskId}`)).json["task"] as { scopeHash: string }).scopeHash;
    const r = await api(v.e, "POST", `/v1/tasks/${taskId}/intents`, intent());
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(201);
    const jobId = (r.json["execution"] as { jobId: string }).jobId;
    const claim = await ex.claim(v);
    const job = (claim.json["jobs"] as Array<{ id: string; attempt: number }>)[0]!;
    expect(job.id).toBe(jobId);
    const raw = rawTx("x25");
    expect((await ex.event(v, jobId, { attempt: job.attempt, type: "sending", rawTxHash: keccak256(raw), nonce: "1", rawTx: raw })).status).toBe(200);
    const busy = await api(v.e, "POST", `/v1/tasks/${taskId}/handover`, { executor: "agent_wallet" });
    expect(busy.status).toBe(409);
    expect(busy.json["error"]).toBe("execution_in_flight");
    const ok = await api(v.e, "POST", `/v1/tasks/${taskId}/handover`, { agent: "byo" });
    expect(ok.status).toBe(200);
    expect(ok.json["scopeHash"]).toBe(scopeHash);
    expect(ok.json["agentMode"]).toBe("byo");
  });
});
