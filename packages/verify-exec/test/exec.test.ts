/** v7 X5 · verify-exec：X-17 执行身份白名单（签名前拒绝）、本地核对、串行 nonce、预检回退解码 */
import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { calldataHash, makePlanGuardDomain, mandateDigest, outputSetHash, stepDigest, type MandateStep, type StepCertificate, type TradeMandate } from "@chaconne/core/verify";
import { assertTxAllowed, buildApproveTx, buildExecuteStepTx, buildPermitTx, checkReadyStep, DEFAULT_FEE_CAPS, ExecSender, ExecTxError, maxFeeOfRawTx, parseFeeCaps, EXECUTE_STEP_SELECTOR, PLANGUARD_ABI, SerialNonceManager, WouldRevertError, type ChainIO, type TxPolicy } from "../src";

/** 公开的 anvil 测试账户（仅测试） */
const EXEC = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const PG = "0x7777777777777777777777777777777777777777" as Hex;
const USDG = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8" as Hex;
const AAPL = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a" as Hex;
const OTHER = "0x1111111111111111111111111111111111111111" as Hex;
const hosted: TxPolicy = { profile: "hosted", planGuard: PG, tokens: new Set([USDG, AAPL]) };
const agentWallet: TxPolicy = { profile: "agent_wallet", planGuard: PG };
const sig65 = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
const owner = OWNER.address.toLowerCase() as Hex;

function readyFixture(nowSec: number) {
  const routerCalldata = "0xabcdef01" as Hex;
  const outputSet = [AAPL];
  const mandate: TradeMandate = { owner, recipient: owner, inputToken: USDG, outputSetHash: outputSetHash(outputSet), budgetCap: "10000000", perStepCap: "2000000", maxSteps: "5", policyDefinitionHash: `0x${"aa".repeat(32)}`, effectivePolicyHash: `0x${"bb".repeat(32)}`, registryHash: `0x${"cc".repeat(32)}`, validFrom: String(nowSec - 60), deadline: String(nowSec + 86400), nonce: "7" };
  const domain = makePlanGuardDomain(196, PG);
  const step: MandateStep = { mandateDigest: mandateDigest(domain, mandate), stepIndex: "0", outputToken: AAPL, amountIn: "2000000", minAmountOut: "1", router: OTHER, spender: OTHER, calldataHash: calldataHash(routerCalldata), evidenceHash: `0x${"dd".repeat(32)}`, deadline: String(nowSec + 100) };
  const certificate: StepCertificate = { stepDigest: stepDigest(domain, step), evidenceHash: step.evidenceHash, policyDefinitionHash: mandate.policyDefinitionHash, effectivePolicyHash: mandate.effectivePolicyHash, issuedAt: String(nowSec), validUntil: String(nowSec + 100), signerEpoch: "1" };
  return { step, certificate, certificateSignature: sig65, routerCalldata, outputSet, planGuard: PG, mandate, mandateSignature: sig65 };
}

