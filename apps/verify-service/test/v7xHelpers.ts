/** v7 Lane X 测试基建：假链（PlanGuard 状态 / 代币额度 / nonce / 回执 / 日志）、v7 开关环境、委托与作业的常用动作 */
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FIXTURE_STABLE, FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { permitDomainSeparator, type PermitDomainsFile } from "@chaconne/core/verify";
import { api, createTestEnv, TEST_OWNER_KEY, TEST_PLANGUARD, type TestEnv, type TestEnvOptions } from "./helpers";
import { signedContext, testKeypair } from "./contextHelpers";
import { createV7X, type V7XWiring } from "../src/execution/wire";
import { PermitDomains } from "../src/delegation/domains";
import { PLANGUARD_ABI } from "../src/execution/planGuardAbi";
import type { ServiceChain, StepLog } from "../src/execution/chain";
import type { ChainReceipt, MandateStepSummary } from "../src/execution/receipts";

export const OWNER = privateKeyToAccount(TEST_OWNER_KEY);
export const owner = OWNER.address.toLowerCase() as Hex;
export const EXEC_KEY = "vk_test_exec";
export const OPERATOR_KEY = "vk_test_alpha";
export const EXEC_ADDR = "0x9999999999999999999999999999999999999999";
export const EXEC_ADDR_2 = "0x8888888888888888888888888888888888888888";
export const AT = "2026-09-18T14:58:00.000Z";
export const STABLE = FIXTURE_STABLE.toLowerCase() as Hex;
export const STOCK = FIXTURE_STOCK.toLowerCase() as Hex;
export { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY };

const lc = (s: string) => s.toLowerCase();
const APPROVAL = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);

