"use client";
import { Mascot } from "@/components/kit/Mascot";

/** 原有吉祥物的静态舞台。轨道只是视觉装饰，不代表实时状态或任务进度。 */
export default function HeroMascot({ speech, alt, stages, note }: { speech: string; alt: string; stages: readonly string[]; note: string }) {
  return (
    <figure className="ch-hero-visual">
      <div className="ch-hero-stage">
        <span className="ch-hero-orbit ch-hero-orbit-outer" aria-hidden="true" />
        <span className="ch-hero-orbit ch-hero-orbit-inner" aria-hidden="true" />
        <span className="ch-hero-crosshair ch-hero-crosshair-top" aria-hidden="true" />
        <span className="ch-hero-crosshair ch-hero-crosshair-bottom" aria-hidden="true" />
        <Mascot size="hero" alt={alt} priority className="ch-hero-mascot" />
        <span className="ch-hero-speech">{speech}</span>
      </div>
      <figcaption className="ch-hero-caption">
        <ol className="ch-hero-stages">
          {stages.map((stage, index) => (
            <li key={stage}><span aria-hidden="true">0{index + 1}</span>{stage}</li>
          ))}
        </ol>
        <p>{note}</p>
      </figcaption>
    </figure>
  );
}
