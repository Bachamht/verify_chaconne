/** v7 Lane X · X1 委托纯函数：X-02 permit 互检、X-03 账本、X-07 卖出上限、清单（S-01 / S-02 计数、userTransactions = 0、buyReady 不受别的任务影响） */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, hashDomain, hashTypedData, parseAbi, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildDelegationChecklist,
  checklistLatches,
  decodePermitCalldata,
  explainBuyMandate,
  explainPermit,
  explainSellMandate,
  matchPermitDomain,
  p6FromUsdPerShare,
  permitDeadline,
  permitDigest,
  permitDomainCandidates,
  permitDomainSeparator,
  permitFromTypedData,
  permitNeeded,
  permitTypedData,
  permitValue,
  reclaimSuggested,
  reclaimValue,
  requiredAllowance,
  sellCapRaw,
  type ChecklistMandateInput,
  type ChecklistPermitInput,
  type EvmAddress,
  type PermitDomain,
  type PermitMessage,
} from "../src/verify";

/** 公开的 anvil 测试账户 #1（仅测试） */
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const TOKEN = "0x1111111111111111111111111111111111111111" as EvmAddress;
const PLANGUARD = "0x2222222222222222222222222222222222222222" as EvmAddress;
/** 测试用假域名（不是任何真实代币的域） */
const DOMAIN_V: PermitDomain = { name: "Test Token", version: "2", chainId: 196, verifyingContract: TOKEN };
const DOMAIN_NOV: PermitDomain = { name: "Test Token", version: null, chainId: 196, verifyingContract: TOKEN };
const MSG: PermitMessage = { owner: OWNER.address.toLowerCase() as EvmAddress, spender: PLANGUARD, value: "10050000", nonce: "3", deadline: "1790000000" };
const viemMsg = (m: PermitMessage) => ({ owner: m.owner, spender: m.spender, value: BigInt(m.value), nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) });
const PERMIT_TYPES = { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] } as const;

describe("X-02 permit typedData 与 viem 互检；签名恢复 = owner", () => {
  it("域分隔符（含 / 不含 version）= viem hashDomain", () => {
    expect(permitDomainSeparator(DOMAIN_V)).toBe(hashDomain({ domain: { name: "Test Token", version: "2", chainId: 196n, verifyingContract: TOKEN }, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } }));
    expect(permitDomainSeparator(DOMAIN_NOV)).toBe(hashDomain({ domain: { name: "Test Token", chainId: 196n, verifyingContract: TOKEN }, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } }));
    expect(permitDomainSeparator(DOMAIN_V)).not.toBe(permitDomainSeparator({ ...DOMAIN_V, version: "1" }));
  });
  it("摘要 = viem hashTypedData；typedData 可直接给 signTypedData；签名恢复 = owner", async () => {
    for (const domain of [DOMAIN_V, DOMAIN_NOV]) {
      const td = permitTypedData(domain, MSG);
      expect(td.primaryType).toBe("Permit");
      expect("version" in td.domain).toBe(domain.version !== null);
      const viemDomain = td.domain as { name: string; version?: string; chainId: number; verifyingContract: Hex };
      expect(permitDigest(domain, MSG)).toBe(hashTypedData({ domain: viemDomain, types: PERMIT_TYPES, primaryType: "Permit", message: viemMsg(MSG) }));
      const sig = await OWNER.signTypedData({ domain: viemDomain, types: PERMIT_TYPES, primaryType: "Permit", message: viemMsg(MSG) });
      const rec = await recoverTypedDataAddress({ domain: viemDomain, types: PERMIT_TYPES, primaryType: "Permit", message: viemMsg(MSG), signature: sig });
      expect(rec.toLowerCase()).toBe(OWNER.address.toLowerCase());
      const back = permitFromTypedData(td);
      expect(back.domain).toEqual({ ...domain, verifyingContract: TOKEN.toLowerCase() });
      expect(back.message).toEqual(MSG);
    }
  });
  it("候选匹配只认完全相等的域分隔符；deadline = now + 1800", () => {
    const onchain = permitDomainSeparator(DOMAIN_NOV);
    const cands = permitDomainCandidates("Test Token", 196, TOKEN, ["v1"]);
    expect(cands.map((c) => c.version)).toEqual(["1", "2", null, "v1"]);
    expect(matchPermitDomain(cands, onchain)?.version).toBeNull();
    expect(matchPermitDomain(permitDomainCandidates("Other", 196, TOKEN), onchain)).toBeNull();
    expect(permitDeadline(1_000)).toBe("2800");
  });
  it("permit calldata 解码（执行身份白名单用）", () => {
    const data = encodeFunctionData({ abi: parseAbi(["function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)"]), functionName: "permit", args: [OWNER.address, PLANGUARD, 5n, 99n, 27, `0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`] });
    expect(data.slice(0, 10)).toBe("0xd505accf");
    const d = decodePermitCalldata(data)!;
    expect(d.owner).toBe(OWNER.address.toLowerCase());
    expect(d.spender).toBe(PLANGUARD);
    expect(d.value).toBe(5n);
    expect(d.deadline).toBe(99n);
    expect(d.v).toBe(27);
    expect(decodePermitCalldata(`0x095ea7b3${"00".repeat(64)}`)).toBeNull();
    expect(decodePermitCalldata(data.slice(0, -2) as Hex)).toBeNull();
  });
});

