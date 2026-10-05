/** v7 X6 · verify-executor：SEC-06 启动护栏、X-18 gas 低停止领取、串行主循环、发送提交点被拒不广播（X-10 执行器侧）、故障钩子（X-12 / X-13 / X-14 执行器侧）、崩溃恢复不重发 */
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { calldataHash, makePlanGuardDomain, mandateDigest, outputSetHash, stepDigest, type MandateStep, type StepCertificate, type TradeMandate } from "@chaconne/core/verify";
import { ExecSender, TOKEN_ABI, type ChainIO } from "@chaconne/verify-exec";
import { assertExecutorEnv, loadExecutorConfig } from "../src/config";
import { Executor, RECOVER_BACKOFF_MS } from "../src/executor";
import type { ClaimedJob, JobEvent, ServiceApi } from "../src/client";

/** 公开的 anvil 测试账户（仅测试） */
const EXEC_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const EXEC = privateKeyToAccount(EXEC_PK);
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const owner = OWNER.address.toLowerCase() as Hex;
const PG = "0x7777777777777777777777777777777777777777" as Hex;
const USDG = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8" as Hex;
const AAPL = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a" as Hex;
const OTHER = "0x1111111111111111111111111111111111111111" as Hex;
const sig65 = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
const T0 = 1_800_000_000;

const REG = JSON.stringify({ chainId: 196, entries: [{ tokenAddress: USDG, chainId: 196 }, { tokenAddress: AAPL, chainId: 196 }] });
const baseEnv = { VERIFY_EXECUTOR_API_KEY: "k", PLANGUARD_ADDRESS: PG, EXECUTOR_PRIVATE_KEY: EXEC_PK, REGISTRY_FILE: "/reg.json", EXECUTOR_MIN_OKB_WEI: "1000" };

describe("SEC-06 启动护栏", () => {
  it("只允许 EXECUTOR_PRIVATE_KEY；其它私钥形态变量拒启；okx_agentic 下连它也不许", () => {
    expect(() => assertExecutorEnv({ ...baseEnv })).not.toThrow();
    expect(() => assertExecutorEnv({ ...baseEnv, ATTESTATION_PRIVATE_KEY: "0x1" })).toThrow(/ATTESTATION_PRIVATE_KEY/);
    expect(() => assertExecutorEnv({ ...baseEnv, OKX_SECRET_KEY: "x" })).toThrow(/OKX_SECRET_KEY/);
    expect(() => assertExecutorEnv({ ...baseEnv, AGENT_MNEMONIC: "a b c" })).toThrow(/AGENT_MNEMONIC/);
    expect(() => assertExecutorEnv({ ...baseEnv, EXECUTOR_MODE: "okx_agentic" })).toThrow(/EXECUTOR_PRIVATE_KEY/);
  });
  it("执行身份地址属于禁止角色地址 → 拒启；错误信息不含私钥", () => {
    let msg = "";
    try {
      loadExecutorConfig({ ...baseEnv, FORBIDDEN_EXECUTOR_ADDRESSES: `${OTHER},${EXEC.address}` }, () => REG);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/禁止角色地址/);
    expect(msg).not.toContain(EXEC_PK.slice(2));
    const ok = loadExecutorConfig(baseEnv, () => REG);
    expect(ok.address).toBe(EXEC.address.toLowerCase());
    expect([...ok.tokens]).toEqual([USDG, AAPL]);
    expect(() => loadExecutorConfig({ ...baseEnv, REGISTRY_FILE: "" }, () => REG)).toThrow(/REGISTRY_FILE/);
    expect(() => loadExecutorConfig({ ...baseEnv, EXECUTOR_PRIVATE_KEY: "0x12" }, () => REG)).toThrow(/EXECUTOR_PRIVATE_KEY/);
  });
});

