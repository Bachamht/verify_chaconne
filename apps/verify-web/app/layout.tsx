import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { WalletChooser } from "@/components/WalletChooser";

export const metadata: Metadata = {
  title: "Chaconne Verify — Less FOMO. More proof.",
  description: "Check the token, the price and your limits before trading tokenized US stocks. Evidence you can inspect. Execution inside the boundaries you sign.",
};

/** UI-02：Inter 可变字体自托管（与主站同一文件），中文回退系统字体（globals.css --font-sans） */
const inter = localFont({ src: "./fonts/InterVariable.woff2", variable: "--font-inter", weight: "100 900", display: "swap", preload: true });

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
  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} data-demo="0" className={inter.variable}>
      <body>
        <I18nProvider initialLocale={locale}>
          <a href="#main-content" className="verify-skip-link">{locale === "zh" ? "跳到主要内容" : "Skip to content"}</a>
          <Header />
          <main id="main-content" className="verify-main" tabIndex={-1}>{children}</main>
          <Footer />
          <WalletChooser />
        </I18nProvider>
      </body>
    </html>
  );
}
