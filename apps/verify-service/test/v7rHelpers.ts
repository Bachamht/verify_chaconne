/** v7 Lane R 测试共用：网页会话 key（web:*，按 x-verify-caller 细分为 web:<owner>）与目标式任务请求体 */
import { privateKeyToAccount } from "viem/accounts";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { TEST_OWNER_KEY } from "./helpers";

export const owner = privateKeyToAccount(TEST_OWNER_KEY).address.toLowerCase();
export const WEB_KEY = "vk_test_web";
export const WEB_KEYS = `${WEB_KEY}:web:*`;
export const webHeaders = { "x-verify-caller": owner };

export function goalTaskBody(over: Record<string, unknown> = {}) {
  return { clientRequestId: `r-${Math.random().toString(16).slice(2, 10)}`, mode: "SIMULATION", ownerAddress: owner, strategy: "v1", scope: { objective: "r1", inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKeys: [FIXTURE_STOCK_KEY], budgetCapRaw: "1000000", perStepCapRaw: "500000" }, ...over };
}
