/**
 * 首页乐谱动画的几何工具（纯函数，单测见 test/v8HomeFlow.test.ts）：
 * 节点 + 切线（Hermite）采样成折线、沿法线平移出五线谱、按弧长取点。坐标都是 SVG 用户坐标（y 向下）。
 */
export type Pt = readonly [number, number];
/** 曲线上的一个节点：位置 p 与切线 t（切线越长，曲线在这里越舒展） */
export interface Knot { readonly p: Pt; readonly t: Pt }

const round1 = (n: number) => Math.round(n * 10) / 10;
export const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function bezier(a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]];
}

/** 沿节点采样成折线（相邻点约 step 个单位）；at[i] = 第 i 个节点在点列里的下标 */
export function sampleKnots(knots: readonly Knot[], step = 10): { pts: Pt[]; at: number[] } {
  const pts: Pt[] = [];
  const at: number[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i]!;
    const d = knots[i + 1]!;
    const b: Pt = [a.p[0] + a.t[0] / 3, a.p[1] + a.t[1] / 3];
    const c: Pt = [d.p[0] - d.t[0] / 3, d.p[1] - d.t[1] / 3];
    const n = Math.max(4, Math.ceil((dist(a.p, b) + dist(b, c) + dist(c, d.p)) / step));
    at.push(pts.length);
    for (let j = 0; j < n; j++) pts.push(bezier(a.p, b, c, d.p, j / n));
  }
  at.push(pts.length);
  pts.push(knots[knots.length - 1]!.p);
  return { pts, at };
}

/** 三次曲线（起点、两个控制点、终点）采样成折线 */
export function sampleCubic(a: Pt, b: Pt, c: Pt, d: Pt, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, j) => bezier(a, b, c, d, j / n));
}

/** 累计弧长：out[i] = 从起点走到第 i 个点的长度 */
export function cumulative(pts: readonly Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  return out;
}

/** 每个点沿法线平移 off(i)：正值在前进方向的右侧（向右走时是下方） */
export function offsetPts(pts: readonly Pt[], off: (i: number) => number): Pt[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const o = off(i);
    return [p[0] - ((b[1] - a[1]) / len) * o, p[1] + ((b[0] - a[0]) / len) * o];
  });
}

/** 第 i 个点的切线角（度，0 = 向右，90 = 向下） */
export function angleAt(pts: readonly Pt[], i: number): number {
  const a = pts[Math.max(0, i - 1)]!;
  const b = pts[Math.min(pts.length - 1, i + 1)]!;
  return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
}

/** 数字的最短写法：一位小数，去掉多余的 0（0.3 → .3，-0.3 → -.3，8.0 → 8） */
function num(n: number): string {
  const s = String(round1(n));
  return s.replace(/^(-?)0\./, "$1.");
}
/** 两个数字之间的分隔：负号本身就能分隔 */
const join = (parts: readonly string[]) => parts.map((s, i) => (i && !s.startsWith("-") ? ` ${s}` : s)).join("");

/**
 * 折线 → SVG path d。为控制首页 HTML 体积：起点绝对坐标，之后用相对坐标（l），数字只留一位小数。
 * 相对量由取整后的绝对坐标相减得到，所以不会越走越偏。
 */
export function pathD(pts: readonly Pt[], close = false): string {
  if (!pts.length) return "";
  const r = pts.map((p) => [round1(p[0]), round1(p[1])] as const);
  const head = `M${join([num(r[0]![0]), num(r[0]![1])])}`;
  const rest = r.slice(1).flatMap((p, i) => [num(p[0] - r[i]![0]), num(p[1] - r[i]![1])]);
  return head + (rest.length ? `l${join(rest)}` : "") + (close ? "Z" : "");
}

/** 0→1 的平滑过渡（edge0 之前 0，edge1 之后 1） */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 以 center 为中心、半宽 half 的钟形隆起（center 处 1，两侧平滑落到 0） */
export function bump(center: number, half: number, x: number): number {
  const d = Math.abs(x - center) / half;
  return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
}
