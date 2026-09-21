import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 每个用例都起一套 PGlite（WASM 冷启动）；机器负载高或评审机较慢时 30s 会误超时（复跑即过），放宽到 90s/60s
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