describe("X-03 额度账本", () => {
  const USDG = "0x4444444444444444444444444444444444444444" as EvmAddress;
  const AAPL = "0x5555555555555555555555555555555555555555" as EvmAddress;
  it("多任务并行求和；终结授权不计；草案计入；卖出授权按股票单位独立", () => {
    const mandates = [
      { mandateId: "m1", token: USDG, state: "ACTIVE", budgetCap: "10000000", spent: "4000000" },
      { mandateId: "m2", token: USDG, state: "PAUSED", budgetCap: "5000000", spent: "0" },
      { mandateId: "m3", token: USDG, state: "DRAFT", budgetCap: "1000000", spent: "0" },
      { mandateId: "m4", token: USDG, state: "COMPLETED", budgetCap: "9000000", spent: "1" },
      { mandateId: "m5", token: USDG, state: "CANCELLED", budgetCap: "9000000", spent: "0" },
      { mandateId: "m6", token: USDG, state: "ACTIVE", budgetCap: "1000000", spent: "1200000" }, // spent > cap（退款舍入）→ max(0, …)
      { mandateId: "s1", token: AAPL, state: "ACTIVE", budgetCap: "40000000000000000", spent: "0" },
    ];
    const drafts = [{ id: "buy", token: USDG, budgetCap: "2000000" }, { id: "sell:aapl", token: AAPL, budgetCap: "1000000000000000000" }];
    expect(requiredAllowance(mandates, drafts, USDG)).toBe(String(6_000_000 + 5_000_000 + 1_000_000 + 2_000_000));
    expect(requiredAllowance(mandates, drafts, AAPL.toUpperCase().replace("0X", "0x") as EvmAddress)).toBe((40000000000000000n + 1000000000000000000n).toString());
    expect(requiredAllowance([], [], USDG)).toBe("0");
  });
  it("value = 需要量 + ceil(0.5%)；链上已足 → 不需要；收回额度", () => {
    expect(permitValue("10000000")).toBe("10050000");
    expect(permitValue("1")).toBe("2");
    expect(permitValue("0")).toBe("0");
    expect(permitValue("19999")).toBe("20099"); // 99.995 → 100
    expect(permitNeeded("10000000", "10000000")).toBe(false);
    expect(permitNeeded("9999999", "10000000")).toBe(true);
    expect(permitNeeded("0", "0")).toBe(false);
    expect(reclaimValue("0")).toBe("0");
    expect(reclaimValue("200")).toBe("201");
    expect(reclaimSuggested("1006", "1000")).toBe(true);
    expect(reclaimSuggested("1005", "1000")).toBe(false);
  });
});

