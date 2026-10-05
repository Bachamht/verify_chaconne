"use client";
import { Anim } from "./ScoreAnim";
import { MASCOT, type Scene } from "./scoreScene";
import { CUES, flashes, track } from "./scoreTimeline";

/** 小指挥家：每发出一笔提案，身体随拍子轻轻一顿（±1.4°），指挥棒尖亮一下。动作只在拍点上，不漂浮 */
export function ScoreMaestro({ scene }: { scene: Scene }) {
  const { mascot: m, tip } = scene;
  const [px, py] = m.pivot;
  const lean = track(CUES.flatMap((c) => [
    { t: c.at - 0.35, v: `0 ${px} ${py}` },
    { t: c.at - 0.05, v: `-1.4 ${px} ${py}` },
    { t: c.at + 0.25, v: `0.6 ${px} ${py}` },
    { t: c.at + 0.6, v: `0 ${px} ${py}` },
  ]));
  const beats = CUES.map((c) => c.at - 0.04);
  const glint = track(flashes(beats, { rise: 0.08, hold: 0.06, fall: 0.4, lo: 0.35, hi: 1 }));
  const glintSize = track(beats.flatMap((t) => [{ t, v: 1 }, { t: t + 0.14, v: 1.8, ease: "out" as const }, { t: t + 0.55, v: 1 }]));
  return (
    <g>
      <Anim attr="transform" type="rotate" tr={lean} />
      <image href={MASCOT.src} x={m.x} y={m.y} width={m.w} height={m.h} preserveAspectRatio="xMidYMid meet" />
      <g transform={`translate(${tip[0]} ${tip[1]})`}>
        <g className="ch-score-glint" opacity="0.35">
          <Anim attr="opacity" tr={glint} />
          <Anim attr="transform" type="scale" tr={glintSize} />
          <circle r="2.4" />
        </g>
      </g>
    </g>
  );
}
