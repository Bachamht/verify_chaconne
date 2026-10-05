"use client";
import Link from "next/link";
import { ArrowRight, Braces, FileCheck, ScrollText, ShieldCheck, type LucideIcon } from "lucide-react";
import { Hash } from "@/components/kit/Hash";
import { PLANGUARD, type HomeCopy } from "./copy";
import { SectionHeading } from "./SectionHeading";

const ICONS: Record<HomeCopy["trust"][number]["key"], LucideIcon> = { evidence: ScrollText, certificate: FileCheck, contract: ShieldCheck };

const LINK = "ch-text-link";

/** 信任区：证据 / 证书 / 合约三件事各一行 + 去处；合约给真实地址（Hash，可跳浏览器） */
export function HomeTrust({ c }: { c: HomeCopy }) {
  return (
    <section aria-labelledby="home-trust-title" className="ch-home-section ch-home-trust">
      <SectionHeading id="home-trust-title" title={c.trustTitle} lead={c.trustLead} eyebrow={c.trustEyebrow} />
      <ul className="ch-trust-list">
        {c.trust.map((t) => {
          const Icon = ICONS[t.key];
          return (
            <li key={t.key} className="ch-trust-item">
              <span className="ch-trust-icon"><Icon className="size-5" aria-hidden="true" /></span>
              <div className="ch-trust-content">
                <h3>{t.title}</h3>
                <p>{t.copy}</p>
                <div className="ch-trust-action">
                  {t.link
                    ? <Link href={t.link.href} className={LINK}>{t.link.label}<ArrowRight className="size-4" aria-hidden="true" /></Link>
                    : <Hash value={PLANGUARD} kind="address" name={c.contractName} />}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 开发者入口单独收尾，保持文档导航与主页主操作层次分明。 */
export function HomeDevRow({ c }: { c: HomeCopy }) {
  return (
    <section aria-labelledby="home-dev-title" className="ch-home-developers">
      <div className="ch-dev-intro">
        <Braces className="size-5 text-brand-300" aria-hidden="true" />
        <div><h2 id="home-dev-title">{c.devTitle}</h2><p>{c.devCopy}</p></div>
      </div>
      <Link href="/developers" className={LINK}>{c.devAction}<ArrowRight className="size-4" aria-hidden="true" /></Link>
    </section>
  );
}