function readyBody(validUntil: number) {
  const routerCalldata = "0xabcdef01" as Hex;
  const outputSet = [AAPL];
  const mandate: TradeMandate = { owner, recipient: owner, inputToken: USDG, outputSetHash: outputSetHash(outputSet), budgetCap: "10000000", perStepCap: "2000000", maxSteps: "5", policyDefinitionHash: `0x${"aa".repeat(32)}`, effectivePolicyHash: `0x${"bb".repeat(32)}`, registryHash: `0x${"cc".repeat(32)}`, validFrom: String(T0 - 60), deadline: String(T0 + 86400), nonce: "7" };
  const domain = makePlanGuardDomain(196, PG);
  const step: MandateStep = { mandateDigest: mandateDigest(domain, mandate), stepIndex: "0", outputToken: AAPL, amountIn: "2000000", minAmountOut: "1", router: OTHER, spender: OTHER, calldataHash: calldataHash(routerCalldata), evidenceHash: `0x${"dd".repeat(32)}`, deadline: String(validUntil) };
  const certificate: StepCertificate = { stepDigest: stepDigest(domain, step), evidenceHash: step.evidenceHash, policyDefinitionHash: mandate.policyDefinitionHash, effectivePolicyHash: mandate.effectivePolicyHash, issuedAt: String(T0), validUntil: String(validUntil), signerEpoch: "1" };
  return { step, certificate, certificateSignature: sig65, routerCalldata, outputSet, planGuard: PG, mandate, mandateSignature: sig65 };
}
function stepJob(over: Partial<ClaimedJob> = {}, validUntil = T0 + 100): ClaimedJob {
  return { id: "exj_1", kind: "execute_step", state: "CLAIMED", attempt: 1, owner, token: USDG, taskId: "tsk_1", mandateId: "mnd_1", stepId: "stp_1", stepIndex: 0, validUntil: new Date(validUntil * 1000).toISOString(), leaseUntil: null, payload: { mandateId: "mnd_1", stepId: "stp_1", stepIndex: 0, validUntil: new Date(validUntil * 1000).toISOString(), ready: readyBody(validUntil) as unknown as Record<string, unknown> }, fault: null, rawTx: null, rawTxHash: null, txHash: null, ...over };
}

/** RPC 预估回退 CertificateNotYetValid()（选择器 0xe1344245）的错误形态：cause.data 带 revert data */
function notYetValid(): Error {
  return Object.assign(new Error("Execution reverted with reason: custom error 0xe1344245."), { cause: { data: "0xe1344245" } });
}
function fakeChain(over: Partial<ChainIO> = {}): ChainIO {
  return {
    chainId: 196,
    estimateGas: vi.fn(async () => 500_000n),
    fees: vi.fn(async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })),
    pendingNonce: vi.fn(async () => 0),
    sendRawTransaction: vi.fn(async (raw: Hex) => keccak256(raw)),
    getReceipt: vi.fn(async () => ({ status: "success" as const, blockNumber: 10n, logs: [] })),
    hasTransaction: vi.fn(async () => false),
    mandateState: vi.fn(async () => ({ spent: 0n, steps: 0, revoked: false })),
    allowance: vi.fn(async () => 10_000_000n),
    balanceOf: vi.fn(async () => 10_000_000n),
    nonces: vi.fn(async () => 3n),
    call: vi.fn(async () => null),
    nativeBalance: vi.fn(async () => 10n ** 18n),
    head: vi.fn(async () => ({ number: 100n, timestamp: BigInt(T0) })),
    ...over,
  };
}
function fakeApi(jobs: ClaimedJob[][], respond: (e: JobEvent) => { status: number; body: Record<string, unknown> } = () => ({ status: 200, body: {} })) {
  const events: JobEvent[] = [];
  const api: ServiceApi & { events: JobEvent[] } = {
    events,
    claim: vi.fn(async () => {
      const next = jobs.shift() ?? [];
      return { status: next.length ? 200 : 204, jobs: next };
    }),
    event: vi.fn(async (_id: string, _a: number, e: JobEvent) => {
      events.push(e);
      return respond(e);
    }),
    heartbeat: vi.fn(async () => ({ status: 204 })),
  };
  return api;
}
function mk(api: ServiceApi, chain: ChainIO, nowRef = { t: T0 * 1000 }) {
  const sender = new ExecSender(EXEC, chain, { profile: "hosted", planGuard: PG, tokens: new Set([USDG, AAPL]) });
  const sleeps: number[] = [];
  const ex = new Executor({ api, chain, sender, planGuard: PG, minCertRemainingS: 8, minOkbWei: 1000n, mode: "eoa", version: "t", now: () => nowRef.t, sleep: async (ms) => { sleeps.push(ms); nowRef.t += ms; }, log: () => undefined });
  return { ex, sleeps, nowRef };
}

