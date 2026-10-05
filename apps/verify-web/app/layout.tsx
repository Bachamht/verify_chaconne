import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { V8Root } from "@/components/shell/V8Root";
import { V8_UI } from "@/lib/v8";

/**
 * v7 页头 / 页脚 / 钱包选择框带 lib/wallet → viem。静态 import 会让 v8 构建的每条路由（含首页）都加载 viem（D6），
 * 所以用内联的构建期常量 + require：v8 构建里 webpack 直接删掉这一支。
 */
const LEGACY = process.env.NEXT_PUBLIC_V8_UI === "1" ? null : {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 构建期删死分支，见上
  Header: (require("@/components/Header") as typeof import("@/components/Header")).Header,
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 构建期删死分支，见上
  Footer: (require("@/components/Footer") as typeof import("@/components/Footer")).Footer,
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 构建期删死分支，见上
  WalletChooser: (require("@/components/WalletChooser") as typeof import("@/components/WalletChooser")).WalletChooser,
};

export const metadata: Metadata = {
  title: "Chaconne Agent — Let the agent trade. Let the contract set the limits.",
  description: "Let your AI assistant buy and sell tokenized US stocks on X Layer. Every order is verified against fresh evidence first, and executed inside boundaries a contract enforces.",
};

/** UI-02：Inter 可变字体自托管（与主站同一文件），中文回退系统字体（globals.css --font-sans） */
const inter = localFont({ src: "./fonts/InterVariable.woff2", variable: "--font-inter", weight: "100 900", display: "swap", preload: true });
/** v8：等宽只给哈希 / 地址 / 代码（JetBrains Mono 自托管，OFL） */
const jbm = localFont({ src: "./fonts/JetBrainsMono-latin-wght.woff2", variable: "--font-jbm", weight: "100 800", display: "swap", preload: false });

/** UV-06：首帧语言 = 主站 pref-locale cookie（有就读）→ Accept-Language → 英文；客户端再按本站显式偏好覆盖 */
async function initialLocale(): Promise<"zh" | "en"> {
  const c = (await cookies()).get("pref-locale")?.value ?? "";
  if (/^zh/i.test(c)) return "zh";
  if (/^en/i.test(c)) return "en";
  const al = (await headers()).get("accept-language") ?? "";
  return /^zh/i.test(al.trim()) ? "zh" : "en";
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await initialLocale();
  if (V8_UI || !LEGACY) {
    return (
      <html lang={locale === "zh" ? "zh-CN" : "en"} data-ui="v8" className={`${inter.variable} ${jbm.variable}`}>
        <head><meta name="theme-color" content="#0d0e12" /></head>{/* ui-lint-ignore：theme-color 必须是字面量 */}
        <body className="bg-background text-foreground">
          <I18nProvider initialLocale={locale}>
            <V8Root>{children}</V8Root>
          </I18nProvider>
        </body>
      </html>
    );
  }
  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} className={inter.variable}>
      <body>
        <I18nProvider initialLocale={locale}>
          <a href="#main-content" className="verify-skip-link">{locale === "zh" ? "跳到主要内容" : "Skip to content"}</a>
          <LEGACY.Header />
          <main id="main-content" className="verify-main" tabIndex={-1}>{children}</main>
          <LEGACY.Footer />
          <LEGACY.WalletChooser />
        </I18nProvider>
      </body>
    </html>
  );
}
