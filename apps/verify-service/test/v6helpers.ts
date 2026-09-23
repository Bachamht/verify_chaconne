/** v6 Lane C 测试共用：PlanGuard MandateStep 回执构造、草案签署、owner 关系建立 */
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EIP712_TYPES_V2, type TradeMandate } from "@chaconne/core/verify";
import { PLANGUARD_ABI } from "../src/execution/planGuardAbi";
import { mandateStepMatcher, type ChainReceipt, type ReceiptSource, type ReceiptVerifierOptions } from "../src/execution/receipts";
import { api, signedMandateBody, TEST_OWNER_KEY, TEST_PLANGUARD, type TestEnv } from "./helpers";

export const OWNER = privateKeyToAccount(TEST_OWNER_KEY).address.toLowerCase() as Hex;

export function stepLog(mandateDigest: Hex, stepIndex: number, owner: Hex, args: { spent: string; received: string; outputToken?: Hex } = { spent: "100000000", received: "400000000000000000000" }, address: Hex = TEST_PLANGUARD) {
  const topics = encodeEventTopics({ abi: PLANGUARD_ABI, eventName: "MandateStep", args: { owner, mandateDigest, stepIndex } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }],
    [args.outputToken ?? "0x2222222222222222222222222222222222222222", BigInt(args.spent), BigInt(args.spent), BigInt(args.received), 0n, ("0x" + "11".repeat(32)) as Hex, "0x9999999999999999999999999999999999999999"],
  );
  return { address, data, topics };
}
export function receipt(over: Partial<ChainReceipt> = {}): ChainReceipt {
  return { status: "success", blockNumber: 100n, blockHash: "0x" + "ab".repeat(32), gasUsed: 620_000n, logs: [], ...over };
}
export function source(r: ChainReceipt | null, head = 200n): ReceiptSource {
  return { getReceipt: async () => r, headBlock: async () => head };
}
export function receiptOpts(env: TestEnv): ReceiptVerifierOptions {
  return { guard: TEST_PLANGUARD, confirmations: 6, unknownAfterMs: 600_000, matcher: mandateStepMatcher, now: () => new Date(env.cfgNow()) };
}

/** 登记一份免费的买入授权（ACTIVE），顺带建立 caller ↔ owner 关系（owner 鉴权用） */
export async function registerBuyMandate(env: TestEnv, overrides: Parameters<typeof signedMandateBody>[1] = {}) {
  const { body, mandate, owner } = await signedMandateBody(env, overrides);
  const r = await api(env, "POST", "/v1/mandates", body);
  if (r.status !== 201 && r.status !== 200) throw new Error(`register mandate failed ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json["mandateId"] as string, digest: r.json["mandateDigest"] as Hex, mandate, owner, json: r.json };
}

/** 用 owner 私钥签调仓腿的草案（草案里 nonce 可改） */
export async function signDraft(env: TestEnv, draft: { mandate: TradeMandate; typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: Hex } }; registerBody: Record<string, unknown> }, nonce?: string) {
  const owner = privateKeyToAccount(TEST_OWNER_KEY);
  const mandate: TradeMandate = { ...draft.mandate, ...(nonce ? { nonce } : {}) };
  const signature = await owner.signTypedData({
    domain: draft.typedData.domain,
    types: EIP712_TYPES_V2,
    primaryType: "TradeMandate",
    message: { ...mandate, budgetCap: BigInt(mandate.budgetCap), perStepCap: BigInt(mandate.perStepCap), maxSteps: Number(mandate.maxSteps), validFrom: BigInt(mandate.validFrom), deadline: BigInt(mandate.deadline), nonce: BigInt(mandate.nonce) },
  });
  void env;
  return { ...draft.registerBody, mandate, signature };
}