describe("X-07 卖出上限公式", () => {
  it("向上取整、不同 decimals、价格缺失", () => {
    // 10 USDG（6 位）、P6 = 250.123456 USD、18 位股票：ceil(10e6 × 2 × 1e18 × 1e6 / (250123456 × 1e6))
    const r = sellCapRaw({ budgetCapRaw: "10000000", stableDecimals: 6, tokenDecimals: 18, p6: "250123456" });
    expect(r.ok && r.sellCapRaw).toBe(((10_000_000n * 2n * 10n ** 18n + 250_123_455n) / 250_123_456n).toString());
    // 整除时不多加 1
    expect(sellCapRaw({ budgetCapRaw: "100000000", stableDecimals: 6, tokenDecimals: 6, p6: "200000000" })).toMatchObject({ ok: true, sellCapRaw: "1000000" });
    // 18 位资金币种
    expect(sellCapRaw({ budgetCapRaw: "100000000000000000000", stableDecimals: 18, tokenDecimals: 18, p6: "200000000" })).toMatchObject({ ok: true, sellCapRaw: "1000000000000000000" });
    expect(sellCapRaw({ budgetCapRaw: "100000000000000000001", stableDecimals: 18, tokenDecimals: 18, p6: "200000000" })).toMatchObject({ ok: true, sellCapRaw: "1000000000000000001" });
    expect(sellCapRaw({ budgetCapRaw: "1", stableDecimals: 6, tokenDecimals: 0, p6: "300000000" })).toMatchObject({ ok: true, sellCapRaw: "1" });
    for (const p6 of [null, undefined, "0", "-1", "1.5", ""]) expect(sellCapRaw({ budgetCapRaw: "1", stableDecimals: 6, tokenDecimals: 18, p6 })).toMatchObject({ ok: false, code: "price_unavailable" });
    expect(p6FromUsdPerShare("250.1234567")).toBe("250123456");
  });
  it("D-092 简化（2026-10-02）：合约上限 = 委托时链上余额 + 买入派生公式；余额非法 → invalid_input", () => {
    // 500 USDG × 2 / 250 USD = 4 股；已有 1.5 股
    const r = sellCapRaw({ budgetCapRaw: "500000000", stableDecimals: 6, tokenDecimals: 18, p6: "250000000", holdingsRaw: "1500000000000000000" });
    expect(r).toMatchObject({ ok: true, sellCapRaw: "5500000000000000000", boughtCapRaw: "4000000000000000000", holdingsRaw: "1500000000000000000" });
    expect(sellCapRaw({ budgetCapRaw: "500000000", stableDecimals: 6, tokenDecimals: 18, p6: "250000000" })).toMatchObject({ ok: true, sellCapRaw: "4000000000000000000", holdingsRaw: "0" });
    expect(sellCapRaw({ budgetCapRaw: "500000000", stableDecimals: 6, tokenDecimals: 18, p6: "250000000", holdingsRaw: "-1" })).toMatchObject({ ok: false, code: "invalid_input" });
    // 价格缺失仍然失败（余额有也一样）
    expect(sellCapRaw({ budgetCapRaw: "500000000", stableDecimals: 6, tokenDecimals: 18, p6: null, holdingsRaw: "1" })).toMatchObject({ ok: false, code: "price_unavailable" });
    expect(p6FromUsdPerShare("0")).toBeNull();
    expect(p6FromUsdPerShare("1e3")).toBeNull();
  });
});

