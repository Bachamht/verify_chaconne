import type { NextConfig } from "next";

/** 独立入口（Chaconne Agent）。CSP：只连自己与 X Layer RPC（钱包注入走 window.ethereum，不需要外部脚本）；
 *  Cloudflare 代理会自动注入 Web Analytics beacon（static.cloudflareinsights.com），放行以免每页一条控制台报错（服务器 2026-09-21 反馈）。 */
const RPC = process.env["NEXT_PUBLIC_XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${RPC} https://rpc.xlayer.tech https://xlayerrpc.okx.com https://cloudflareinsights.com`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // 批次 7：老入口转向（服务端 308，不经过客户端）；路由文件保留只作兜底
  async redirects() {
    return [
      { source: "/play", destination: "/start", permanent: false },
      // v8 把实验页接回来（诊断 / 对照 / 回放）；只在 v8 关闭时继续转向
      ...(process.env["NEXT_PUBLIC_V8_UI"] !== "1" ? [{ source: "/agent/lab", destination: "/agent/tasks", permanent: false }] : []),
      { source: "/me", destination: "/agent/tasks", permanent: false },
    ];
  },
  // 本地 Windows 没有建符号链接的权限时用 VERIFY_WEB_NO_STANDALONE=1 跳过 standalone 产物；服务器发版不设，行为不变
  ...(process.env["VERIFY_WEB_NO_STANDALONE"] === "1" ? {} : { output: "standalone" as const }),
  // 零空窗发版（同主站 FIX-150）：旁路构建到 NEXT_DIST_DIR 再切目录，避免原地构建那 ~2 分钟 chunk 404
  distDir: process.env["NEXT_DIST_DIR"] || ".next",
  poweredByHeader: false,
  // v8 开关缺省 "0"：没设时也要被内联成字面量，路由开关（components/routes/*）的死分支才会在构建期删掉；
  // 否则线上 v7 构建会把 v8 代码一起打包（/start 314 → 417 kB）
  env: { NEXT_PUBLIC_V8_UI: process.env["NEXT_PUBLIC_V8_UI"] ?? "0" },
  // v8：shadcn 从 radix-ui 总包按名导入；让 Next 按需改写成子包导入，避免整包进 bundle（D8）
  experimental: { optimizePackageImports: ["radix-ui", "lucide-react"] },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
