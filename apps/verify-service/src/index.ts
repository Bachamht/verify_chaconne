/**
 * verify-service 启动：独立进程、独立 .env、独立端口（D-080）。
 * 启动护栏：配置组合（O-01）、私钥范围（只允许证明签名私钥）、登记表校验、fixture/生产互斥。
 * 装配在 assemble.ts（本地分叉 e2e 复用同一份装配）。
 */
import { assertOnlyAttestationKey, loadConfig } from "./config";
import { openDb } from "./db";
import { assembleService } from "./assemble";
import { log } from "./log";

async function main(): Promise<void> {
  assertOnlyAttestationKey();
  const cfg = loadConfig();
  const { db } = await openDb(cfg.DATABASE_URL);
  const svc = await assembleService(cfg, { db });
  const stop = svc.start();
  const server = svc.app.listen(cfg.VERIFY_PORT, cfg.VERIFY_HOST, () => {
    log.info("verify-service 已启动", {
      host: cfg.VERIFY_HOST,
      port: cfg.VERIFY_PORT,
      evidenceMode: cfg.EVIDENCE_MODE,
      registry: svc.registry.version,
      paid: cfg.paid,
      network: cfg.PAYMENT_NETWORK,
      attestation: svc.signer ? svc.signer.address : "disabled",
    });
  });
  const shutdown = () => {
    stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("启动失败", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
