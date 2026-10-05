"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import type { HomeCopy } from "./copy";

/** 吉祥物无交互：单独拆包（服务端照常渲染），首屏水合包里不带 next/image */
const HeroMascot = dynamic(() => import("./HeroMascot"));

/** 编辑式首屏：左侧目标与入口，右侧原有吉祥物；集成条仅说明实际技术用途。 */
export function HomeHero({ c }: { c: HomeCopy }) {
  return (
    <section aria-labelledby="home-title" className="ch-home-intro">
      <div className="ch-home-hero">
        <div className="ch-hero-copy">
          <p className="ch-eyebrow"><span className="ch-eyebrow-mark" aria-hidden="true" />{c.overline}</p>
          <h1 id="home-title" className="ch-hero-title">
            {c.titleLead}
            <br />
            <span className="ch-hero-emphasis">{c.titleEm}</span>
          </h1>
          <p className="ch-hero-lead">{c.lead}</p>
          <div className="ch-hero-actions">
            <Link href="/start" className={buttonVariants({ size: "lg" })}>{c.ctaStart}<ArrowUpRight aria-hidden="true" /></Link>
            <Link href="/agent" className="ch-text-link">
              {c.ctaWorkspace}<ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
          <ul className="ch-hero-reassurance">
            {c.reassurance.map((r) => (
              <li key={r}><Check className="size-3.5 text-brand-300" aria-hidden="true" />{r}</li>
            ))}
          </ul>
        </div>
        <HeroMascot speech={c.speech} alt={c.mascotAlt} stages={c.stages} note={c.stageNote} />
      </div>
      <div className="ch-integration-strip">
        <p className="ch-integration-label">{c.integrationsLabel}</p>
        <ul className="ch-integration-list">
          {c.integrations.map((integration) => (
            <li key={integration.name}>
              <span className="ch-integration-name">{integration.name}</span>
              <span className="ch-integration-role">{integration.role}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
