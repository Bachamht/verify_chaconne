"use client";
/** 三个原创 SVG 形象（自绘，无任何已有 IP）：乌龟鼓手 / 猫指挥 / 牛贝斯手。语气只影响文案。 */
import type { PersonaId } from "@chaconne/core/verify";

export const PERSONAS: Record<PersonaId, { name: { en: string; zh: string }; tone: "calm" | "playful" | "terse"; blurb: { en: string; zh: string } }> = {
  turtle_drummer: { name: { en: "Tempo the Turtle", zh: "节拍龟" }, tone: "calm", blurb: { en: "Keeps time. Never rushes an execution.", zh: "稳住节奏，从不抢拍执行。" } },
  cat_conductor: { name: { en: "Maestra Cat", zh: "猫指挥" }, tone: "playful", blurb: { en: "Reads every score before the downbeat.", zh: "下拍前把每一页谱子都读完。" } },
  ox_bassist: { name: { en: "Bassline Ox", zh: "低音牛" }, tone: "terse", blurb: { en: "Holds the bottom line. Says little.", zh: "守住底线，话少。" } },
};

export function PersonaArt({ id, size = 96 }: { id: PersonaId; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 100 100", role: "img" as const };
  if (id === "turtle_drummer")
    return (
      <svg {...common} aria-label="turtle drummer">
        <ellipse cx="50" cy="62" rx="32" ry="20" fill="#3f8f5f" />
        <path d="M28 60 Q50 30 72 60" fill="#2f6f47" />
        <circle cx="80" cy="50" r="9" fill="#7bc98f" />
        <circle cx="83" cy="48" r="2" fill="#0b1a12" />
        <rect x="18" y="74" width="16" height="10" rx="3" fill="#2f6f47" />
        <rect x="66" y="74" width="16" height="10" rx="3" fill="#2f6f47" />
        <ellipse cx="34" cy="84" rx="18" ry="6" fill="#c9a44a" />
        <rect x="26" y="70" width="16" height="12" rx="2" fill="#e0c063" />
        <line x1="44" y1="40" x2="60" y2="20" stroke="#f2e9c8" strokeWidth="3" />
        <line x1="40" y1="44" x2="24" y2="26" stroke="#f2e9c8" strokeWidth="3" />
      </svg>
    );
  if (id === "cat_conductor")
    return (
      <svg {...common} aria-label="cat conductor">
        <path d="M30 40 L36 18 L48 34 Z" fill="#8b6cf6" />
        <path d="M70 40 L64 18 L52 34 Z" fill="#8b6cf6" />
        <circle cx="50" cy="48" r="22" fill="#a78bfa" />
        <circle cx="42" cy="46" r="3" fill="#0b0b1a" />
        <circle cx="58" cy="46" r="3" fill="#0b0b1a" />
        <path d="M46 56 Q50 60 54 56" stroke="#0b0b1a" strokeWidth="2" fill="none" />
        <rect x="36" y="68" width="28" height="22" rx="6" fill="#1f1b3a" />
        <line x1="64" y1="70" x2="88" y2="30" stroke="#f2e9c8" strokeWidth="3" />
        <circle cx="88" cy="30" r="3" fill="#f2e9c8" />
      </svg>
    );
  return (
    <svg {...common} aria-label="ox bassist">
      <path d="M26 34 Q18 20 30 22" stroke="#d9d0c1" strokeWidth="4" fill="none" />
      <path d="M74 34 Q82 20 70 22" stroke="#d9d0c1" strokeWidth="4" fill="none" />
      <rect x="28" y="30" width="44" height="36" rx="12" fill="#6b4f3a" />
      <rect x="36" y="52" width="28" height="14" rx="7" fill="#c9a98f" />
      <circle cx="42" cy="44" r="3" fill="#0b0b0b" />
      <circle cx="58" cy="44" r="3" fill="#0b0b0b" />
      <rect x="20" y="70" width="60" height="18" rx="6" fill="#2a2320" />
      <rect x="24" y="74" width="52" height="3" fill="#c9a44a" />
      <rect x="24" y="80" width="52" height="3" fill="#c9a44a" />
      <rect x="70" y="60" width="6" height="30" fill="#3d332e" />
    </svg>
  );
}
