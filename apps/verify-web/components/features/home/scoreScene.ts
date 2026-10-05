/**
 * 首页「怎么运作」示意动画的两套布景（纯数据 + 几何计算，单测见 test/v8HomeFlow.test.ts）：
 *  wide：桌面与平板，横向（1200 × 400）；tall：手机，竖向（360 × 600）。
 * 画面：小指挥家（Chaconne Agent）的指挥棒尖引出一条五线谱（= 你签下的范围），依次经过 01 核验、02 PlanGuard 合约、
 * 03 OKX DEX，到 04 你的钱包；额度线从钱包连到 PlanGuard。提案、资金、代币的运动路径与各站在路径上的位置都在这里算好。
 */
import { angleAt, bump, cumulative, offsetPts, pathD, sampleCubic, sampleKnots, smoothstep, type Knot, type Pt } from "./scorePath";

export type SceneKey = "wide" | "tall";
export type StationKey = "verify" | "guard" | "dex";
export const STATIONS: readonly StationKey[] = ["verify", "guard", "dex"];
/** 画面上的标签（文字在 flowCopy.ts；位置在这里，globals.css 按同一组百分比摆放，单测核对两边一致） */
export type TagKey = "agent" | "scope" | StationKey | "wallet" | "allowance";

/** 抠好透明底的小指挥家（public/brand/conductor-score.webp，520 × 574）：指挥棒尖、双脚中点（摆动支点） */
export const MASCOT = { src: "/brand/conductor-score.webp", w: 520, h: 574, tip: [26, 110] as Pt, feet: [268, 543] as Pt } as const;
/** 盾牌轮廓（局部坐标，宽 ±44、高 ±60；底尖在 0,60） */
export const SHIELD_D = "M0 -60C16 -50 32 -47 44 -47L44 -6C44 24 25 46 0 60C-25 46 -44 24 -44 -6L-44 -47C-32 -47 -16 -50 0 -60Z";

/** 谱线上的一站：位置、切线角（度）、在中线点列里的下标 */
export interface Station { readonly x: number; readonly y: number; readonly angle: number; readonly i: number }
/** 五线谱的一条线：k = −2…2（0 是中线），f = 各站在这条线上的弧长比例（animateMotion 的 keyPoints 用） */
export interface Lane { readonly k: number; readonly d: string; readonly f: Readonly<Record<StationKey, number>> }

interface Spec {
  key: SceneKey;
  w: number;
  h: number;
  mascot: { x: number; y: number; h: number };
  /** 谱线中线：第 0 个节点是指挥棒尖（这里只给切线），之后依次经过各站，最后一个是钱包 */
  tipTangent: Pt;
  knots: readonly Knot[];
  stations: Readonly<Record<StationKey, number>>;
  lane: number;
  ring: { along: number; across: number };
  shield: number;
  dex: number;
  orb: number;
  /** 额度线：从钱包出发的三次曲线（起点、两个控制点），终点是盾牌上的挂点 attach（盾牌局部坐标，未缩放） */
  thread: { from: Pt; c1: Pt; c2: Pt };
  attach: Pt;
  /** 越界的提案偏离谱面多远（正值：横版在谱线下方，竖版在左侧） */
  rogueLift: number;
  /** 「拦下」相对盾牌中心的位置 */
  blocked: Pt;
  /** 核验结果（✓ / ✕）标在核验环的哪一侧：1 = 环的局部 +y（横版在下方），−1 = 局部 −y（竖版在右侧） */
  badge: 1 | -1;
  gradient: "x" | "y";
  /** 提案、资金、代币的大小 */
  actor: number;
  tags: Readonly<Record<TagKey, Pt>>;
}

const WIDE: Spec = {
  key: "wide", w: 1200, h: 400,
  mascot: { x: 28, y: 128, h: 250 },
  tipTangent: [20, -170],
  knots: [
    { p: [210, 78], t: [230, 0] },
    { p: [450, 212], t: [230, 0] },
    { p: [660, 200], t: [220, 0] },
    { p: [860, 212], t: [210, 0] },
    { p: [1080, 204], t: [200, 0] },
  ],
  stations: { verify: 2, guard: 3, dex: 4 },
  lane: 10,
  ring: { along: 12, across: 46 },
  shield: 0.85, dex: 20, orb: 32,
  thread: { from: [1057.4, 226.6], c1: [1010, 312], c2: [720, 318] },
  attach: [0, 60],
  rogueLift: 14,
  blocked: [-80, 62],
  badge: 1,
  gradient: "x",
  actor: 1.15,
  tags: { agent: [145, 384], scope: [210, 42], verify: [450, 150], guard: [660, 128], dex: [860, 172], wallet: [1080, 154], allowance: [863, 296] },
};

