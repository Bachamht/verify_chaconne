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
  output: "standalone",
  // 零空窗发版（同主站 FIX-150）：旁路构建到 NEXT_DIST_DIR 再切目录，避免原地构建那 ~2 分钟 chunk 404
  distDir: process.env["NEXT_DIST_DIR"] || ".next",
  poweredByHeader: false,
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
