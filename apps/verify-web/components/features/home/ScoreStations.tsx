"use client";
import { ArrowLeftRight, Wallet } from "lucide-react";
import { Anim } from "./ScoreAnim";
import { SHIELD_D, type Scene } from "./scoreScene";
import { BEAT, beatTimes, flashes, IMPACT, rippleFade, rippleScale, rogueCue, track } from "./scoreTimeline";

const CHECK_D = "M-3.6 0.2L-1.1 2.7L3.8 -2.8";
const CROSS_D = "M-2.9 -2.9L2.9 2.9M2.9 -2.9L-2.9 2.9";

/** 各站：01 核验、02 PlanGuard 合约、03 OKX DEX、04 你的钱包。外形常驻；提案经过时，只有描边亮一下（时刻来自 scoreTimeline） */
export function ScoreStations({ scene }: { scene: Scene }) {
  const { stations: st, wallet: w, ring, shield: sh, dex } = scene;
  const v = st.verify;
  const g = st.guard;
  const d = st.dex;
  const a = ring.across;
  const ellipse = `M0 ${-a}A${ring.along} ${a} 0 1 1 0 ${a}A${ring.along} ${a} 0 1 1 0 ${-a}`;

  const verifyOk = track(flashes(beatTimes(BEAT.verify), { rise: 0.12, hold: 0.3, fall: 0.45 }));
  const verifyBad = track(flashes([rogueCue.at + BEAT.verify], { rise: 0.1, hold: 0.55, fall: 0.45 }));
  const pass = beatTimes(BEAT.coinCenter);
  const guardOk = track(flashes(pass, { rise: 0.1, hold: 0.2, fall: 0.5 }));
  const guardRing = track(rippleScale(pass, 0.8, 1.22));
  const guardRingFade = track(rippleFade(pass, 0.8, 0.5));
  const guardBad = track(flashes([rogueCue.at + IMPACT], { rise: 0.08, hold: 0.6, fall: 0.6 }));
  const dexOn = track(flashes(beatTimes(BEAT.dex), { rise: 0.1, hold: 0.15, fall: 0.5 }));
  const land = beatTimes(BEAT.wallet);
  const walletOn = track(flashes(land, { rise: 0.1, hold: 0.15, fall: 0.5 }));
  const walletRing = track(rippleScale(land, 0.8, 1.45));
  const walletRingFade = track(rippleFade(land, 0.8, 0.55));
  return (
    <g>
      <g transform={`translate(${v.x} ${v.y}) rotate(${v.angle})`}>
        <path d={`M0 ${-a}A${ring.along} ${a} 0 0 0 0 ${a}`} className="ch-score-ring ch-score-ring-back" />
        <path d={`M0 ${-a}A${ring.along} ${a} 0 0 1 0 ${a}`} className="ch-score-ring" />
        <g className="ch-score-ring-ok" opacity="0">
          <Anim attr="opacity" tr={verifyOk} />
          <path d={ellipse} />
        </g>
        <g className="ch-score-ring-bad" opacity="0">
          <Anim attr="opacity" tr={verifyBad} />
          <path d={ellipse} />
        </g>
        <g transform={`translate(0 ${scene.badge * (a + 13)}) rotate(${-v.angle})`}>
          <g className="ch-score-badge" data-tone="ok" opacity="0">
            <Anim attr="opacity" tr={verifyOk} />
            <circle r="8" />
            <path d={CHECK_D} />
          </g>
          <g className="ch-score-badge" data-tone="bad" opacity="0">
            <Anim attr="opacity" tr={verifyBad} />
            <circle r="8" />
            <path d={CROSS_D} />
          </g>
        </g>
      </g>

      <g transform={`translate(${g.x} ${g.y})`}>
        <path d={SHIELD_D} transform={`scale(${sh})`} className="ch-score-shield-fill" />
        <path d={SHIELD_D} transform={`scale(${sh * 0.8})`} className="ch-score-shield-inner" />
        <path d={SHIELD_D} transform={`scale(${sh})`} className="ch-score-shield" />
        <g opacity="0">
          <Anim attr="opacity" tr={guardOk} />
          <path d={SHIELD_D} transform={`scale(${sh})`} className="ch-score-shield-lit" />
        </g>
        <g opacity="0">
          <Anim attr="opacity" tr={guardRingFade} />
          <g>
            <Anim attr="transform" type="scale" tr={guardRing} />
            <path d={SHIELD_D} transform={`scale(${sh})`} className="ch-score-shield-ripple" />
          </g>
        </g>
        <g opacity="0">
          <Anim attr="opacity" tr={guardBad} />
          <path d={SHIELD_D} transform={`scale(${sh})`} className="ch-score-shield-bad" />
        </g>
      </g>

      <g transform={`translate(${d.x} ${d.y})`}>
        <circle r={dex} className="ch-score-node" />
        <g opacity="0">
          <Anim attr="opacity" tr={dexOn} />
          <circle r={dex} className="ch-score-node-lit" />
        </g>
        <ArrowLeftRight x={-dex * 0.5} y={-dex * 0.5} width={dex} height={dex} strokeWidth={1.6} className="ch-score-node-icon" aria-hidden="true" />
      </g>

      <g transform={`translate(${w.x} ${w.y})`}>
        <circle r={w.r} className="ch-score-wallet" />
        <circle r={w.r * 0.78} className="ch-score-wallet-inner" />
        <g opacity="0">
          <Anim attr="opacity" tr={walletOn} />
          <circle r={w.r} className="ch-score-wallet-lit" />
        </g>
        <g opacity="0">
          <Anim attr="opacity" tr={walletRingFade} />
          <g>
            <Anim attr="transform" type="scale" tr={walletRing} />
            <circle r={w.r} className="ch-score-wallet-ripple" />
          </g>
        </g>
        <Wallet x={-w.r * 0.36} y={-w.r * 0.36} width={w.r * 0.72} height={w.r * 0.72} strokeWidth={1.6} className="ch-score-wallet-icon" aria-hidden="true" />
      </g>
    </g>
  );
}
