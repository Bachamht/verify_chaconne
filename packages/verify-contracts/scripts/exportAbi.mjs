// 从 forge 产物导出 ABI（供 verify-service / verify-web / mcp 消费；与 src/execution/guardAbi.ts 对齐检查）
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
mkdirSync("abi", { recursive: true });
for (const name of ["ChaconneVerifyGuard", "ChaconneVerifyPlanGuard"]) {
  const art = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, "utf8"));
  writeFileSync(`abi/${name}.json`, JSON.stringify({ abi: art.abi, bytecodeHash: art.bytecode?.object ? `${art.bytecode.object.length / 2 - 1} bytes` : null }, null, 2) + "\n");
  console.info(`abi/${name}.json written,`, art.abi.length, "entries");
}
