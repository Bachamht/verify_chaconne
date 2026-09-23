/**
 * 把 xlayer-registry/1.2.0 的放行清单同步到两个合约的白名单（Guard v1 + PlanGuard v2）。
 *
 * 只增不减：`registryEnabled` 与 `tokenEnabled` 都是 mapping，新指纹启用后 1.1.0 仍然有效，
 * 现有 AAPLx / NVDAx 的执行链路在整个过程中一秒都不中断，进行到一半中断也不会把线上打坏。
 * 幂等：每一项先读链上状态，已经是目标值就跳过，可反复重跑。
 *
 *   DRY_RUN=1 node packages/verify-contracts/script/promoteV12.mjs   # 只打印要发什么，不上链
 *   node packages/verify-contracts/script/promoteV12.mjs             # 真发
 */
import { createPublicClient, createWalletClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";
const DRY = process.env.DRY_RUN === "1";
const NEW_HASH = "0x38a3249b8cac35cdfd6c7e80a2ee96c6a3461ad006b5087d73e29d21f21fe5f1";
const CONTRACTS = [
  ["Guard v1", getAddress("0x02834e26bbd851eedb888bafba666bc0af72770c")],
  ["PlanGuard v2", getAddress("0xE8517f296211F4b9175796bAAB47979FB14Fd2F0")],
];
const ABI = [
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "registryEnabled", type: "function", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { name: "tokenEnabled", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { name: "setRegistry", type: "function", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bool" }], outputs: [] },
  { name: "setToken", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
];

const reg = JSON.parse(readFileSync(join(HERE, "..", "..", "..", "apps", "verify-service", "config", "registry.xlayer.v1.2.json"), "utf8"));
const allow = reg.entries.filter((e) => e.executionAllowed).map((e) => ({ sym: e.displaySymbol, addr: getAddress(e.tokenAddress) }));
const skipped = reg.entries.filter((e) => !e.executionAllowed).map((e) => e.displaySymbol);

const pub = createPublicClient({ transport: http(RPC) });
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key) { console.error("缺 DEPLOYER_PRIVATE_KEY"); process.exit(1); }
const account = privateKeyToAccount(key);
const chain = { id: 196, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

console.log(`登记表 ${reg.version}  指纹 ${NEW_HASH}`);
console.log(`放行 ${allow.length} 项（含 3 个稳定币）；不放行：${skipped.join(", ") || "无"}`);
console.log(`发起账户 ${account.address}${DRY ? "   [DRY_RUN：不上链]" : ""}\n`);

let sent = 0, skippedTx = 0;
for (const [name, addr] of CONTRACTS) {
  const owner = await pub.readContract({ address: addr, abi: ABI, functionName: "owner" });
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`  ✗ ${name} 的 owner 是 ${owner}，与发起账户不符，中止`);
    process.exit(2);
  }
  console.log(`== ${name} ${addr} ==`);
  const regOn = await pub.readContract({ address: addr, abi: ABI, functionName: "registryEnabled", args: [NEW_HASH] });
  if (regOn) { console.log("  registry 指纹已启用，跳过"); skippedTx++; }
  else if (DRY) { console.log("  [DRY] setRegistry(新指纹, true)"); sent++; }
  else {
    const h = await wallet.writeContract({ address: addr, abi: ABI, functionName: "setRegistry", args: [NEW_HASH, true] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  setRegistry ✓ ${h}`);
    sent++;
  }
  for (const { sym, addr: t } of allow) {
    const on = await pub.readContract({ address: addr, abi: ABI, functionName: "tokenEnabled", args: [t] });
    if (on) { skippedTx++; continue; }
    if (DRY) { console.log(`  [DRY] setToken(${sym}, true)`); sent++; continue; }
    const h = await wallet.writeContract({ address: addr, abi: ABI, functionName: "setToken", args: [t, true] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  setToken ${sym.padEnd(8)} ✓ ${h.slice(0, 14)}…`);
    sent++;
  }
}
console.log(`\n${DRY ? "将要发出" : "已发出"} ${sent} 笔；已是目标值而跳过 ${skippedTx} 项`);
