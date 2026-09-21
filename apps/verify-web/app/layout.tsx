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
  title: "Chaconne Verify — StockProof & RWA Guard",
  description: "Pre-trade verification for tokenized US stocks on X Layer, sold to agents through OKX AI. Immutable evidence-bound reports and constrained execution.",
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
          <Header />
          <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-16 pt-6">{children}</main>
          <Footer />
          <WalletChooser />
        </I18nProvider>
      </body>
    </html>
  );
}
