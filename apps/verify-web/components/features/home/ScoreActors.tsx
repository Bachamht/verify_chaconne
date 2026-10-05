"use client";
import { Anim, Move } from "./ScoreAnim";
import { laneOf, type Scene } from "./scoreScene";
import { TOKEN_D } from "./ScoreGlyphs";
import { BEAT, flashes, IMPACT, normalCues, rogueCue, track, type Cue } from "./scoreTimeline";

/**
 * 一笔在范围内的提案：
 *  提案（紫色音符）：指挥棒尖 → 01 核验 → 02 PlanGuard；
 *  资金（金色）：核验通过后才离开钱包，沿额度线到 PlanGuard，放行后到 03 OKX DEX；
 *  代币（绿色）：OKX DEX 成交 → 04 你的钱包。
 */
function Phrase({ scene, cue }: { scene: Scene; cue: Cue }) {
  const { id } = scene;
  const t = cue.at;
  const lane = laneOf(scene, cue.lane);
  const center = laneOf(scene, 0);
  const k = `scale(${scene.actor})`;
  const note = {
    move: track([
      { t, v: 0 }, { t: t + BEAT.spawn, v: 0 },
      { t: t + BEAT.verify, v: lane.f.verify }, { t: t + BEAT.verifyOut, v: lane.f.verify },
      { t: t + BEAT.guard, v: lane.f.guard },
    ]),
    fade: track([{ t, v: 0 }, { t: t + 0.18, v: 1, ease: "out" }, { t: t + BEAT.guard, v: 1 }, { t: t + BEAT.merged, v: 0, ease: "in" }]),
  };
  const coin = {
    move: track([
      { t: t + BEAT.coinOut, v: 0 }, { t: t + BEAT.coinAttach, v: scene.coin.fAttach },
      { t: t + BEAT.coinCenter, v: scene.coin.fCenter }, { t: t + BEAT.coinGo, v: scene.coin.fCenter },
      { t: t + BEAT.dex, v: 1 },
    ]),
    // 进 OKX DEX 前收起（节点中间是兑换图标），节点描边亮一下表示成交
    fade: track([{ t: t + BEAT.coinOut, v: 0 }, { t: t + BEAT.coinOut + 0.18, v: 1, ease: "out" }, { t: t + BEAT.dex - 0.16, v: 1 }, { t: t + BEAT.dex - 0.02, v: 0, ease: "in" }]),
  };
  const token = {
    move: track([{ t: t + BEAT.tokenOut, v: center.f.dex }, { t: t + BEAT.wallet, v: 1 }]),
    fade: track([{ t: t + BEAT.tokenOut + 0.1, v: 0 }, { t: t + BEAT.tokenOut + 0.26, v: 1, ease: "out" }, { t: t + BEAT.wallet - 0.12, v: 1 }, { t: t + BEAT.wallet + 0.04, v: 0, ease: "in" }]),
  };
  return (
    <>
      <g className="ch-score-coin" opacity="0">
        <Move path={id("coin")} tr={coin.move} />
        <Anim attr="opacity" tr={coin.fade} />
        <g transform={k}>
          <circle r="5.6" />
          <circle r="2.6" className="ch-score-coin-mark" />
        </g>
      </g>
      <g className="ch-score-note" opacity="0">
        <Move path={id(`lane${cue.lane}`)} tr={note.move} />
        <Anim attr="opacity" tr={note.fade} />
        <use href={`#${id("note")}`} transform={k} />
      </g>
      <g className="ch-score-token" opacity="0">
        <Move path={id("lane0")} tr={token.move} />
        <Anim attr="opacity" tr={token.fade} />
        <g transform={k}>
          <path d={TOKEN_D} />
        </g>
      </g>
    </>
  );
}

/** 越界的提案：偏离谱面，在核验处标 ✕，到 PlanGuard 停下、消失；资金从头到尾没有离开钱包 */
function Rogue({ scene, blocked }: { scene: Scene; blocked: string }) {
  const { id } = scene;
  const t = rogueCue.at;
  const stop = t + IMPACT;
  const move = track([
    { t, v: 0 }, { t: t + BEAT.spawn, v: 0 },
    { t: t + BEAT.verify, v: scene.rogue.fVerify }, { t: t + BEAT.verifyOut + 0.1, v: scene.rogue.fVerify },
    { t: stop, v: 1 },
  ]);
  const fade = track([{ t, v: 0 }, { t: t + 0.18, v: 1, ease: "out" }, { t: stop + 0.2, v: 1 }, { t: stop + 0.6, v: 0, ease: "in" }]);
  const label = track(flashes([stop + 0.1], { rise: 0.2, hold: 1.3, fall: 0.4 }));
  return (
    <>
      <g className="ch-score-rogue" opacity="0">
        <Move path={id("rogue")} tr={move} />
        <Anim attr="opacity" tr={fade} />
        <use href={`#${id("note")}`} transform={`scale(${scene.actor})`} />
      </g>
      <text x={scene.blocked[0]} y={scene.blocked[1]} textAnchor="middle" dominantBaseline="middle" className="ch-score-blocked" opacity="0">
        <Anim attr="opacity" tr={label} />
        {blocked}
      </text>
    </>
  );
}

/** 会动的东西：资金、提案、代币、越界的提案。路径（mpath）放在本组 defs 里 */
export function ScoreActors({ scene, blocked }: { scene: Scene; blocked: string }) {
  return (
    <g>
      <defs>
        <path id={scene.id("coin")} d={scene.coin.d} />
        <path id={scene.id("rogue")} d={scene.rogue.d} />
      </defs>
      {normalCues.map((c) => <Phrase key={c.at} scene={scene} cue={c} />)}
      <Rogue scene={scene} blocked={blocked} />
    </g>
  );
}
