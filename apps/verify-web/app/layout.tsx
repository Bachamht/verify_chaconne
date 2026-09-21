import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { WalletChooser } from "@/components/WalletChooser";

export const metadata: Metadata = {
  title: "Chaconne Verify — StockProof & RWA Guard",
  description: "Pre-trade verification for tokenized US stocks on X Layer, sold to agents through OKX AI. Immutable evidence-bound reports and constrained execution.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-demo="0">
      <body>
        <I18nProvider>
          <Header />
          <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6">{children}</main>
          <Footer />
          <WalletChooser />
        </I18nProvider>
      </body>
    </html>
  );
}
