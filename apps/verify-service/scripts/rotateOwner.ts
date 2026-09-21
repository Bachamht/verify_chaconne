/**
 * 部署者/管理员私钥轮换（D-080 角色 3）。仅在运营者明确批准后执行。
 * 在 apps/verify-service 下运行（这里有 viem）：`pnpm --filter @chaconne/verify-service rotate:owner`，
 * 私钥读自 packages/verify-contracts/.env（不在本包 .env 里，避免撞单私钥护栏）。
 *
 *   phase=new      生成新钥匙 → 写入 .env 的 NEW_DEPLOYER_PRIVATE_KEY（600），只打印地址
 *   phase=plan     只读：打印当前 owner / pendingOwner / 余额 / 将要做的三步，不发交易
 *   phase=transfer 旧钥匙调用 transferOwnership(new)（Ownable2Step 第一步，可撤销：再转回自己）
 *   phase=accept   新钥匙调用 acceptOwnership()（第二步，生效）
 *   phase=sweep    旧钥匙把剩余 OKB 转到新地址（留 0，按实时 gas 估算）
 *
 * 环境：DEPLOYER_PRIVATE_KEY（旧）、NEW_DEPLOYER_PRIVATE_KEY（新）、XLAYER_RPC_URL、
 *       TARGETS（逗号分隔的合约地址，默认读 docs/devday-2026/deployments.json 的 guard + planGuard）。
 * 绝不打印任何私钥。证明身份（attestation）与商户、演示钱包不受影响。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
const PHASE = process.env["PHASE"] ?? "plan";
const chain = { id: 196, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });

const OWNABLE2STEP = [
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "pendingOwner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "transferOwnership", inputs: [{ name: "newOwner", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "acceptOwnership", inputs: [], outputs: [], stateMutability: "nonpayable" },
] as const;

function targets(): Hex[] {
  if (process.env["TARGETS"]) return process.env["TARGETS"].split(",").map((s) => s.trim() as Hex).filter(Boolean);
  const d = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "docs", "devday-2026", "deployments.json"), "utf8")) as {
    contracts: Record<string, { address: string | null }>;
  };
  return Object.values(d.contracts).map((c) => c.address).filter((a): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a)) as Hex[];
}

async function main() {
  const oldKey = process.env["DEPLOYER_PRIVATE_KEY"];
  const newKey = process.env["NEW_DEPLOYER_PRIVATE_KEY"];

  if (PHASE === "new") {
    const key = generatePrivateKey();
    const acct = privateKeyToAccount(key);
    appendFileSync(join(process.cwd(), "..", "..", "packages", "verify-contracts", ".env"), `\nNEW_DEPLOYER_PRIVATE_KEY=${key}\n`, { mode: 0o600 });
    console.info("新部署者地址（私钥已追加到 packages/verify-contracts/.env，未打印）：", acct.address);
    console.info("下一步：PHASE=plan 复核，再 PHASE=transfer / accept / sweep。");
    return;
  }

  if (!oldKey) throw new Error("缺 DEPLOYER_PRIVATE_KEY");
  const oldAcct = privateKeyToAccount(oldKey as Hex);
  const newAcct = newKey ? privateKeyToAccount(newKey as Hex) : null;
  const list = targets();

  if (PHASE === "plan") {
    console.info("当前部署者：", oldAcct.address, "余额 OKB:", Number(await pub.getBalance({ address: oldAcct.address })) / 1e18);
    console.info("新部署者：", newAcct?.address ?? "（未生成，先跑 PHASE=new）");
    for (const t of list) {
      const owner = await pub.readContract({ address: t, abi: OWNABLE2STEP, functionName: "owner" });
      const pending = await pub.readContract({ address: t, abi: OWNABLE2STEP, functionName: "pendingOwner" });
      console.info(`合约 ${t}: owner=${owner} pendingOwner=${pending}`);
    }
    console.info("将执行：1) 旧钥匙 transferOwnership(新) × 合约数  2) 新钥匙 acceptOwnership()  3) 旧钥匙 sweep 余额到新地址");
    console.info("证明身份 / x402 商户 / 演示钱包不受影响；signerEpoch 不变。");
    return;
  }

  if (PHASE === "transfer" || PHASE === "accept") {
    if (!newAcct) throw new Error("缺 NEW_DEPLOYER_PRIVATE_KEY");
    const signer = PHASE === "transfer" ? oldAcct : newAcct;
    const wallet = createWalletClient({ account: signer, chain, transport: http(RPC) });
    for (const t of list) {
      const data =
        PHASE === "transfer"
          ? encodeFunctionData({ abi: OWNABLE2STEP, functionName: "transferOwnership", args: [newAcct.address] })
          : encodeFunctionData({ abi: OWNABLE2STEP, functionName: "acceptOwnership" });
      const hash = await wallet.sendTransaction({ to: t, data });
      const r = await pub.waitForTransactionReceipt({ hash });
      console.info(`${PHASE} ${t}: ${hash} status=${r.status}`);
    }
    for (const t of list) {
      console.info(`核对 ${t}: owner=${await pub.readContract({ address: t, abi: OWNABLE2STEP, functionName: "owner" })} pending=${await pub.readContract({ address: t, abi: OWNABLE2STEP, functionName: "pendingOwner" })}`);
    }
    return;
  }

  if (PHASE === "sweep") {
    if (!newAcct) throw new Error("缺 NEW_DEPLOYER_PRIVATE_KEY");
    const wallet = createWalletClient({ account: oldAcct, chain, transport: http(RPC) });
    const bal = await pub.getBalance({ address: oldAcct.address });
    const gasPrice = await pub.getGasPrice();
    const fee = gasPrice * 21_000n * 2n;
    if (bal <= fee) throw new Error("余额不足以支付转账手续费");
    const hash = await wallet.sendTransaction({ to: newAcct.address, value: bal - fee, gas: 21_000n });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.info(`sweep ${hash} status=${r.status}；旧地址剩余 ${Number(await pub.getBalance({ address: oldAcct.address })) / 1e18} OKB`);
    console.info("完成后：把 .env 的 DEPLOYER_PRIVATE_KEY 换成新值、删除 NEW_DEPLOYER_PRIVATE_KEY，并更新 deployments.json 的 owner 地址。");
    return;
  }

  throw new Error(`未知 PHASE=${PHASE}（new|plan|transfer|accept|sweep）`);
}

main().catch((e) => {
  console.error("轮换失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