const TALL: Spec = {
  key: "tall", w: 360, h: 600,
  mascot: { x: 6, y: 54, h: 168 },
  tipTangent: [8, -110],
  knots: [
    { p: [150, 22], t: [170, 0] },
    { p: [240, 118], t: [0, 120] },
    { p: [240, 256], t: [0, 110] },
    { p: [240, 354], t: [0, 108] },
    { p: [240, 456], t: [0, 100] },
    { p: [240, 548], t: [0, 90] },
  ],
  stations: { verify: 3, guard: 4, dex: 5 },
  lane: 8,
  ring: { along: 10, across: 38 },
  shield: 0.7, dex: 16, orb: 26,
  thread: { from: [264.4, 539.1], c1: [330, 528], c2: [330, 372] },
  attach: [44, 4],
  rogueLift: 10,
  blocked: [-62, 50],
  badge: -1,
  gradient: "y",
  actor: 1,
  // 竖版：四站的标签右对齐到 x=195（站点左侧）；额度标签右对齐到画布右缘，压在额度线最外侧那一段上
  tags: { agent: [84, 226], scope: [212, 108], verify: [195, 256], guard: [195, 354], dex: [195, 456], wallet: [195, 548], allowance: [356, 450] },
};

export interface Scene {
  readonly key: SceneKey;
  readonly w: number;
  readonly h: number;
  /** 宽、窄两套 SVG 同在一页：id 加场景前缀，不撞车 */
  readonly id: (name: string) => string;
  readonly tip: Pt;
  readonly mascot: { x: number; y: number; w: number; h: number; pivot: Pt };
  readonly lanes: readonly Lane[];
  readonly band: string;
  readonly stations: Readonly<Record<StationKey, Station>>;
  readonly wallet: Station & { r: number };
  readonly ring: { along: number; across: number };
  readonly shield: number;
  readonly dex: number;
  readonly thread: string;
  readonly attach: Pt;
  /** 资金：沿额度线到 PlanGuard，进合约，再沿中线到 OKX DEX；f = 各段终点的弧长比例 */
  readonly coin: { d: string; fAttach: number; fCenter: number };
  /** 越界的提案：偏离谱面，止于盾牌（end = 停下的位置）；fVerify = 经过核验时的弧长比例 */
  readonly rogue: { d: string; fVerify: number; end: Pt };
  readonly blocked: Pt;
  readonly badge: 1 | -1;
  readonly actor: number;
  /** 谱线渐变的方向（棒尖处淡入） */
  readonly gradient: { x1: number; y1: number; x2: number; y2: number };
  readonly tags: Readonly<Record<TagKey, Pt>>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function build(s: Spec): Scene {
  const id = (name: string) => `chs-${s.key[0]}-${name}`;
  const scale = s.mascot.h / MASCOT.h;
  const tip: Pt = [s.mascot.x + MASCOT.tip[0] * scale, s.mascot.y + MASCOT.tip[1] * scale];
  const pivot: Pt = [r2(s.mascot.x + MASCOT.feet[0] * scale), r2(s.mascot.y + MASCOT.feet[1] * scale)];

  const { pts, at } = sampleKnots([{ p: tip, t: s.tipTangent }, ...s.knots]);
  const cum = cumulative(pts);
  const total = cum[cum.length - 1]!;
  const u = (i: number) => cum[i]! / total;
  const idx = { verify: at[s.stations.verify]!, guard: at[s.stations.guard]!, dex: at[s.stations.dex]! };
  const uDex = u(idx.dex);
  // 线距：从棒尖散开；到 OKX DEX 收拢穿过兑换节点；进钱包前再收拢
  const spread = (i: number) => s.lane * smoothstep(0, 0.09, u(i)) * (1 - 0.62 * bump(uDex, 0.05, u(i))) * (1 - 0.72 * smoothstep(0.93, 1, u(i)));

  const lanes: Lane[] = [-2, -1, 0, 1, 2].map((k) => {
    const lp = k === 0 ? pts : offsetPts(pts, (i) => k * spread(i));
    const lc = cumulative(lp);
    const lt = lc[lc.length - 1]!;
    return { k, d: pathD(lp), f: { verify: r4(lc[idx.verify]! / lt), guard: r4(lc[idx.guard]! / lt), dex: r4(lc[idx.dex]! / lt) } };
  });
  const upper = offsetPts(pts, (i) => -2.6 * spread(i));
  const lower = offsetPts(pts, (i) => 2.6 * spread(i));
  const band = pathD([...upper, ...lower.reverse()], true);

  const station = (i: number): Station => ({ x: r2(pts[i]![0]), y: r2(pts[i]![1]), angle: r2(angleAt(pts, i)), i });
  const stations = { verify: station(idx.verify), guard: station(idx.guard), dex: station(idx.dex) };
  const wallet = { ...station(pts.length - 1), r: s.orb };

  const g = stations.guard;
  const attach: Pt = [r2(g.x + s.attach[0] * s.shield), r2(g.y + s.attach[1] * s.shield)];
  const threadPts = sampleCubic(s.thread.from, s.thread.c1, s.thread.c2, attach, 28);
  const inPts = sampleCubic(attach, attach, [g.x, g.y], [g.x, g.y], 6).slice(1);
  const coinPts = [...threadPts, ...inPts, ...pts.slice(idx.guard + 1, idx.dex + 1)];
  const cc = cumulative(coinPts);
  const ct = cc[cc.length - 1]!;
  const coin = { d: pathD(coinPts), fAttach: r4(cc[threadPts.length - 1]! / ct), fCenter: r4(cc[threadPts.length + inPts.length - 1]! / ct) };

  const roguePts = offsetPts(pts.slice(0, idx.guard + 1), (i) => (2 * s.lane + s.rogueLift) * smoothstep(0.07, 0.2, u(i)));
  const rc = cumulative(roguePts);
  const rogueEnd = roguePts[roguePts.length - 1]!;
  const rogue = { d: pathD(roguePts), fVerify: r4(rc[idx.verify]! / rc[rc.length - 1]!), end: [r2(rogueEnd[0]), r2(rogueEnd[1])] as Pt };

  const gradient = s.gradient === "x"
    ? { x1: r2(tip[0]), y1: 0, x2: wallet.x, y2: 0 }
    : { x1: 0, y1: r2(Math.min(...pts.map((p) => p[1]))), x2: 0, y2: wallet.y };

  return {
    key: s.key, w: s.w, h: s.h, id, tip: [r2(tip[0]), r2(tip[1])],
    mascot: { x: s.mascot.x, y: s.mascot.y, w: r2(MASCOT.w * scale), h: s.mascot.h, pivot },
    lanes, band, stations, wallet, ring: s.ring, shield: s.shield, dex: s.dex,
    thread: pathD(threadPts), attach, coin, rogue, gradient,
    blocked: [r2(g.x + s.blocked[0]), r2(g.y + s.blocked[1])],
    badge: s.badge, actor: s.actor, tags: s.tags,
  };
}

export const SCENES: Readonly<Record<SceneKey, Scene>> = { wide: build(WIDE), tall: build(TALL) };

/** 把一团椭圆光收进画布里（超出边界会被 SVG 裁成一条硬边），保持长宽比 */
export function fitGlow(scene: Scene, cx: number, cy: number, rx: number, ry: number) {
  const m = 2;
  const k = Math.min(1, (cx - m) / rx, (scene.w - m - cx) / rx, (cy - m) / ry, (scene.h - m - cy) / ry);
  return { cx: r2(cx), cy: r2(cy), rx: r2(rx * k), ry: r2(ry * k) };
}

/** 某条线（k）在场景里的数据；k 超出 −2…2 时按中线算 */
export const laneOf = (scene: Scene, k: number): Lane => scene.lanes.find((l) => l.k === k) ?? scene.lanes[2]!;