/** 假链：只读接口 + 测试用的写入口（模拟链上发生了什么） */
export class FakeChain implements ServiceChain {
  head_ = { number: 1000n, timestamp: BigInt(Math.floor(Date.parse(AT) / 1000)) };
  allowances = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  tokenNonces = new Map<string, bigint>();
  states = new Map<string, { spent: bigint; steps: number; revoked: boolean }>();
  logs: Array<StepLog & { planGuard: string; owner: string; digest: string }> = [];
  receipts = new Map<string, ChainReceipt>();
  domainSeps = new Map<string, Hex>();
  calls = { mandateState: 0 };
  setNow(iso: string) {
    this.head_ = { ...this.head_, timestamp: BigInt(Math.floor(Date.parse(iso) / 1000)) };
  }
  mine(n = 1n) {
    this.head_ = { ...this.head_, number: this.head_.number + n };
  }
  async mandateState(_pg: Hex, digest: Hex) {
    this.calls.mandateState += 1;
    return this.states.get(lc(digest)) ?? { spent: 0n, steps: 0, revoked: false };
  }
  async mandateStepLogs(planGuard: Hex, own: Hex, digest: Hex, fromBlock: bigint, toBlock: bigint) {
    return this.logs.filter((l) => lc(l.planGuard) === lc(planGuard) && lc(l.owner) === lc(own) && lc(l.digest) === lc(digest) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
  }
  async head() {
    return this.head_;
  }
  async allowance(token: Hex, o: Hex, spender: Hex) {
    return this.allowances.get(`${lc(token)}:${lc(o)}:${lc(spender)}`) ?? 0n;
  }
  async balanceOf(token: Hex, o: Hex) {
    return this.balances.get(`${lc(token)}:${lc(o)}`) ?? 0n;
  }
  async nonces(token: Hex, o: Hex) {
    return this.tokenNonces.get(`${lc(token)}:${lc(o)}`) ?? 0n;
  }
  async domainSeparator(token: Hex) {
    const d = this.domainSeps.get(lc(token));
    if (!d) throw new Error("no DOMAIN_SEPARATOR");
    return d;
  }
  async getReceipt(txHash: Hex) {
    return this.receipts.get(lc(txHash)) ?? null;
  }
  setAllowance(token: string, value: bigint, o: string = owner) {
    this.allowances.set(`${lc(token)}:${lc(o)}:${lc(TEST_PLANGUARD)}`, value);
  }
  setBalance(token: string, value: bigint, o: string = owner) {
    this.balances.set(`${lc(token)}:${lc(o)}`, value);
  }
  /** 模拟 permit 上链：nonce + 1、额度设为 value、回执带 Approval */
  landPermit(txHash: Hex, token: string, o: string, value: bigint, opts: { approval?: boolean; status?: "success" | "reverted" } = {}) {
    const k = `${lc(token)}:${lc(o)}`;
    if ((opts.status ?? "success") === "success") {
      this.tokenNonces.set(k, (this.tokenNonces.get(k) ?? 0n) + 1n);
      this.setAllowance(token, value, o);
    }
    const topics = encodeEventTopics({ abi: APPROVAL, eventName: "Approval", args: { owner: o as Hex, spender: TEST_PLANGUARD } }) as [Hex, ...Hex[]];
    const logs = opts.approval === false ? [] : [{ address: lc(token), topics, data: encodeAbiParameters([{ type: "uint256" }], [value]) }];
    this.receipts.set(lc(txHash), { status: opts.status ?? "success", blockNumber: this.head_.number, blockHash: `0x${"ab".repeat(32)}`, gasUsed: 50_000n, effectiveGasPrice: 20_000_000n, logs });
  }
  /** 模拟 executeStep 上链：mandateState 前进、日志与回执（MandateStep 事件，字段取自那张被执行的证书） */
  landStep(txHash: Hex, a: { digest: string; stepIndex: number; outputToken: string; amountIn: string; evidenceHash: string; spent?: string; received?: string }) {
    const st = this.states.get(lc(a.digest)) ?? { spent: 0n, steps: 0, revoked: false };
    this.states.set(lc(a.digest), { ...st, steps: Math.max(st.steps, a.stepIndex + 1), spent: st.spent + BigInt(a.spent ?? a.amountIn) });
    const log = stepLog(a.digest as Hex, a.stepIndex, { outputToken: a.outputToken, amountIn: a.amountIn, spent: a.spent ?? a.amountIn, received: a.received ?? "200000000000000000", evidenceHash: a.evidenceHash });
    const event: MandateStepSummary = { owner, mandateDigest: lc(a.digest), stepIndex: String(a.stepIndex), outputToken: lc(a.outputToken), amountIn: a.amountIn, spent: a.spent ?? a.amountIn, received: a.received ?? "200000000000000000", refunded: "0", evidenceHash: lc(a.evidenceHash), executor: EXEC_ADDR };
    this.logs.push({ txHash, blockNumber: this.head_.number, event, planGuard: TEST_PLANGUARD, owner, digest: lc(a.digest) });
    this.receipts.set(lc(txHash), { status: "success", blockNumber: this.head_.number, blockHash: `0x${"cd".repeat(32)}`, gasUsed: 600_000n, effectiveGasPrice: 20_000_000n, logs: [log] });
  }
}

export function stepLog(mandateDigest: Hex, stepIndex: number, f: { outputToken: string; amountIn: string; spent: string; received: string; evidenceHash: string }) {
  const topics = encodeEventTopics({ abi: PLANGUARD_ABI, eventName: "MandateStep", args: { owner: OWNER.address, mandateDigest, stepIndex } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }], [f.outputToken as Hex, BigInt(f.amountIn), BigInt(f.spent), BigInt(f.received), 0n, f.evidenceHash as Hex, EXEC_ADDR as Hex]);
  return { address: TEST_PLANGUARD, data, topics };
}

/** 测试用 permit 域（假名，不是任何真实代币的域），status = approved */
export function testDomainsFile(): PermitDomainsFile & { status: string } {
  const entry = (token: Hex, name: string, assetKey: string) => ({ assetKey, token, name, version: "1", domainSeparator: permitDomainSeparator({ name, version: "1", chainId: 196, verifyingContract: token }), verifiedBlock: 1, verifiedAt: AT, forkAcceptance: null, sources: ["test"] });
  return { version: "permit-domains/1", chainId: 196, status: "approved", entries: [entry(STABLE, "Fixture USD", FIXTURE_STABLE_KEY), entry(STOCK, "Fixture Stock", FIXTURE_STOCK_KEY)] };
}

