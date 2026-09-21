/** 战报文案模板：状态 × 角色语气 → 标题。只影响文案，不触碰任何规则/授权（C-01）。 */
import type { PersonaId, ShareStatus } from "@chaconne/core/verify";

type Tone = "calm" | "playful" | "terse";
const TONE_BY_PERSONA: Record<PersonaId, Tone> = { turtle_drummer: "calm", cat_conductor: "playful", ox_bassist: "terse" };

const HEADLINES: Record<ShareStatus, Record<Tone, { en: string; zh: string }>> = {
  completed: {
    calm: { en: "Done, in time, within bounds.", zh: "按拍完成，没越线。" },
    playful: { en: "Every note checked before the downbeat — and it landed.", zh: "每一页谱都核过了，下拍落地。" },
    terse: { en: "Filled. Verified.", zh: "成交。已核。" },
  },
  partial: {
    calm: { en: "Part of the goal, honestly labelled as part.", zh: "完成了一部分，并如实标为一部分。" },
    playful: { en: "Half the score played beautifully; the rest waits.", zh: "半页乐谱奏得漂亮，其余等着。" },
    terse: { en: "Partial. Not the original goal.", zh: "部分。非原目标。" },
  },
  waiting: {
    calm: { en: "Holding tempo until the condition returns.", zh: "稳住节奏，等条件回来。" },
    playful: { en: "Baton up. Waiting for the orchestra to open.", zh: "指挥棒举着，等乐团开门。" },
    terse: { en: "Waiting.", zh: "等待中。" },
  },
  rejected: {
    calm: { en: "Rejected — the correct answer today.", zh: "拒绝 — 这是今天的正确答案。" },
    playful: { en: "Not this bar. The rule said no, and the rule is right.", zh: "这一小节不行。规则说不，规则是对的。" },
    terse: { en: "Rejected. Correctly.", zh: "拒绝。正确。" },
  },
  simulation: {
    calm: { en: "A rehearsal on real data, nothing moved.", zh: "用真实数据排练一次，什么都没动。" },
    playful: { en: "Dress rehearsal! Real scores, no tickets sold.", zh: "带妆彩排！真谱子，不卖票。" },
    terse: { en: "Simulation only.", zh: "仅模拟。" },
  },
};

export function headline(status: ShareStatus, personaId: PersonaId | null, locale: "en" | "zh"): string {
  const tone = personaId ? TONE_BY_PERSONA[personaId] : "calm";
  return HEADLINES[status][tone][locale];
}