describe("execute_step 主路径与发送提交点", () => {
  it("预检 → 签名 → sending（带 rawTx / rawTxHash / nonce）→ 广播 → sent → receipt", async () => {
    const api = fakeApi([[stepJob()]]);
    const chain = fakeChain();
    const { ex } = mk(api, chain);
    expect(await ex.tick()).toBe("confirmed");
    expect(api.events.map((e) => e.type)).toEqual(["sending", "sent", "receipt"]);
    const sending = api.events[0] as Extract<JobEvent, { type: "sending" }>;
    expect(sending.rawTxHash).toBe(keccak256(sending.rawTx!));
    expect(sending.nonce).toBe("0");
    expect((api.events[1] as Extract<JobEvent, { type: "sent" }>).txHash).toBe(sending.rawTxHash);
    expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await ex.tick()).toBeNull(); // 没作业
  });
  it("X-10 执行器侧：sending 被拒（409 not_allowed_now）→ 广播数 0，nonce 退回", async () => {
    const api = fakeApi([[stepJob()], [stepJob({ id: "exj_2" })]], (e) => (e.type === "sending" ? { status: 409, body: { error: "not_allowed_now", code: "task_paused" } } : { status: 200, body: {} }));
    const chain = fakeChain();
    const { ex } = mk(api, chain);
    expect(await ex.tick()).toBe("refused");
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    expect(await ex.tick()).toBe("refused");
    expect((api.events[1] as Extract<JobEvent, { type: "sending" }>).nonce).toBe("0"); // 退回的 nonce 被复用
  });
  it("链上预检：步序不符 / 已撤销 / 额度不足 / 余额不足 / 本地核对失败 / 预估回退 → preflight_failed，不签名", async () => {
    const cases: Array<[Partial<ChainIO>, string]> = [
      [{ mandateState: vi.fn(async () => ({ spent: 0n, steps: 1, revoked: false })) }, "step_index_mismatch"],
      [{ mandateState: vi.fn(async () => ({ spent: 0n, steps: 0, revoked: true })) }, "mandate_revoked"],
      [{ allowance: vi.fn(async () => 1n) }, "allowance_low"],
      [{ balanceOf: vi.fn(async () => 1n) }, "balance_low"],
      [{ estimateGas: vi.fn(async () => { throw new Error("The contract function reverted. Error: InsufficientOutput(uint256 received, uint256 minOut)"); }) }, "would_revert"],
    ];
    for (const [over, code] of cases) {
      const api = fakeApi([[stepJob()]]);
      const chain = fakeChain(over);
      const { ex } = mk(api, chain);
      expect(await ex.tick()).toBe("preflight_failed");
      const e = api.events[0] as Extract<JobEvent, { type: "preflight_failed" }>;
      expect(e.code).toBe(code);
      if (code === "would_revert") expect(e.revert?.cls).toBe("replan");
      expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    }
    const api = fakeApi([[stepJob({}, T0 + 5)]]);
    const { ex } = mk(api, fakeChain());
    expect(await ex.tick()).toBe("preflight_failed");
    expect((api.events[0] as Extract<JobEvent, { type: "preflight_failed" }>).code).toBe("cert_remaining_low");
  });
  it("wait_clock：链头时间戳落后于证书 issuedAt → 先等链上时钟再预检；CertificateNotYetValid 回退 → 等待重试（≤ 3 次），不上报失败", async () => {
    // 链头比 issuedAt 晚 3 s：先等，不预估
    let ts = T0 - 3;
    const head = vi.fn(async () => ({ number: 100n, timestamp: BigInt(ts++) }));
    const api = fakeApi([[stepJob()]]);
    const chain = fakeChain({ head });
    const { ex, sleeps } = mk(api, chain);
    expect(await ex.tick()).toBe("confirmed");
    expect(sleeps.filter((ms) => ms === 1000).length).toBeGreaterThanOrEqual(3);
    expect(api.events.map((e) => e.type)).toEqual(["sending", "sent", "receipt"]);
    // 预估两次回退 CertificateNotYetValid（0xe1344245）后通过
    let n = 0;
    const est = vi.fn(async () => {
      if (n++ < 2) throw notYetValid();
      return 500_000n;
    });
    const api2 = fakeApi([[stepJob()]]);
    const { ex: ex2 } = mk(api2, fakeChain({ estimateGas: est }));
    expect(await ex2.tick(), JSON.stringify(api2.events)).toBe("confirmed");
    expect(est).toHaveBeenCalledTimes(3);
    // 三次都回退 → preflight_failed（cls wait_clock）
    const api3 = fakeApi([[stepJob()]]);
    const { ex: ex3 } = mk(api3, fakeChain({ estimateGas: vi.fn(async () => { throw notYetValid(); }) }));
    expect(await ex3.tick()).toBe("preflight_failed");
    expect((api3.events[0] as Extract<JobEvent, { type: "preflight_failed" }>).revert?.cls).toBe("wait_clock");
  });
  it("X-12 执行器侧 cert_void：等到证书剩余 < 8 s 才走提交点（服务端会拒并 EXPIRED）", async () => {
    const api = fakeApi([[stepJob({ fault: { kind: "cert_void", createdAt: "x", by: "op" } })]], (e) => (e.type === "sending" ? { status: 409, body: { error: "not_allowed_now", code: "cert_remaining_low" } } : { status: 200, body: {} }));
    const chain = fakeChain();
    const { ex, nowRef } = mk(api, chain);
    expect(await ex.tick()).toBe("refused");
    expect(T0 + 100 - Math.floor(nowRef.t / 1000)).toBeLessThan(8);
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("X-13 执行器侧 receipt_delay：sent 之后 90 s 不查回执", async () => {
    const api = fakeApi([[stepJob({ fault: { kind: "receipt_delay", createdAt: "x", by: "op" } })]]);
    const chain = fakeChain();
    const { ex, sleeps } = mk(api, chain);
    await ex.tick();
    expect(sleeps[0]).toBe(90_000);
    expect(api.events.map((e) => e.type)).toEqual(["sending", "sent", "receipt"]);
  });
  it("X-14 执行器侧 rpc_timeout：广播后断连 → 重启后按 rawTxHash 找回 → 报 sent / receipt，不重发", async () => {
    const api = fakeApi([[stepJob({ fault: { kind: "rpc_timeout", createdAt: "x", by: "op" } })]]);
    const chain = fakeChain();
    const { ex } = mk(api, chain);
    expect(await ex.tick()).toBe("crashed");
    expect(api.events.map((e) => e.type)).toEqual(["sending"]);
    const sending = api.events[0] as Extract<JobEvent, { type: "sending" }>;
    // 新进程：服务端把 SENDING 作业带回（recover）
    const api2 = fakeApi([[stepJob({ state: "SENDING", recover: true, rawTx: sending.rawTx!, rawTxHash: sending.rawTxHash! })]]);
    const { ex: ex2, sleeps } = mk(api2, chain);
    expect(await ex2.tick()).toBe("recovered");
    expect(api2.events.map((e) => e.type)).toEqual(["sent", "receipt"]);
    expect(chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    // 服务端在 6 确认前会反复带回同一 SENT 作业：每次处理后退避（e2e 分叉上发现的 claim → receipt 空转）
    expect(sleeps).toContain(RECOVER_BACKOFF_MS);
  });
  it("恢复：交易未见、证书仍有效、服务端同意 → 原样重播；不同意 → 交给对账器", async () => {
    const chain = fakeChain({ getReceipt: vi.fn(async () => null), hasTransaction: vi.fn(async () => false) });
    const raw = "0x02f8" as Hex;
    const api = fakeApi([[stepJob({ state: "SENDING", recover: true, rawTx: raw, rawTxHash: keccak256(raw) })]]);
    const { ex } = mk(api, chain);
    expect(await ex.tick()).toBe("sent");
    expect(chain.sendRawTransaction).toHaveBeenCalledWith(raw);
    const chain2 = fakeChain({ getReceipt: vi.fn(async () => null) });
    const api2 = fakeApi([[stepJob({ state: "SENDING", recover: true, rawTx: raw, rawTxHash: keccak256(raw) })]], () => ({ status: 409, body: { error: "not_allowed_now" } }));
    const { ex: ex2 } = mk(api2, chain2);
    expect(await ex2.tick()).toBe("waiting");
    expect(chain2.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("permit 作业", () => {
  const permitJob = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({ id: "exj_p", kind: "permit", state: "CLAIMED", attempt: 1, owner, token: USDG, taskId: "tsk_1", mandateId: null, stepId: null, stepIndex: null, validUntil: null, leaseUntil: null, payload: { permitId: "prm_1", owner, token: USDG, spender: PG, value: "10050000", nonce: "3", deadline: String(T0 + 1800), signature: sig65 }, fault: null, rawTx: null, rawTxHash: null, txHash: null, ...over });
  it("nonce 一致 → 干跑 → sending → 广播 → sent → receipt 附 Approval", async () => {
    const topics = encodeEventTopics({ abi: TOKEN_ABI, eventName: "Approval", args: { owner, spender: PG } }) as Hex[];
    const chain = fakeChain({ getReceipt: vi.fn(async () => ({ status: "success" as const, blockNumber: 11n, logs: [{ address: USDG, topics, data: encodeAbiParameters([{ type: "uint256" }], [10050000n]) }] })) });
    const api = fakeApi([[permitJob()]]);
    const { ex } = mk(api, chain);
    expect(await ex.tick()).toBe("confirmed");
    const r = api.events[2] as Extract<JobEvent, { type: "receipt" }>;
    expect(r.approval).toEqual({ owner, spender: PG, value: "10050000" });
  });
  it("nonce 已变 / deadline 太近 / 干跑回退 → preflight_failed；permit 的 owner 不是作业 owner → 白名单拒绝", async () => {
    for (const [over, chainOver, code] of [[{}, { nonces: vi.fn(async () => 4n) }, "permit_nonce_stale"], [{ payload: { ...(permitJob().payload as object), deadline: String(T0 + 60) } }, {}, "permit_deadline_near"], [{}, { call: vi.fn(async () => { throw new Error("EIP2612: invalid signature"); }) }, "permit_would_revert"], [{ owner: OTHER }, {}, "permit_owner_mismatch"]] as Array<[Partial<ClaimedJob>, Partial<ChainIO>, string]>) {
      const api = fakeApi([[permitJob(over)]]);
      const chain = fakeChain(chainOver);
      const { ex } = mk(api, chain);
      expect(await ex.tick()).toBe("preflight_failed");
      expect((api.events[0] as Extract<JobEvent, { type: "preflight_failed" }>).code).toBe(code);
      expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    }
  });
});

describe("X-18 gas 低于阈值 → 停止领取；实例冲突 → 退出", () => {
  it("gas 低：心跳上报余额，之后 tick 不再 claim", async () => {
    const api = fakeApi([[stepJob()]]);
    const chain = fakeChain({ nativeBalance: vi.fn(async () => 5n) });
    const { ex } = mk(api, chain);
    await ex.heartbeat();
    expect(ex.isGasLow).toBe(true);
    expect((api.heartbeat as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ gasBalanceWei: "5", mode: "eoa", executor: EXEC.address.toLowerCase() });
    expect(await ex.tick()).toBeNull();
    expect(api.claim).not.toHaveBeenCalled();
  });
  it("claim 或心跳回 409 executor_instance_conflict → 停止", async () => {
    const api = fakeApi([]);
    (api.heartbeat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 409, error: "executor_instance_conflict" });
    const { ex } = mk(api, fakeChain());
    await ex.heartbeat();
    expect(ex.instanceConflict).toBe(true);
    expect(await ex.tick()).toBeNull();
  });
});

describe("D-089 修订：低余额阈值必须显式配置；每笔费用上限", () => {
  it("eoa 模式缺 EXECUTOR_MIN_OKB_WEI / 为 0 / 非整数 → 拒绝启动", () => {
    const { EXECUTOR_MIN_OKB_WEI: _omit, ...noMin } = baseEnv;
    void _omit;
    expect(() => loadExecutorConfig(noMin, () => REG)).toThrow(/EXECUTOR_MIN_OKB_WEI 未配置/);
    expect(() => loadExecutorConfig({ ...baseEnv, EXECUTOR_MIN_OKB_WEI: "0" }, () => REG)).toThrow(/EXECUTOR_MIN_OKB_WEI 必须是大于 0/);
    expect(() => loadExecutorConfig({ ...baseEnv, EXECUTOR_MIN_OKB_WEI: "1e15" }, () => REG)).toThrow(/EXECUTOR_MIN_OKB_WEI/);
    expect(loadExecutorConfig(baseEnv, () => REG).minOkbWei).toBe(1000n);
  });
  it("费用上限从 env 读取（缺省保守值）；非法值拒启", () => {
    const c = loadExecutorConfig(baseEnv, () => REG);
    expect(c.feeCaps.maxFeePerTx).toBe(200_000_000_000_000n);
    expect(loadExecutorConfig({ ...baseEnv, EXECUTOR_MAX_FEE_PER_GAS_WEI: "50000000" }, () => REG).feeCaps.maxFeePerGas).toBe(50_000_000n);
    expect(() => loadExecutorConfig({ ...baseEnv, EXECUTOR_MAX_GAS_LIMIT: "-1" }, () => REG)).toThrow(/EXECUTOR_MAX_GAS_LIMIT/);
  });
  it("RPC 给的费率超上限 → preflight_failed fee_cap_exceeded，不签名、不走提交点、不广播", async () => {
    const api = fakeApi([[stepJob()]]);
    const chain = fakeChain({ fees: vi.fn(async () => ({ maxFeePerGas: 10n ** 12n, maxPriorityFeePerGas: 1n })) });
    const { ex } = mk(api, chain);
    expect(await ex.tick()).toBe("preflight_failed");
    expect(api.events.map((e) => e.type)).toEqual(["preflight_failed"]);
    expect((api.events[0] as Extract<JobEvent, { type: "preflight_failed" }>).code).toBe("fee_cap_exceeded");
    expect(chain.pendingNonce).not.toHaveBeenCalled();
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });
});