export interface V7Env {
  e: TestEnv;
  chain: FakeChain;
  wiring: V7XWiring;
}

export const V7_FLAGS = { AGENT_V7_DELEGATION_ENABLED: "true", HOSTED_EXECUTOR_ENABLED: "true", HOSTED_AGENT_ENABLED: "true", AGENT_V7_SELL_ENABLED: "true", FAULT_INJECTION_ENABLED: "true", HOSTED_OWNER_ALLOWLIST: owner };

export async function createV7Env(opts: { env?: Record<string, string>; flags?: Record<string, string>; p6?: string | null } & Omit<TestEnvOptions, "env" | "v7"> = {}): Promise<V7Env> {
  const chain = new FakeChain();
  const df = testDomainsFile();
  for (const en of df.entries) chain.domainSeps.set(en.token, en.domainSeparator);
  let wiring: V7XWiring | null = null;
  const kp = testKeypair();
  const e = await createTestEnv({
    ...opts,
    now: opts.now ?? AT,
    crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}`,
    extraKeys: `${EXEC_KEY}:executor:hosted${opts.extraKeys ? `,${opts.extraKeys}` : ""}`,
    env: { ...(opts.flags ?? V7_FLAGS), ...(opts.env ?? {}) },
    v7: (ctx) => {
      wiring = createV7X({ ...ctx, receiptStore: ctx.stepReceipts, chain, domains: new PermitDomains(df, 196), p6For: async () => (opts.p6 === undefined ? "250000000" : opts.p6) });
      return { x: wiring.handles };
    },
  });
  const r = await e.crowsnest.ingest(signedContext(kp, { at: AT }), { endpoint: "test", mode: "LIVE" });
  if (!r.ok) throw new Error(`ingest failed ${r.reason}`);
  chain.setBalance(STABLE, 10_000_000_000n);
  return { e, chain, wiring: wiring! };
}

/** 目标式买入任务（issuance=agent）；缺省托管 Agent + 平台执行 + 允许卖出 */
export function goalBody(over: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) {
  return { clientRequestId: `x-${Math.random().toString(16).slice(2, 10)}`, mode: "LIVE", ownerAddress: owner, strategy: "accumulate on calm days", agent: { mode: "hosted" }, executor: { mode: "hosted" }, scope: { objective: "build a small position", inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKeys: [FIXTURE_STOCK_KEY], budgetCapRaw: "500000000", perStepCapRaw: "100000000", maxSteps: 5, allowSell: true, ...scope }, ...over };
}
export const decision = () => ({ rationale: "calm session, small step inside the signed scope", claims: [{ kind: "agent_data", text: "spread looks normal", source: { name: "feed" } }] });
export const intent = (over: Record<string, unknown> = {}) => ({ clientRequestId: `i-${Math.random().toString(16).slice(2, 10)}`, kind: "buy", outputAssetKey: FIXTURE_STOCK_KEY, amountInRaw: "50000000", decision: decision(), ...over });

type TD = { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> };
export async function signMandate(td: TD): Promise<Hex> {
  const m = td.message as Record<string, string>;
  return OWNER.signTypedData({ domain: td.domain, types: { TradeMandate: td.types["TradeMandate"]! }, primaryType: "TradeMandate", message: { ...m, budgetCap: BigInt(m["budgetCap"]!), perStepCap: BigInt(m["perStepCap"]!), maxSteps: Number(m["maxSteps"]), validFrom: BigInt(m["validFrom"]!), deadline: BigInt(m["deadline"]!), nonce: BigInt(m["nonce"]!) } } as never);
}
export async function signPermit(td: TD): Promise<Hex> {
  const m = td.message as Record<string, string>;
  return OWNER.signTypedData({ domain: td.domain, types: { Permit: td.types["Permit"]! }, primaryType: "Permit", message: { owner: m["owner"], spender: m["spender"], value: BigInt(m["value"]!), nonce: BigInt(m["nonce"]!), deadline: BigInt(m["deadline"]!) } } as never);
}

export type Checklist = { items: Array<{ id: string; kind: string; status: string; typedData: TD | null; permitRequestId?: string; error?: { code: string } }>; counts: { signaturesNeeded: number; signaturesDone: number; userTransactions: number }; buyReady: boolean; sellReady: Record<string, boolean>; complete: boolean };

export async function checklist(v: V7Env, taskId: string): Promise<Checklist> {
  const r = await api(v.e, "GET", `/v1/tasks/${taskId}/delegation`);
  if (r.status !== 200) throw new Error(`delegation ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as unknown as Checklist;
}

/** 签全部 mandate 项（buy → sell:*） */
export async function signMandates(v: V7Env, taskId: string): Promise<void> {
  const c = await checklist(v, taskId);
  for (const it of c.items.filter((i) => i.kind !== "permit" && i.status === "todo")) {
    const r = await api(v.e, "POST", `/v1/tasks/${taskId}/authorize`, { itemId: it.id, signature: await signMandate(it.typedData!) });
    if (r.status !== 201 && r.status !== 200) throw new Error(`authorize ${it.id} ${r.status} ${JSON.stringify(r.json)}`);
  }
}

/** 执行者 API */
export const ex = {
  claim: (v: V7Env, executor = EXEC_ADDR, instanceId = "inst-aaaaaaaa") => api(v.e, "POST", "/v1/executor/claim", { executor, instanceId }, {}, EXEC_KEY),
  event: (v: V7Env, jobId: string, body: Record<string, unknown>) => api(v.e, "POST", `/v1/executor/jobs/${jobId}/events`, body, {}, EXEC_KEY),
  heartbeat: (v: V7Env, body: Record<string, unknown>) => api(v.e, "POST", "/v1/executor/heartbeat", body, {}, EXEC_KEY),
};
export const rawTx = (seed: string) => `0x02${keccak256(`0x${Buffer.from(seed).toString("hex")}`).slice(2)}` as Hex;

/** 委托到 ACTIVE：签全部 mandate → 每个 permit 签名提交 → 执行者领取并模拟上链 → 回执确认 */
export async function delegateFully(v: V7Env, taskId: string): Promise<void> {
  await signMandates(v, taskId);
  for (;;) {
    const c = await checklist(v, taskId);
    const todo = c.items.find((i) => i.kind === "permit" && i.status === "todo" && i.permitRequestId);
    if (!todo) break;
    const sub = await api(v.e, "POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: todo.permitRequestId, signature: await signPermit(todo.typedData!) });
    if (sub.status !== 202) throw new Error(`allowances ${sub.status} ${JSON.stringify(sub.json)}`);
    await runPermitJob(v);
  }
}

/** 执行者领取一个 permit 作业 → sending → sent（模拟上链）→ receipt；返回作业 id */
export async function runPermitJob(v: V7Env, executor = EXEC_ADDR): Promise<string> {
  const c = await ex.claim(v, executor);
  if (c.status !== 200) throw new Error(`claim ${c.status} ${JSON.stringify(c.json)}`);
  const job = (c.json["jobs"] as Array<{ id: string; kind: string; attempt: number; payload: { token: string; owner: string; value: string } }>)[0]!;
  if (job.kind !== "permit") throw new Error(`expected permit job, got ${job.kind}`);
  const raw = rawTx(job.id);
  const h = keccak256(raw);
  const s1 = await ex.event(v, job.id, { attempt: job.attempt, type: "sending", rawTxHash: h, nonce: "0", rawTx: raw });
  if (s1.status !== 200) throw new Error(`sending ${s1.status} ${JSON.stringify(s1.json)}`);
  v.chain.landPermit(h, job.payload.token, job.payload.owner, BigInt(job.payload.value));
  await ex.event(v, job.id, { attempt: job.attempt, type: "sent", txHash: h });
  await ex.event(v, job.id, { attempt: job.attempt, type: "receipt", txHash: h, status: "success", blockNumber: "1000" });
  return job.id;
}
