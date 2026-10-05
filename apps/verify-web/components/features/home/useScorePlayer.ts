"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { STILL_AT } from "./scoreTimeline";

/**
 * 乐谱动画的播放器。动画本身是 SVG 里的 SMIL（一根 12 秒的时间线），这里只决定什么时候走、什么时候停：
 *  - 画面露出 35% 以上才开始播，几乎滚出视口（不到 10%）才停，中间保持原状，避免在边缘来回切换；第一次播放从 0 秒开始；
 *  - 点暂停：冻结在当前画面；
 *  - 系统设置了减少动态效果：不播放，停在 STILL_AT 那一刻的静止画面；
 *  - 宽、窄两套画面只让看得见的那套走（另一套 display: none，一并暂停）。
 */
export function useScorePlayer() {
  const ref = useRef<HTMLElement>(null);
  const started = useRef(new WeakSet<SVGSVGElement>());
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [layout, setLayout] = useState(0);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const narrow = window.matchMedia("(max-width: 767px)");
    const onMotion = () => setReduced(motion.matches);
    const onLayout = () => setLayout((n) => n + 1);
    onMotion();
    motion.addEventListener("change", onMotion);
    narrow.addEventListener("change", onLayout);
    return () => {
      motion.removeEventListener("change", onMotion);
      narrow.removeEventListener("change", onLayout);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => {
      const r = entry?.intersectionRatio ?? 0;
      setInView((prev) => (r >= 0.35 ? true : r < 0.1 ? false : prev));
    }, { threshold: [0, 0.1, 0.35] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const svgs = ref.current?.querySelectorAll<SVGSVGElement>("svg.ch-score-svg") ?? [];
    for (const svg of svgs) {
      if (typeof svg.pauseAnimations !== "function") continue;
      if (reduced) {
        svg.pauseAnimations();
        svg.setCurrentTime(STILL_AT);
        continue;
      }
      if (inView && !paused && svg.getClientRects().length > 0) {
        if (!started.current.has(svg)) {
          started.current.add(svg);
          svg.setCurrentTime(0);
        }
        svg.unpauseAnimations();
      } else {
        svg.pauseAnimations();
      }
    }
  }, [inView, paused, reduced, layout]);

  const toggle = useCallback(() => setPaused((p) => !p), []);
  return { ref, paused, reduced, toggle };
}
