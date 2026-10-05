"use client";
import type { Locale } from "@/lib/i18n";
import type { HomeCopy } from "./copy";
import { SectionHeading } from "./SectionHeading";

/** 开放式的三步说明；序号仅表示开始顺序，不显示成已完成的任务状态。 */
export function HomeSteps({ c, locale }: { c: HomeCopy; locale: Locale }) {
  return (
    <section aria-labelledby="home-steps-title" className="ch-home-section ch-home-steps">
      <SectionHeading id="home-steps-title" title={c.stepsTitle} eyebrow={c.stepsEyebrow} />
      <ol className="ch-step-grid" aria-label={c.stepsTitle} lang={locale === "zh" ? "zh-CN" : "en"}>
        {c.steps.map((step, index) => (
          <li key={step.title} className="ch-step-item">
            <span className="ch-step-number" aria-hidden="true">0{index + 1}</span>
            <h3>{step.title}</h3>
            <p>{step.copy}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