describe("X-17 执行身份白名单：非白名单 to / selector 或 value ≠ 0 → 签名前拒绝", () => {
  const r = readyFixture(1_000_000);
  const exec = buildExecuteStepTx({ planGuard: PG, mandate: r.mandate as unknown as Record<string, string>, mandateSignature: r.mandateSignature, outputSet: r.outputSet, step: r.step as unknown as Record<string, string>, certificate: r.certificate as unknown as Record<string, string>, certificateSignature: r.certificateSignature, routerCalldata: r.routerCalldata });
  const permit = buildPermitTx({ token: USDG, owner, spender: PG, value: 5n, deadline: 99n, signature: sig65 });
  const expectCode = (f: () => unknown, code: string) => {
    try {
      f();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ExecTxError);
      expect((e as ExecTxError).code).toBe(code);
    }
  };
  it("hosted：executeStep 与登记代币 permit（owner = 作业 owner、spender = PlanGuard）放行", () => {
    expect(exec.data.slice(0, 10)).toBe(EXECUTE_STEP_SELECTOR);
    expect(assertTxAllowed(exec, hosted)).toBe("execute_step");
    expect(assertTxAllowed(permit, hosted, { jobOwner: owner })).toBe("permit");
  });
  it("hosted：approve、transfer、非登记代币、非 PlanGuard spender、错 owner、value ≠ 0、PlanGuard 其它函数全部拒绝", () => {
    expectCode(() => assertTxAllowed(buildApproveTx({ token: USDG, spender: PG, amount: 1n }), hosted), "tx_selector_not_allowed");
    const transfer = { to: USDG, data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [OTHER, 1n] }), value: 0n };
    expectCode(() => assertTxAllowed(transfer, hosted), "tx_selector_not_allowed");
    expectCode(() => assertTxAllowed({ ...permit, to: OTHER }, hosted, { jobOwner: owner }), "tx_to_not_allowed");
    expectCode(() => assertTxAllowed(buildPermitTx({ token: USDG, owner, spender: OTHER, value: 5n, deadline: 99n, signature: sig65 }), hosted, { jobOwner: owner }), "permit_spender_not_planguard");
    expectCode(() => assertTxAllowed(permit, hosted, { jobOwner: OTHER }), "permit_owner_mismatch");
    expectCode(() => assertTxAllowed(permit, hosted, {}), "permit_owner_mismatch");
    expectCode(() => assertTxAllowed({ ...exec, value: 1n }, hosted), "tx_value_not_zero");
    const revoke = { to: PG, data: encodeFunctionData({ abi: PLANGUARD_ABI, functionName: "pause", args: [] }), value: 0n };
    expectCode(() => assertTxAllowed(revoke, hosted), "tx_selector_not_allowed");
    expectCode(() => assertTxAllowed({ to: OTHER, data: exec.data, value: 0n }, hosted), "tx_to_not_allowed");
  });
  it("agent_wallet：executeStep + approve(PlanGuard) 放行（沿用现有行为）；approve 给别人、permit 拒绝", () => {
    expect(assertTxAllowed(exec, agentWallet)).toBe("execute_step");
    expect(assertTxAllowed(buildApproveTx({ token: USDG, spender: PG, amount: 1n }), agentWallet)).toBe("approve");
    expectCode(() => assertTxAllowed(buildApproveTx({ token: USDG, spender: OTHER, amount: 1n }), agentWallet), "approve_spender_not_planguard");
    expectCode(() => assertTxAllowed(permit, agentWallet), "tx_selector_not_allowed");
  });
  it("白名单拒绝时 ExecSender 不预估、不取 nonce、不签名", async () => {
    const chain = fakeChain();
    const signSpy = vi.spyOn(EXEC, "signTransaction");
    const s = new ExecSender(EXEC, chain, hosted);
    await expect(s.sign(buildApproveTx({ token: USDG, spender: PG, amount: 1n }))).rejects.toBeInstanceOf(ExecTxError);
    expect(chain.estimateGas).not.toHaveBeenCalled();
    expect(chain.pendingNonce).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
    signSpy.mockRestore();
  });
});

function fakeChain(over: Partial<ChainIO> = {}): ChainIO & { [K in keyof ChainIO]: ChainIO[K] } {
  const c: ChainIO = {
    chainId: 196,
    estimateGas: vi.fn(async () => 100_000n),
    fees: vi.fn(async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })),
    pendingNonce: vi.fn(async () => 5),
    sendRawTransaction: vi.fn(async (raw: Hex) => keccak256(raw)),
    getReceipt: vi.fn(async () => null),
    hasTransaction: vi.fn(async () => false),
    mandateState: vi.fn(async () => ({ spent: 0n, steps: 0, revoked: false })),
    allowance: vi.fn(async () => 0n),
    balanceOf: vi.fn(async () => 0n),
    nonces: vi.fn(async () => 0n),
    call: vi.fn(async () => null),
    nativeBalance: vi.fn(async () => 0n),
    head: vi.fn(async () => ({ number: 1n, timestamp: 1n })),
    ...over,
  };
  return c;
}

