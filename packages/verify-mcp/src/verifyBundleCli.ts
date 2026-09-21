/**
 * `verify-bundle <bundle.json> [--rpc <url>] [--signer <0x…>]`
 * 离线验证证据包（W3 CLI；检查逻辑 = @chaconne/core/verify verifyBundleOffline + viem 验签），输出 JSON 检查清单；任一项失败退出码 1。
 * `--rpc` 时额外拉链上回执，与包内 receiptSummary 比对 GuardedExecution / MandateStep 事件。
 */
import { readFileSync } from "node:fs";
import type { EvidenceBundle } from "@chaconne/core/verify";
import { verifyBundle } from "./bundleVerify";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--") && !["--rpc", "--signer"].includes(process.argv[process.argv.indexOf(a) - 1] ?? ""));
  if (!file) {
    console.error("usage: verify-bundle <bundle.json> [--rpc <url>] [--signer <0x…>]");
    process.exit(2);
  }
  const bundle = JSON.parse(readFileSync(file, "utf8")) as EvidenceBundle;
  const result = await verifyBundle(bundle, {
    ...(arg("--rpc") ? { rpcUrl: arg("--rpc")! } : {}),
    ...(arg("--signer") ? { expectedSigner: arg("--signer") as `0x${string}` } : {}),
  });
  process.stdout.write(JSON.stringify({ file, ...result }, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}
main().catch((e) => {
  console.error("verify-bundle failed:", e instanceof Error ? e.message : e);
  process.exit(2);
});
