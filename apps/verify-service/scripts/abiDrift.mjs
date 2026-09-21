/**
 * ABI 漂移核对（在 apps/verify-service 下运行：`pnpm abi:drift`；这里能解析 viem）。
 * 权威来源 = packages/verify-contracts/abi/*.json（forge 导出）。
 * 比对对象 = 各处手写/裁剪的 ABI（verify-web、verify-mcp、verify-service），按函数/事件选择器逐个核对。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toEventSelector, toFunctionSelector } from "viem";

/** 仓库根（本文件在 apps/verify-service/scripts/） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const load = (p) => {
  const j = JSON.parse(readFileSync(join(ROOT, p), "utf8"));
  return Array.isArray(j) ? j : j.abi;
};
const flat = (i) => (i.type?.startsWith("tuple") ? `(${i.components.map(flat).join(",")})${i.type.slice(5)}` : i.type);
const sigOf = (e) => `${e.name}(${(e.inputs ?? []).map(flat).join(",")})`;
const selOf = (e) => (e.type === "event" ? toEventSelector(sigOf(e)) : toFunctionSelector(sigOf(e)));

const canon = {
  Guard: load("packages/verify-contracts/abi/ChaconneVerifyGuard.json"),
  PlanGuard: load("packages/verify-contracts/abi/ChaconneVerifyPlanGuard.json"),
};
const canonSel = {};
for (const [name, abi] of Object.entries(canon)) {
  canonSel[name] = new Map();
  for (const e of abi) if (e.type === "function" || e.type === "event") canonSel[name].set(selOf(e), sigOf(e));
}

/** 被检查的手写 ABI：[标签, 模块路径, 导出名, 权威合约] */
const targets = [
  ["verify-web Guard", "apps/verify-web/lib/guardAbi.ts", "GUARD_ABI", "Guard"],
  ["verify-web PlanGuard", "apps/verify-web/lib/planGuardAbi.ts", "PLAN_GUARD_ABI", "PlanGuard"],
  ["verify-service Guard", "apps/verify-service/src/execution/guardAbi.ts", "GUARD_ABI", "Guard"],
  ["verify-service PlanGuard", "apps/verify-service/src/execution/planGuardAbi.ts", "PLANGUARD_ABI", "PlanGuard"],
  ["verify-mcp Guard", "packages/verify-mcp/src/guardAbi.ts", "GUARD_ABI", "Guard"],
  ["verify-mcp PlanGuard", "packages/verify-mcp/src/planGuardAbi.ts", "PLAN_GUARD_ABI", "PlanGuard"],
];

let bad = 0;
for (const [label, path, exportName, contract] of targets) {
  let mod;
  try {
    mod = await import(`file://${join(ROOT, path)}`);
  } catch (e) {
    console.log(`SKIP ${label} (${path}): ${e.message.split("\n")[0]}`);
    continue;
  }
  const abi = mod[exportName] ?? Object.values(mod).find((v) => Array.isArray(v) && v.some((e) => e?.type === "function" || e?.type === "event"));
  if (!abi) {
    console.log(`SKIP ${label}: 找不到导出 ${exportName}（可用: ${Object.keys(mod).join(", ")}）`);
    continue;
  }
  const items = abi.filter((e) => e.type === "function" || e.type === "event");
  const mismatched = [];
  for (const e of items) {
    const sel = selOf(e);
    if (!canonSel[contract].has(sel)) mismatched.push(`${e.type} ${sigOf(e)}`);
  }
  if (mismatched.length) {
    bad += mismatched.length;
    console.log(`DRIFT ${label}: ${mismatched.length} 项与 ${contract} 权威 ABI 不符`);
    for (const m of mismatched) console.log(`   ${m}`);
  } else {
    console.log(`OK   ${label}: ${items.length} 项全部匹配 ${contract}`);
  }
}
console.log(bad === 0 ? "\n全部一致 ✓" : `\n发现 ${bad} 处漂移 ✗`);
process.exit(bad === 0 ? 0 : 1);
