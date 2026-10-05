"use client";
import { LOOP, type Track } from "./scoreTimeline";

/**
 * 一条 SMIL 动画：整轮循环（begin=0、dur=LOOP），样条缓动。所有动画共用这一根时间线，
 * 所以 svg.pauseAnimations / setCurrentTime 能让整幅画一起停、一起跳。
 */
export function Anim({ attr, tr, type }: { attr: string; tr: Track; type?: "rotate" | "scale" | "translate" }) {
  const common = { dur: `${LOOP}s`, begin: "0s", repeatCount: "indefinite", calcMode: "spline", keyTimes: tr.keyTimes, keySplines: tr.keySplines, values: tr.values };
  return type ? <animateTransform attributeName={attr} type={type} {...common} /> : <animate attributeName={attr} {...common} />;
}

/** 沿路径（mpath 引用的 path id）移动；keyPoints 是走到路径的几成 */
export function Move({ path, tr }: { path: string; tr: Track }) {
  return (
    <animateMotion dur={`${LOOP}s`} begin="0s" repeatCount="indefinite" calcMode="spline" keyTimes={tr.keyTimes} keyPoints={tr.values} keySplines={tr.keySplines}>
      <mpath href={`#${path}`} />
    </animateMotion>
  );
}