describe("委托清单（S-01 / S-02 计数；五个登记代币下 userTransactions === 0）", () => {
  const USDG = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8" as EvmAddress;
  const AAPLX = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a" as EvmAddress;
  const NVDAX = "0xc845b2894dbddd03858fd2d643b4ef725fe0849d" as EvmAddress;
  const text = { title: { zh: "t", en: "t" }, explain: { zh: "e", en: "e" } };
  const td = { domain: {}, types: {}, primaryType: "X", message: {} };
  const mand = (side: "buy" | "sell", token: EvmAddress, registered: ChecklistMandateInput["registered"] = null, error: ChecklistMandateInput["error"] = null): ChecklistMandateInput => ({ ...text, side, assetKey: `eip155:196:${token}`, token, typedData: error ? null : td, registered, error });
  const perm = (token: EvmAddress, over: Partial<ChecklistPermitInput> = {}): ChecklistPermitInput => ({ ...text, token, assetKey: `eip155:196:${token}`, onchainRaw: "0", requiredRaw: "100", supported: true, issued: { permitRequestId: `prm_${token.slice(2, 6)}`, typedData: td }, latest: null, pendingPermit: false, ...over });

  it("S-01 买入任务：额度 0 → 签名 2 次，用户交易 0；顺序 buy → permit", () => {
    const c = buildDelegationChecklist({ taskId: "t1", mandates: [mand("buy", USDG)], permits: [perm(USDG)] });
    expect(c.items.map((i) => i.id)).toEqual(["buy", `permit:${USDG}`]);
    expect(c.counts).toEqual({ signaturesNeeded: 2, signaturesDone: 0, userTransactions: 0 });
    expect(c.items[1]!.permitRequestId).toBe(`prm_${USDG.slice(2, 6)}`);
    expect(c.buyReady).toBe(false);
    expect(c.complete).toBe(false);
  });
  it("S-02 两只可减仓：签名 6 次；五个登记代币全部走 permit（userTransactions = 0）；完成判定", () => {
    const mandates = [mand("buy", USDG), mand("sell", AAPLX), mand("sell", NVDAX)];
    const permits = [perm(NVDAX), perm(AAPLX), perm(USDG)];
    const c = buildDelegationChecklist({ taskId: "t2", mandates, permits });
    expect(c.items.map((i) => i.id)).toEqual(["buy", `sell:eip155:196:${AAPLX}`, `sell:eip155:196:${NVDAX}`, `permit:${USDG}`, `permit:${AAPLX}`, `permit:${NVDAX}`]);
    expect(c.counts).toEqual({ signaturesNeeded: 6, signaturesDone: 0, userTransactions: 0 });
    // 五个登记代币（USDG / USDC / USD₮0 / AAPLx / NVDAx）只要域已核实，任何组合都不需要用户交易
    for (const tok of ["0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "0xb6ceceab302e2e4948951ee7843fc24e92933061", "0x779ded0c9e1022225f8e0630b35a9b54be713736", AAPLX, NVDAX] as EvmAddress[]) {
      expect(buildDelegationChecklist({ taskId: "t", mandates: [mand("buy", tok)], permits: [perm(tok)] }).counts.userTransactions).toBe(0);
    }
    const done = buildDelegationChecklist({
      taskId: "t2",
      mandates: [mand("buy", USDG, { mandateId: "m1", state: "ACTIVE" }), mand("sell", AAPLX, { mandateId: "m2", state: "ACTIVE" }), mand("sell", NVDAX, { mandateId: "m3", state: "ACTIVE" })],
      permits: [perm(USDG, { latest: { permitId: "p1", state: "CONFIRMED", txHash: "0xab" } }), perm(AAPLX, { latest: { permitId: "p2", state: "SUBMITTED", txHash: null }, pendingPermit: true }), perm(NVDAX, { onchainRaw: "100" })],
    });
    expect(done.counts).toEqual({ signaturesNeeded: 5, signaturesDone: 5, userTransactions: 0 });
    expect(done.buyReady).toBe(true);
    expect(done.sellReady).toEqual({ [`eip155:196:${AAPLX}`]: false, [`eip155:196:${NVDAX}`]: true });
    expect(done.complete).toBe(false);
    expect(done.allowances.find((a) => a.token === AAPLX)?.pendingPermit).toBe(true);
    expect(checklistLatches(done)).toEqual({ [`permit:${USDG}`]: "confirmed", [`permit:${NVDAX}`]: "not_needed" });
  });
  it("X-06 链上额度已足 → not_needed，签名数减少；buyReady 不受别的任务登记影响（锁定）", () => {
    const a = buildDelegationChecklist({ taskId: "t", mandates: [mand("buy", USDG, { mandateId: "m", state: "ACTIVE" })], permits: [perm(USDG, { onchainRaw: "500", requiredRaw: "100" })] });
    expect(a.items[1]!.status).toBe("not_needed");
    expect(a.counts.signaturesNeeded).toBe(1);
    expect(a.buyReady).toBe(true);
    expect(a.complete).toBe(true);
    // 另一个任务登记后需要量升到 900：没锁定会翻成 todo，锁定后仍是本任务事实
    const flipped = buildDelegationChecklist({ taskId: "t", mandates: [mand("buy", USDG, { mandateId: "m", state: "ACTIVE" })], permits: [perm(USDG, { onchainRaw: "500", requiredRaw: "900" })] });
    expect(flipped.buyReady).toBe(false);
    const latched = buildDelegationChecklist({ taskId: "t", mandates: [mand("buy", USDG, { mandateId: "m", state: "ACTIVE" })], permits: [perm(USDG, { onchainRaw: "500", requiredRaw: "900" })], latched: checklistLatches(a) });
    expect(latched.buyReady).toBe(true);
    expect(latched.complete).toBe(true);
  });
  it("卖出草案价格缺失 → failed（typedData null）；域未核实 → 回退一笔用户 approve 如实计数；permit 失败可重签", () => {
    const c = buildDelegationChecklist({ taskId: "t", mandates: [mand("buy", USDG), mand("sell", AAPLX, null, { code: "price_unavailable", message: "x" })], permits: [perm(USDG, { supported: false }), perm(AAPLX, { latest: { permitId: "p", state: "FAILED", txHash: null, error: { code: "permit_nonce_consumed", message: "m" } } })] });
    const sell = c.items.find((i) => i.kind === "mandate_sell")!;
    expect(sell.status).toBe("failed");
    expect(sell.typedData).toBeNull();
    expect(sell.error?.code).toBe("price_unavailable");
    const usdg = c.items.find((i) => i.id === `permit:${USDG}`)!;
    expect(usdg.typedData).toBeNull();
    expect(usdg.error?.code).toBe("permit_domain_unverified");
    expect(c.counts.userTransactions).toBe(1);
    const aapl = c.items.find((i) => i.id === `permit:${AAPLX}`)!;
    expect(aapl.status).toBe("todo");
    expect(aapl.error?.code).toBe("permit_nonce_consumed");
    expect(aapl.typedData).not.toBeNull();
    expect(c.counts.signaturesNeeded).toBe(3);
  });
  it("说明文案含金额、合约、期限、可撤回", () => {
    const b = explainBuyMandate({ stableSymbol: "USDG", stableDecimals: 6, budgetCapRaw: "10000000", perStepCapRaw: "2000000", maxSteps: 5, stockSymbols: ["AAPLx", "NVDAx"], deadline: "2026-10-12T00:00:00.000Z", planGuard: PLANGUARD });
    expect(b.explain.zh).toContain("10 USDG");
    expect(b.explain.zh).toContain("2026-10-12");
    expect(b.explain.en).toContain("revocable");
    const sx = explainSellMandate({ stockSymbol: "AAPLx", stockDecimals: 18, stableSymbol: "USDG", sellCapRaw: "80000000000000000", deadline: "2026-10-12T00:00:00.000Z", planGuard: PLANGUARD });
    expect(sx.explain.zh).toContain("0.08 股");
    expect(sx.explain.zh).toContain("允许在到期前按策略把 AAPLx 换回 USDG，最多可卖出你的全部持仓；换回的 USDG 只进你的钱包");
    expect(sx.explain.zh).not.toContain("只卖本任务买入");
    expect(sx.explain.en).toContain("up to your full holdings");
    expect(explainPermit({ symbol: "USDG", decimals: 6, valueRaw: "10050000", requiredRaw: "10000000", planGuard: PLANGUARD }).explain.zh).toContain("10.05 USDG");
  });
});