describe("发送器：预检回退解码、签名不广播、nonce 串行与重同步", () => {
  const r = readyFixture(1_000_000);
  const exec = buildExecuteStepTx({ planGuard: PG, mandate: r.mandate as unknown as Record<string, string>, mandateSignature: r.mandateSignature, outputSet: r.outputSet, step: r.step as unknown as Record<string, string>, certificate: r.certificate as unknown as Record<string, string>, certificateSignature: r.certificateSignature, routerCalldata: r.routerCalldata });
  it("estimateGas 回退 → WouldRevertError 带失败分类，不取 nonce", async () => {
    const data = encodeErrorResult({ abi: parseAbi(["error CertificateExpired()"]), errorName: "CertificateExpired" });
    const chain = fakeChain({ estimateGas: vi.fn(async () => { throw Object.assign(new Error("execution reverted"), { data }); }) });
    const s = new ExecSender(EXEC, chain, hosted);
    const err = await s.sign(exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WouldRevertError);
    expect((err as WouldRevertError).revert).toMatchObject({ cls: "retry_new_cert", error: "CertificateExpired" });
    expect(chain.pendingNonce).not.toHaveBeenCalled();
  });
  it("签名得到 rawTx / rawTxHash / nonce（gas ×1.3），广播前不发；放弃退回 nonce；nonce too low → 重同步", async () => {
    const chain = fakeChain();
    const s = new ExecSender(EXEC, chain, hosted);
    const a = await s.sign(exec);
    expect(a.nonce).toBe(5);
    expect(a.gas).toBe(130_000n);
    expect(a.rawTxHash).toBe(keccak256(a.rawTx));
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    s.abandon(a);
    const b = await s.sign(exec);
    expect(b.nonce).toBe(5);
    expect(await s.broadcast(b)).toBe(b.rawTxHash);
    const c = await s.sign(exec);
    expect(c.nonce).toBe(6);
    (chain.sendRawTransaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nonce too low"));
    (chain.pendingNonce as ReturnType<typeof vi.fn>).mockResolvedValueOnce(9);
    await expect(s.broadcast(c)).rejects.toThrow(/nonce too low/);
    expect(s.nonces.peek()).toBe(9);
    // 已在链上（崩溃前其实广播过）→ 视为成功
    const d = await s.sign(exec);
    (chain.sendRawTransaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("already known"));
    (chain.hasTransaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    expect(await s.broadcast(d)).toBe(d.rawTxHash);
  });
  it("SerialNonceManager 只退回最近一个", async () => {
    const m = new SerialNonceManager({ pendingNonce: async () => 3 });
    expect(await m.take()).toBe(3);
    expect(await m.take()).toBe(4);
    m.release(3);
    expect(m.peek()).toBe(5);
    m.release(4);
    expect(m.peek()).toBe(4);
  });
});

describe("本地核对", () => {
  const now = 1_000_000;
  const opts = { chainId: 196, planGuard: PG, nowSec: now, minRemainingS: 8, expectedOwner: owner };
  it("正常 READY 体通过", () => {
    const r = readyFixture(now);
    const c = checkReadyStep(r, opts);
    expect(c.problems).toEqual([]);
    expect(c.ok).toBe(true);
  });
  it("篡改步骤 / calldata / 输出集 / PlanGuard / 链 id / owner、证书剩余不足 → 问题列表", () => {
    const r = readyFixture(now);
    expect(checkReadyStep({ ...r, step: { ...r.step, amountIn: "1999999" } }, opts).problems).toContain("certificate.stepDigest ≠ recomputed step digest");
    expect(checkReadyStep({ ...r, routerCalldata: "0xabcdef02" }, opts).problems).toContain("calldataHash ≠ keccak(routerCalldata)");
    expect(checkReadyStep({ ...r, outputSet: [USDG] }, opts).problems).toEqual(expect.arrayContaining(["outputSet hash ≠ mandate.outputSetHash", "step.outputToken not in outputSet"]));
    expect(checkReadyStep({ ...r, planGuard: OTHER }, opts).problems[0]).toMatch(/planGuard/);
    expect(checkReadyStep(r, { ...opts, chainId: 1952 }).ok).toBe(false);
    expect(checkReadyStep(r, { ...opts, expectedOwner: OTHER }).problems).toContain("mandate.owner ≠ job owner");
    const late = checkReadyStep(r, { ...opts, nowSec: now + 93 });
    expect(late.certRemainingLow).toBe(true);
    expect(checkReadyStep(r, { ...opts, nowSec: now + 92 }).ok).toBe(true);
  });
});

describe("D-089 修订：每笔费用上限（签名前强制，超限不取 nonce、不签名）", () => {
  const r = readyFixture(1_000_000);
  const exec = buildExecuteStepTx({ planGuard: PG, mandate: r.mandate as unknown as Record<string, string>, mandateSignature: r.mandateSignature, outputSet: r.outputSet, step: r.step as unknown as Record<string, string>, certificate: r.certificate as unknown as Record<string, string>, certificateSignature: r.certificateSignature, routerCalldata: r.routerCalldata });
  const caps = { maxGasLimit: 1_000_000n, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 10_000_000n, maxFeePerTx: 50_000_000_000_000n };
  const refused = async (chain: ChainIO, sub: string) => {
    const s = new ExecSender(EXEC, chain, hosted, { feeCaps: caps });
    const err = await s.sign(exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecTxError);
    expect((err as ExecTxError).code).toBe("fee_cap_exceeded");
    expect((err as ExecTxError).message).toMatch(sub);
    expect(chain.pendingNonce).not.toHaveBeenCalled();
  };
  it("gas 用量 ×1.3 后超过 maxGasLimit → fee_cap_exceeded(gas_limit)", async () => {
    await refused(fakeChain({ estimateGas: vi.fn(async () => 800_000n) }), "gas_limit");
  });
  it("maxFeePerGas / maxPriorityFeePerGas / legacy gasPrice 超上限 → 拒绝", async () => {
    await refused(fakeChain({ fees: vi.fn(async () => ({ maxFeePerGas: 100_000_001n, maxPriorityFeePerGas: 1n })) }), "max_fee_per_gas");
    await refused(fakeChain({ fees: vi.fn(async () => ({ maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 10_000_001n })) }), "max_priority_fee_per_gas");
    await refused(fakeChain({ fees: vi.fn(async () => ({ gasPrice: 100_000_001n })) }), "max_fee_per_gas");
  });
  it("gas × maxFeePerGas 超过每笔总费用上限 → 拒绝（各项单独都没超）", async () => {
    // 600k × 1.3 = 780k gas；780k × 0.08 gwei = 6.24e13 > 5e13
    await refused(fakeChain({ estimateGas: vi.fn(async () => 600_000n), fees: vi.fn(async () => ({ maxFeePerGas: 80_000_000n, maxPriorityFeePerGas: 1n })) }), "tx_fee");
  });
  it("上限内正常签名；签出的交易解析得到的最大费用 = gas × maxFeePerGas（服务端预留用）", async () => {
    const chain = fakeChain({ estimateGas: vi.fn(async () => 600_000n), fees: vi.fn(async () => ({ maxFeePerGas: 24_000_000n, maxPriorityFeePerGas: 1n })) });
    const s = new ExecSender(EXEC, chain, hosted, { feeCaps: caps });
    const a = await s.sign(exec);
    expect(a.gas).toBe(780_000n);
    expect(a.maxFeeWei).toBe(780_000n * 24_000_000n);
    expect(maxFeeOfRawTx(a.rawTx)).toEqual({ gas: 780_000n, maxFeePerGas: 24_000_000n, maxFeeWei: 780_000n * 24_000_000n });
    expect(maxFeeOfRawTx("0x02deadbeef" as Hex)).toBeNull();
  });
  it("不传 feeCaps 时使用保守缺省（DEFAULT_FEE_CAPS），不是无上限", async () => {
    expect(DEFAULT_FEE_CAPS.maxFeePerTx).toBeGreaterThan(0n);
    const s = new ExecSender(EXEC, fakeChain({ fees: vi.fn(async () => ({ maxFeePerGas: DEFAULT_FEE_CAPS.maxFeePerGas + 1n, maxPriorityFeePerGas: 1n })) }), hosted);
    expect(((await s.sign(exec).catch((e: unknown) => e)) as ExecTxError).code).toBe("fee_cap_exceeded");
  });
  it("parseFeeCaps：缺省 / 覆盖 / 非法值", () => {
    expect(parseFeeCaps({})).toEqual(DEFAULT_FEE_CAPS);
    expect(parseFeeCaps({ EXECUTOR_MAX_GAS_LIMIT: "900000" }).maxGasLimit).toBe(900_000n);
    expect(() => parseFeeCaps({ EXECUTOR_MAX_FEE_PER_TX_WEI: "abc" })).toThrow(/EXECUTOR_MAX_FEE_PER_TX_WEI/);
    expect(() => parseFeeCaps({ EXECUTOR_MAX_FEE_PER_GAS_WEI: "0" })).toThrow(/EXECUTOR_MAX_FEE_PER_GAS_WEI/);
  });
});
