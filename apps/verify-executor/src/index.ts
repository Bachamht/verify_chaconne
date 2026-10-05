/**
 * verify-executor 启动（v7 D-089）：独立进程、独立 .env、独立系统用户。
 * 启动护栏 → 链 id 核对 → 心跳 → 串行主循环。okx_agentic 模式本轮只有占位：命令与参数须以运营者安装版本的官方文档为准，未接入前拒绝启动。
 */
import { ExecSender, viemChainIO } from "@chaconne/verify-exec";
import { loadExecutorConfig } from "./config";
import { HttpServiceApi } from "./client";
import { Executor } from "./executor";

async function main(): Promise<void> {
  const cfg = loadExecutorConfig();
  if (cfg.mode === "okx_agentic" || !cfg.account) {
    throw new Error("EXECUTOR_MODE=okx_agentic 尚未接入（占位）：官方 CLI 的合约调用命令须按运营者安装版本的文档核实后实现；请用 eoa 模式");
  }
  const chain = viemChainIO(cfg.rpcUrl, cfg.chainId);
  const head = await chain.head();
  const sender = new ExecSender(cfg.account, chain, { profile: "hosted", planGuard: cfg.planGuard, tokens: cfg.tokens }, { feeCaps: cfg.feeCaps });
  const ex = new Executor({ api: new HttpServiceApi(cfg.serviceUrl, cfg.apiKey), chain, sender, planGuard: cfg.planGuard, minCertRemainingS: cfg.minCertRemainingS, minOkbWei: cfg.minOkbWei, mode: cfg.mode, version: cfg.version });
  console.info(`[verify-executor] ready: executor ${ex.address} instance ${ex.instanceId} chain ${cfg.chainId} head ${head.number} planGuard ${cfg.planGuard} tokens ${cfg.tokens.size} feeCaps gas≤${cfg.feeCaps.maxGasLimit} maxFee≤${cfg.feeCaps.maxFeePerGas} tip≤${cfg.feeCaps.maxPriorityFeePerGas} tx≤${cfg.feeCaps.maxFeePerTx} minOkb ${cfg.minOkbWei} → ${cfg.serviceUrl}`);
  const stop = () => ex.stop();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await ex.run();
  if (ex.instanceConflict) process.exit(3);
}

main().catch((e) => {
  console.error(`[verify-executor] 启动失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
