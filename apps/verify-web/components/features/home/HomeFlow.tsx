"use client";
import { Pause, Play, Route } from "lucide-react";
import type { Locale } from "@/lib/i18n";
import { FLOW_COPY, FLOW_STEPS, FLOW_TAGS, LEGEND, type LegendKey } from "./flowCopy";
import { NoteShape, TOKEN_D } from "./ScoreGlyphs";
import { SCENES } from "./scoreScene";
import { ScoreSvg } from "./ScoreSvg";
import { SectionHeading } from "./SectionHeading";
import { useScorePlayer } from "./useScorePlayer";

/** 图例里的小记号：与画面里的形状、颜色一致 */
function LegendMark({ kind }: { kind: LegendKey }) {
  return (
    <svg viewBox="-9 -15 20 22" className="ch-score-mark" data-kind={kind} aria-hidden="true" focusable="false">
      {kind === "coin" ? <circle cy="-4" r="5.6" /> : kind === "token" ? <path d={TOKEN_D} transform="translate(0 -4)" /> : <NoteShape />}
    </svg>
  );
}

/**
 * 首页 01「怎么运作」：一张与下方示例控制台同款的卡片，里面是一笔交易的示意动画。
 * 小指挥家（Chaconne Agent）发出提案，沿你签下的范围依次经过 01 核验、02 PlanGuard 合约、03 OKX DEX、04 你的钱包；
 * 资金只在 PlanGuard 放行时经额度线划出，越界的提案在 PlanGuard 停下。画面为主，字只留站名、图例与几个标签。
 * 宽屏横版、手机竖版（CSS 切换）；离开视口、点暂停时冻结；减少动态效果时停在一帧静止画面上，也不显示暂停按钮。
 */
export function HomeFlow({ locale }: { locale: Locale }) {
  const f = FLOW_COPY[locale];
  const p = useScorePlayer();
  return (
    <section aria-labelledby="home-flow-title" className="ch-home-section ch-score">
      <SectionHeading id="home-flow-title" eyebrow={f.eyebrow} title={f.title} lead={f.lead} />
      <figure className="ch-score-stage" ref={p.ref}>
        <div className="ch-score-bar">
          <p className="ch-score-bar-title">
            <Route className="size-4" aria-hidden="true" />
            {f.bar}
            <span className="ch-score-bar-note">{f.note}</span>
          </p>
          <ul className="ch-score-legend" aria-hidden="true">
            {LEGEND.map((k) => (
              <li key={k}><LegendMark kind={k} />{f.legend[k]}</li>
            ))}
          </ul>
          <button type="button" className="ch-score-pause" onClick={p.toggle} aria-label={p.paused ? f.play : f.pause}>
            {p.paused ? <Play className="size-3.5" aria-hidden="true" /> : <Pause className="size-3.5" aria-hidden="true" />}
          </button>
        </div>
        <div className="ch-score-body">
          {(["wide", "tall"] as const).map((key) => (
            <div key={key} className={`ch-score-canvas ch-score-${key}`} aria-hidden="true">
              <ScoreSvg scene={SCENES[key]} blocked={f.blocked} />
              {FLOW_TAGS.map((tag) => (
                <span key={tag} className="ch-score-tag" data-at={tag}>
                  {FLOW_STEPS[tag] ? <span className="ch-score-tag-num">{FLOW_STEPS[tag]}</span> : null}
                  {f.tags[tag]}
                </span>
              ))}
            </div>
          ))}
        </div>
        <figcaption className="sr-only">{f.summary}</figcaption>
      </figure>
    </section>
  );
}
