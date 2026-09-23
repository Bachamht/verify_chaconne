/**
 * 本地端到端启动器：起一套 pglite 版 verify-service（fixture 登记表 + Lane A 样本公钥），
 * 用子进程跑 scripts/e2eAgentTask.ts（与打生产用的是同一份脚本），证据落到仓库根 verify-evidence/v6/。
 * 默认跳过（要跑 ~1 分钟且会写证据目录）：E2E_LOCAL=1 pnpm --filter verify-service exec vitest run test/e2eLocal.test.ts
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestEnv, TEST_API_KEY, TEST_CALLER, TEST_OWNER_KEY } from "./helpers";
import { CROWSNEST_FIXTURES } from "./contextHelpers";
import { OWNER } from "./v6helpers";

const RUN = process.env["E2E_LOCAL"] === "1";
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

describe.skipIf(!RUN)("e2eAgentTask 本地联调（pglite）", () => {
  it("全阶段跑通：X/E/Y/B/T/K/Q/L/R/O 无 FAIL", async () => {
    // 与 context.test.ts 的 X-01 样本用例同一把 Lane A 开发公钥（golden 里带 publicKeyHex）；时钟落在样本 packagedAt 之后 5 分钟
    const g = JSON.parse(readFileSync(join(CROWSNEST_FIXTURES, "context_canon_1_edge.json"), "utf8")) as { publicKeyHex: string };
    const env = await createTestEnv({ now: "2026-09-23T10:05:00.000Z", crowsnestPubkey: `crowsnest-ctx-k1=${g.publicKeyHex}`, wire: "production" });
    try {
      const out: string[] = [];
      const code = await new Promise<number>((res, rej) => {
        const child = spawn(join(__dirname, "..", "node_modules", ".bin", "tsx"), ["scripts/e2eAgentTask.ts", ...(process.env["E2E_ARGS"]?.split(" ").filter(Boolean) ?? [])], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            VERIFY_SERVICE_URL: env.url,
            VERIFY_API_KEY: TEST_API_KEY,
            VERIFY_CALLER: TEST_CALLER,
            OWNER,
            E2E_OWNER_PRIVATE_KEY: TEST_OWNER_KEY,
            E2E_CONTEXT_SAMPLE: join(CROWSNEST_FIXTURES, "sample_context.agent.json"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (d: Buffer) => { const t = d.toString(); out.push(t); process.stdout.write(t); });
        child.stderr.on("data", (d: Buffer) => { const t = d.toString(); out.push(t); process.stderr.write(t); });
        child.on("error", rej);
        child.on("close", (c) => res(c ?? 1));
      });
      const text = out.join("");
      expect(text, "脚本必须输出汇总").toMatch(/PASS \d+/);
      expect(text.match(/\[FAIL\]/g) ?? [], "不允许任何 FAIL 阶段").toHaveLength(0);
      expect(code).toBe(0);
    } finally {
      await env.close();
    }
  }, 300_000);
});
