"use client";
import { fitGlow, type Scene } from "./scoreScene";

/** 底层：小指挥家身后一层很淡的光（同首页 hero）、谱面（你签下的范围）、额度线、五线谱。都是静止的 */
export function ScoreBackdrop({ scene }: { scene: Scene }) {
  const { id, mascot: m } = scene;
  const url = (name: string) => `url(#${id(name)})`;
  const halo = fitGlow(scene, m.x + m.w * 0.52, m.y + m.h * 0.56, m.w * 0.62, m.h * 0.52);
  return (
    <g>
      <ellipse cx={halo.cx} cy={halo.cy} rx={halo.rx} ry={halo.ry} fill={url("halo")} />
      <path d={scene.band} fill={url("band")} />
      <path d={scene.thread} className="ch-score-thread" />
      <g className="ch-score-lanes">
        {scene.lanes.map((l) => (
          <path key={l.k} id={id(`lane${l.k}`)} d={l.d} stroke={url("staff")} strokeOpacity={l.k === 0 ? 0.9 : Math.abs(l.k) === 1 ? 0.65 : 0.42} />
        ))}
      </g>
    </g>
  );
}
