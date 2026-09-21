/** 链上回执核实器（O-05 / W-04 服务端）：不信任客户端成功声明，只按回执 + Guard 事件 + 确认数推进 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { T_REGULAR } from "@chaconne/core/verify/fixtures";
import { GUARD_ABI } from "../src/execution/guardAbi";
import { decideReceipt, verifyReceiptsOnce, type ChainReceipt, type ReceiptSource } from "../src/execution/receipts";
import { api, createTestEnv, jobBody, TEST_GUARD } from "./helpers";

const TX = ("0x" + "ab".repeat(32)) as Hex;
const OWNER = "0x1111111111111111111111111111111111111111";

function guardLog(intentDigest: Hex, address = TEST_GUARD) {
  const topics = encodeEventTopics({ abi: GUARD_ABI, eventName: "GuardedExecution", args: { owner: OWNER, recipient: OWNER, nonce: 7n } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [intentDigest, ("0x" + "11".repeat(32)) as Hex, ("0x" + "22".repeat(32)) as Hex, ("0x" + "33".repeat(32)) as Hex, "0x5555555555555555555555555555555555555555", 5_000_000n, 5_000_000n, 14_983_578_260_014_962n, 0n],
  );
  return { address, data, topics };
}
function receipt(over: Partial<ChainReceipt> = {}): ChainReceipt {
  return { status: "success", blockNumber: 100n, blockHash: "0x" + "cd".repeat(32), gasUsed: 551_123n, logs: [], ...over };
}
function source(r: ChainReceipt | null, head: bigint): ReceiptSource & { calls: number } {
  const s = { calls: 0, getReceipt: async () => (s.calls++, r), headBlock: async () => head };
  return s;
}

async function submittedAttempt() {
  const env = await createTestEnv();
  const created = await api(env, "POST", "/v1/jobs", jobBody());
  const jobId = created.json["jobId"] as string;
  const prep = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "r1" });
  expect(prep.status).toBe(200);
  const attemptId = prep.json["attemptId"] as string;
  const intentDigest = (prep.json["execution"] as { intentDigest: Hex }).intentDigest;
  const sub = await api(env, "POST", `/v1/jobs/${jobId}/submissions`, { attemptId, txHash: TX });
  expect(sub.status).toBe(202);
  const opts = { guard: TEST_GUARD, confirmations: 6, unknownAfterMs: 10 * 60_000, now: () => new Date(env.cfgNow()) };
  return { env, jobId, attemptId, intentDigest, opts };
}

async function state(env: Awaited<ReturnType<typeof createTestEnv>>, jobId: string) {
  const j = await api(env, "GET", `/v1/jobs/${jobId}`);
  const e = (j.json["executions"] as Array<{ state: string; receipt: Record<string, unknown> | null }>)[0]!;
  return e;
}

describe("receipt verifier", () => {
  it("回执缺失：短期不变，超时后 UNKNOWN，之后找到回执仍能推进到 CONFIRMED", async () => {
    const { env, jobId, intentDigest, opts } = await submittedAttempt();
    let r = await verifyReceiptsOnce(env.service, source(null, 200n), opts);
    expect(r).toEqual({ checked: 1, updated: 0 });
    expect((await state(env, jobId)).state).toBe("SUBMITTED");

    env.setNow(new Date(new Date(T_REGULAR).getTime() + 11 * 60_000).toISOString());
    r = await verifyReceiptsOnce(env.service, source(null, 200n), opts);
    expect(r.updated).toBe(1);
    let e = await state(env, jobId);
    expect(e.state).toBe("UNKNOWN");
    expect(e.receipt?.["reason"]).toBe("receipt_not_found");

    r = await verifyReceiptsOnce(env.service, source(receipt({ logs: [guardLog(intentDigest)] }), 200n), opts);
    expect(r.updated).toBe(1);
    e = await state(env, jobId);
    expect(e.state).toBe("CONFIRMED");
    expect((e.receipt?.["event"] as { received: string }).received).toBe("14983578260014962");
    expect(e.receipt?.["confirmations"]).toBe(101);
    // 终态不再复查
    const s = source(null, 300n);
    expect(await verifyReceiptsOnce(env.service, s, opts)).toEqual({ checked: 0, updated: 0 });
    expect(s.calls).toBe(0);
    await env.close();
  });

  it("回执 reverted → REVERTED（终态）", async () => {
    const { env, jobId, opts } = await submittedAttempt();
    await verifyReceiptsOnce(env.service, source(receipt({ status: "reverted" }), 200n), opts);
    const e = await state(env, jobId);
    expect(e.state).toBe("REVERTED");
    expect(e.receipt?.["status"]).toBe("reverted");
    await env.close();
  });

  it("确认数不足 → REORG_PENDING；足够 → CONFIRMED；回执消失 → 回到 SUBMITTED", async () => {
    const { env, jobId, intentDigest, opts } = await submittedAttempt();
    const ok = receipt({ logs: [guardLog(intentDigest)] });
    await verifyReceiptsOnce(env.service, source(ok, 102n), opts);
    let e = await state(env, jobId);
    expect(e.state).toBe("REORG_PENDING");
    expect(e.receipt?.["confirmations"]).toBe(3);

    await verifyReceiptsOnce(env.service, source(null, 103n), opts);
    e = await state(env, jobId);
    expect(e.state).toBe("SUBMITTED");
    expect(e.receipt?.["reason"]).toBe("receipt_vanished_after_reorg");

    await verifyReceiptsOnce(env.service, source({ ...ok, blockNumber: 104n }, 109n), opts);
    e = await state(env, jobId);
    expect(e.state).toBe("CONFIRMED");
    expect(e.receipt?.["blockNumber"]).toBe("104");
    await env.close();
  });

  it("成功回执但事件缺失 / intentDigest 不符 / 事件来自别的合约 → UNKNOWN 带原因，不记 CONFIRMED", async () => {
    const { env, jobId, intentDigest, opts } = await submittedAttempt();
    await verifyReceiptsOnce(env.service, source(receipt(), 200n), opts);
    let e = await state(env, jobId);
    expect(e.state).toBe("UNKNOWN");
    expect(e.receipt?.["reason"]).toBe("guard_event_missing");

    const other = ("0x" + "99".repeat(32)) as Hex;
    await verifyReceiptsOnce(env.service, source(receipt({ logs: [guardLog(other)] }), 200n), opts);
    e = await state(env, jobId);
    expect(e.state).toBe("UNKNOWN");
    expect(e.receipt?.["reason"]).toBe("intent_digest_mismatch");

    // 同一原因不重复写；事件来自非 Guard 地址等同缺失
    const r = await verifyReceiptsOnce(env.service, source(receipt({ logs: [guardLog(intentDigest, "0x7777777777777777777777777777777777777777")] }), 200n), opts);
    expect(r.updated).toBe(1);
    e = await state(env, jobId);
    expect(e.receipt?.["reason"]).toBe("guard_event_missing");
    await env.close();
  });

  it("decideReceipt 纯函数：REORG_PENDING 重复检查刷新确认数；UNKNOWN 同原因不重复", () => {
    const base = { id: "exe_x", state: "REORG_PENDING", txHash: TX, intentDigest: "0x" + "aa".repeat(32), updatedAt: new Date(T_REGULAR), receiptJson: null };
    const opts = { guard: TEST_GUARD, confirmations: 6, unknownAfterMs: 1000, now: () => new Date(T_REGULAR) };
    const ok = receipt({ logs: [guardLog(base.intentDigest as Hex)] });
    expect(decideReceipt(base, ok, 103n, opts)?.state).toBe("REORG_PENDING");
    expect(decideReceipt(base, ok, 105n, opts)?.state).toBe("CONFIRMED");
    expect(decideReceipt({ ...base, state: "UNKNOWN", receiptJson: { reason: "guard_event_missing" } }, receipt(), 105n, opts)).toBeNull();
    expect(decideReceipt({ ...base, state: "UNKNOWN" }, null, 105n, opts)).toBeNull();
  });
});
