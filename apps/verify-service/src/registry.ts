/**
 * 资产登记加载：fixture（占位，仅测试/演示）| file（运营者批准后的 JSON，Lane B 产出）。
 * 加载时跑 validateRegistry，任何不一致拒绝启动。
 */
import { readFileSync } from "node:fs";
import { validateRegistry, type AssetRegistry } from "@chaconne/core/verify";
import { fixtureRegistry } from "@chaconne/core/verify/fixtures";
import type { VerifyConfig } from "./config";

export function loadRegistry(cfg: Pick<VerifyConfig, "REGISTRY_MODE" | "REGISTRY_FILE" | "EXECUTION_CHAIN_ID">): AssetRegistry {
  let reg: AssetRegistry;
  if (cfg.REGISTRY_MODE === "fixture") {
    reg = fixtureRegistry({ chainId: cfg.EXECUTION_CHAIN_ID });
    for (const e of reg.entries) {
      e.chainId = cfg.EXECUTION_CHAIN_ID;
      e.assetKey = `eip155:${cfg.EXECUTION_CHAIN_ID}:${e.tokenAddress}`;
    }
  } else {
    reg = JSON.parse(readFileSync(cfg.REGISTRY_FILE, "utf8")) as AssetRegistry;
  }
  const errs = validateRegistry(reg);
  if (errs.length > 0) throw new Error(`资产登记校验失败：${errs.join("；")}`);
  if (reg.chainId !== cfg.EXECUTION_CHAIN_ID) throw new Error(`登记表 chainId ${reg.chainId} ≠ EXECUTION_CHAIN_ID ${cfg.EXECUTION_CHAIN_ID}`);
  return reg;
}
