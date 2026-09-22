"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import "./Conductor.css";

export type ConductorState = "idle" | "checking" | "passed" | "blocked" | "expired";

const ASIDES: Record<ConductorState, { zh: string; en: string }> = {
  idle: { zh: "gm。先验一下。", en: "gm. Let's check." },
  checking: { zh: "Trust me bro？我查查。", en: "Trust me bro? Let me check." },
  passed: { zh: "这轮证据，对得上。", en: "These checks line up." },
  blocked: { zh: "这个节拍不对。先等等。", en: "Off beat. Let's pause." },
  expired: { zh: "这份报价，有点凉。", en: "That quote went cold." },
};

/** Decorative feedback only: state comes from the real workflow, never a timer. */
export function Conductor({
  state = "idle",
  variant = "hero",
  locale = "zh",
  className = "",
}: {
  state?: ConductorState;
  variant?: "hero" | "compact";
  locale?: "zh" | "en";
  className?: string;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [take, setTake] = useState(0);
  const zh = locale === "zh";

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  function resetTilt() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    stageRef.current?.style.setProperty("--conductor-rx", "0deg");
    stageRef.current?.style.setProperty("--conductor-ry", "0deg");
  }

  function tilt(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      stageRef.current?.style.setProperty("--conductor-rx", `${-y * 8}deg`);
      stageRef.current?.style.setProperty("--conductor-ry", `${x * 10}deg`);
      frameRef.current = null;
    });
  }

  return (
    <div ref={stageRef} className={`conductor conductor--${variant} ${className}`} data-state={state}>
      <div className="conductor__score" aria-hidden="true">
        <svg viewBox="0 0 560 440" fill="none">
          {[0, 1, 2, 3, 4].map((i) => (
            <path key={i} d={`M-50 ${125 + i * 16} C130 ${310 + i * 16}, 275 ${-20 + i * 16}, 620 ${245 + i * 16}`} pathLength="1" />
          ))}
        </svg>
      </div>
      <div className="conductor__orbit conductor__orbit--one" aria-hidden="true" />
      <div className="conductor__orbit conductor__orbit--two" aria-hidden="true" />
      <span className="conductor__speech" key={state}>{ASIDES[state][locale]}</span>
      <button
        className="conductor__puppet"
        type="button"
        aria-label={zh ? "让差价君挥一次指挥棒" : "Let the conductor strike a beat"}
        title={zh ? "点一下，起拍" : "Tap to strike a beat"}
        onPointerMove={tilt}
        onPointerLeave={resetTilt}
        onBlur={resetTilt}
        onClick={() => setTake((n) => n + 1)}
      >
        <span className="conductor__pose" key={`${state}-${take}`} data-take={take > 0 ? "encore" : "entrance"}>
          <Image
            src="/brand/conductor-v1.jpg"
            alt=""
            width={768}
            height={768}
            sizes={variant === "hero" ? "(max-width: 640px) 84vw, 480px" : "200px"}
            priority={variant === "hero"}
            unoptimized
            draggable={false}
          />
        </span>
      </button>
      {/* 动效一律有限次播放；系统「减少动效」偏好在 Conductor.css 里统一停掉，不再提供手动暂停开关。 */}
      {variant === "hero" && <span className="conductor__sticker" aria-hidden="true">TRUST ME BRO?<strong>SHOW ME PROOF.</strong></span>}
    </div>
  );
}
