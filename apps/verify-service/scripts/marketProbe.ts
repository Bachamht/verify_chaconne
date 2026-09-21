/**
 * 公开行情探针：不起 HTTP/DB，直接用 .env 里的 OKX 凭据构造 XLayerMarket 并打印一份快照（只含公开数据）。
 * 用法：pnpm market:probe（读 apps/verify-service/.env；REGISTRY_FILE 缺省 config/registry.xlayer.v1.1.json）
 */
import { OkxClient } from "../src/adapters/okx/client";
import { loadRegistry } from "../src/registry";
import { XLayerMarket } from "../src/market/xlayer";

async function main(): Promise<void> {
  const e = process.env;
  if (!e.OKX_API_KEY || !e.OKX_SECRET_KEY || !e.OKX_PASSPHRASE) throw new Error("缺 OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE");
  const registry = loadRegistry({ REGISTRY_MODE: "file", REGISTRY_FILE: e.REGISTRY_FILE || "config/registry.xlayer.v1.1.json", EXECUTION_CHAIN_ID: Number(e.EXECUTION_CHAIN_ID || 196) });
  const okx = new OkxClient({ apiKey: e.OKX_API_KEY, secretKey: e.OKX_SECRET_KEY, passphrase: e.OKX_PASSPHRASE, baseUrl: e.OKX_API_BASE_URL || undefined });
  const market = new XLayerMarket({ okx, registry, publicBaseUrl: e.PUBLIC_BASE_URL || undefined });
  const t0 = Date.now();
  const snap = await market.snapshot();
  console.info(JSON.stringify({ elapsedMs: Date.now() - t0, snapshot: snap }, null, 2));
  if (!snap) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
