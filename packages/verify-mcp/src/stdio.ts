/**
 * stdio 入口：`VERIFY_SERVICE_URL`/`VERIFY_API_KEY`（/`VERIFY_CALLER`）来自环境；日志只走 stderr（stdout 是 JSON-RPC 通道）。
 * 私钥护栏（CV-D08）：拒绝任何 *PRIVATE_KEY* / MNEMONIC / SEED 形态的环境变量，唯一例外 `AGENT_WALLET_PRIVATE_KEY`
 * （用户自己的 Agent 钱包，必须与 AGENT_WALLET_MAX_SPEND_USD、AGENT_WALLET_CHAIN_IDS 同时出现）。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VerifyClient } from "./client";
import { createVerifyMcpServer } from "./server";
import { AgentWallet, agentWalletConfigFromEnv } from "./wallet";
import { ExecutorHeartbeat } from "./heartbeat";

const baseUrl = process.env["VERIFY_SERVICE_URL"] ?? "https://verify.chaconne.xyz";
const apiKey = process.env["VERIFY_API_KEY"] ?? "";
const rpcUrl = process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";

export const AGENT_WALLET_KEY_ENV = "AGENT_WALLET_PRIVATE_KEY";
export function keyGuardViolations(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([k, v]) => !!v && /(PRIVATE_KEY|MNEMONIC|SEED_PHRASE)/i.test(k) && k !== AGENT_WALLET_KEY_ENV)
    .map(([k]) => k);
}

const violations = keyGuardViolations(process.env);
if (violations.length) {
  console.error(`[chaconne-verify-mcp] refusing to start: private-key-like env var(s) ${violations.join(", ")} present. The only key this process may hold is ${AGENT_WALLET_KEY_ENV} (your own agent wallet).`);
  process.exit(1);
}

let wallet: AgentWallet | null = null;
try {
  const cfg = agentWalletConfigFromEnv({ ...process.env, XLAYER_RPC_URL: rpcUrl });
  wallet = cfg ? new AgentWallet(cfg) : null;
} catch (err) {
  console.error(`[chaconne-verify-mcp] refusing to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const caller = process.env["VERIFY_CALLER"] || wallet?.address.toLowerCase() || undefined;

const client = new VerifyClient({ baseUrl, apiKey, caller, payer: wallet?.payer ?? null });
// v6：agent-wallet 模式 = 本进程可能是执行器 → 每 60 s 向 /v1/mandates/:id/executor/heartbeat 报在线（只对本进程授权/执行过的 mandate）
const heartbeat = wallet ? new ExecutorHeartbeat(client, wallet.address) : null;
heartbeat?.start();
const server = createVerifyMcpServer({ client, rpcUrl, wallet, heartbeat });
const transport = new StdioServerTransport();
server.connect(transport).then(
  () => console.error(`[chaconne-verify-mcp] ready → ${baseUrl}${apiKey ? "" : ` | no VERIFY_API_KEY: read-only + free tools only — issue a key for your wallet at ${baseUrl.replace(/\/$/, "")}/agent/keys${caller ? ` (caller ${caller})` : ""}`}${wallet ? ` | agent-wallet ${wallet.address} max $${wallet.cfg.maxSpendUsd} chains ${wallet.chainIds.join(",")} | executor heartbeat 60 s` : " | agent-wallet: off"}`),
  (err) => {
    console.error("[chaconne-verify-mcp] failed:", err);
    process.exit(1);
  },
);
