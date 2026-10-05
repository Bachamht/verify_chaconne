"use client";
import type { Scene } from "./scoreScene";
import { ScoreActors } from "./ScoreActors";
import { ScoreBackdrop } from "./ScoreBackdrop";
import { NoteShape } from "./ScoreGlyphs";
import { ScoreMaestro } from "./ScoreMaestro";
import { ScoreStations } from "./ScoreStations";

/**
 * 首页「怎么运作」的示意图（宽 / 窄两套布景共用）：纯装饰，读屏读 figcaption。
 * 细线、少色：谱线是墨色，强调色只给会动的东西（提案紫、资金金、代币绿、越界红）和各站一瞬的确认。
 * 颜色全部走 globals.css 里的 .ch-score-* 类（token），这里不写色值；动画是 SMIL，由 useScorePlayer 控制播放。
 */
export function ScoreSvg({ scene, blocked }: { scene: Scene; blocked: string }) {
  const { id, gradient: g } = scene;
  return (
    <svg className="ch-score-svg" viewBox={`0 0 ${scene.w} ${scene.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id("staff")} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
          <stop offset="0" className="ch-score-stop-ink" stopOpacity="0" />
          <stop offset="0.12" className="ch-score-stop-ink" stopOpacity="1" />
          <stop offset="1" className="ch-score-stop-ink" stopOpacity="1" />
        </linearGradient>
        <linearGradient id={id("band")} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
          <stop offset="0" className="ch-score-stop-violet" stopOpacity="0" />
          <stop offset="0.15" className="ch-score-stop-violet" stopOpacity="0.07" />
          <stop offset="1" className="ch-score-stop-violet" stopOpacity="0.04" />
        </linearGradient>
        <radialGradient id={id("halo")}>
          <stop offset="0" className="ch-score-stop-violet" stopOpacity="0.16" />
          <stop offset="1" className="ch-score-stop-violet" stopOpacity="0" />
        </radialGradient>
        <g id={id("note")}>
          <NoteShape />
        </g>
      </defs>
      <ScoreBackdrop scene={scene} />
      <ScoreMaestro scene={scene} />
      <ScoreStations scene={scene} />
      <ScoreActors scene={scene} blocked={blocked} />
    </svg>
  );
}
