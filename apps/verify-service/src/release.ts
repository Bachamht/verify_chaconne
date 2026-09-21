/**
 * 发布指纹（公开源码可验证性）：`apps/verify-service/release.json` 由私有仓的导出脚本在每次生成公开快照时写入，
 * 内容是公开快照全树的确定性哈希（treeHash）。线上 `GET /healthz` 原样回显，评审 clone 公开仓库后
 * `pnpm release:hash` 复算即可确认线上跑的就是公开的这一份。文件缺失/损坏 → null，不影响服务。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseInfo {
  treeHash: string;
  exportedAt: string;
}

export function loadRelease(path = join(dirname(fileURLToPath(import.meta.url)), "..", "release.json")): ReleaseInfo | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { treeHash?: unknown; exportedAt?: unknown };
    if (typeof raw.treeHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.treeHash) || typeof raw.exportedAt !== "string") return null;
    return { treeHash: raw.treeHash, exportedAt: raw.exportedAt };
  } catch {
    return null;
  }
}
