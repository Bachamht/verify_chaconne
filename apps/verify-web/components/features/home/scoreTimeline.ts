/**
 * 首页「怎么运作」示意动画的时间轴（纯函数，单测见 test/v8HomeFlow.test.ts）。
 * 一轮 LOOP 秒；所有 SMIL 动画都是 begin=0、dur=LOOP、无限循环，事件靠 keyTimes 排在同一根时间线上，
 * 所以暂停、继续、跳到某一刻（svg.pauseAnimations / setCurrentTime）时，提案、资金、代币、各站的提示和小指挥家永远对得上。
 */
export const LOOP = 12;
/** 减少动态效果时停在这一刻：PlanGuard 刚拦下越界的提案，下一笔正在核验处打勾，它的资金刚离开钱包 */
export const STILL_AT = 7.1;

export interface Cue { readonly at: number; readonly lane: number; readonly rogue?: boolean }
/** 一轮里的五笔提案：四笔在你签的范围内，第三笔越界，在 PlanGuard 被拦下 */
export const CUES: readonly Cue[] = [
  { at: 0.35, lane: -1 },
  { at: 2.05, lane: 1 },
  { at: 3.95, lane: 0, rogue: true },
  { at: 5.6, lane: 0 },
  { at: 6.8, lane: -1 },
];

/** 一笔提案从出现到代币回到钱包的节拍（秒，相对它出现的时刻） */
export const BEAT = {
  spawn: 0.25, //    从指挥棒尖出来
  verify: 1.3, //    到核验
  verifyOut: 1.7, // 核验通过，继续走
  guard: 2.4, //     到 PlanGuard
  merged: 2.7, //    提案交给合约
  coinOut: 1.3, //   核验通过后，资金才沿额度线离开钱包
  coinAttach: 2.35, // 到 PlanGuard
  coinCenter: 2.6, // 合约放行
  coinGo: 2.75,
  dex: 3.25, //      到 OKX DEX 成交
  tokenOut: 3.35, // 换成代币
  wallet: 4.2, //    代币回到钱包
  done: 4.4,
} as const;
/** 越界的提案到达 PlanGuard 的时刻（相对出现时刻） */
export const IMPACT = BEAT.guard + 0.1;

export type Ease = "inOut" | "out" | "in" | "linear";
const SPLINE: Record<Ease, string> = { inOut: "0.45 0 0.55 1", out: "0.2 0.7 0.4 1", in: "0.55 0 0.85 0.4", linear: "0 0 1 1" };

/** 关键帧：t 秒时取值 v；ease 是从上一帧走到这一帧的缓动 */
export interface Key { readonly t: number; readonly v: number | string; readonly ease?: Ease }
export interface Track { readonly keyTimes: string; readonly values: string; readonly keySplines: string }

const fmt = (v: number | string) => (typeof v === "number" ? String(Math.round(v * 10000) / 10000) : v);

/** 关键帧 → 一整轮的 keyTimes / values / keySplines：首尾补到 0 与 LOOP，同一时刻的帧往后错开一点，取值不变的区间走直线 */
export function track(keys: readonly Key[]): Track {
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const first = sorted[0];
  if (!first) throw new Error("score track: no keys");
  if (first.t < 0) throw new Error(`score track: key at ${first.t}s is before the loop starts`);
  const out: Key[] = first.t > 0 ? [{ t: 0, v: first.v }] : [];
  for (const k of sorted) {
    const prev = out[out.length - 1];
    out.push(prev && k.t <= prev.t ? { ...k, t: prev.t + 0.004 } : k);
  }
  const end = out[out.length - 1]!;
  if (end.t > LOOP) throw new Error(`score track: key at ${end.t}s is past the ${LOOP}s loop`);
  if (end.t < LOOP) out.push({ t: LOOP, v: end.v });
  return {
    keyTimes: out.map((k) => String(Math.round((k.t / LOOP) * 100000) / 100000)).join(";"),
    values: out.map((k) => fmt(k.v)).join(";"),
    keySplines: out.slice(1).map((k, i) => (fmt(k.v) === fmt(out[i]!.v) ? SPLINE.linear : SPLINE[k.ease ?? "inOut"])).join(";"),
  };
}

/** 一串闪光：每个时刻 t 先升到 hi（rise 秒），停 hold 秒，再落回 lo（fall 秒） */
export function flashes(times: readonly number[], o: { rise: number; hold?: number; fall: number; lo?: number; hi?: number }): Key[] {
  const lo = o.lo ?? 0;
  const hi = o.hi ?? 1;
  return times.flatMap((t) => [
    { t, v: lo },
    { t: t + o.rise, v: hi, ease: "out" as const },
    { t: t + o.rise + (o.hold ?? 0), v: hi },
    { t: t + o.rise + (o.hold ?? 0) + o.fall, v: lo, ease: "inOut" as const },
  ]);
}

/** 一串涟漪：每个时刻从 1 放大到 to（dur 秒），看不见时瞬间回到 1；配合 rippleFade 一起用 */
export function rippleScale(times: readonly number[], dur: number, to: number): Key[] {
  return times.flatMap((t) => [{ t, v: 1 }, { t: t + dur, v: to, ease: "out" as const }, { t: t + dur + 0.004, v: 1 }]);
}
export function rippleFade(times: readonly number[], dur: number, hi = 0.8): Key[] {
  return times.flatMap((t) => [{ t, v: 0 }, { t: t + 0.06, v: hi, ease: "out" as const }, { t: t + dur, v: 0, ease: "out" as const }]);
}

export const normalCues = CUES.filter((c) => !c.rogue);
export const rogueCue = CUES.find((c) => c.rogue)!;
/** 某个节拍在一轮里的绝对时刻（所有按谱演奏的音） */
export const beatTimes = (beat: number, cues: readonly Cue[] = normalCues) => cues.map((c) => c.at + beat);
