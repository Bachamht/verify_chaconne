// 全仓统一 flat config。
// 决策记录：不用已废弃的 `next lint`，Next 特有问题由 `next build` 兜底（见 the design log）。
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".qa-live/**", // 服务器侧真金测试工件（gitignore，本地存在勿 lint）
      "qa/**", // 真实链路测试装备（qa/real-path）：自带 package.json 的独立子项目，脚本大量在浏览器上下文里执行（document/window），不按仓库规则 lint
      "**/.next/**",
      "**/.next-*/**", // 零空窗发版的旁路构建目录（.next-build / .next-prev）与本地预览产物
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "**/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 纯 JS 脚本（copy-lint 等）运行在 Node：补充运行时全局（TS 文件由 tseslint 关闭 no-undef）
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    rules: {
      // 公式代码里显式 number 转换常见，容忍非空断言以外的宽松写法但保底
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      // 禁止 console.log 误入生产（poller/bot 统一走 logger；web 禁用）
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
  {
    // 参照实现必须保持直白：禁止任何 import（§6.1 禁止与生产实现共享代码）
    files: ["packages/core/src/premium.reference.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["*"] }] }],
    },
  },
);
