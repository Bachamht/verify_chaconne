/**
 * 金额与百分数换算（技术设计 §4.2）。
 * 全部链上金额用 bigint / 十进制整数串；百分数/bps 换算不经 JS 浮点。
 */

const RAW_RE = /^(0|[1-9]\d*)$/;
const DECIMAL_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function isRawAmount(s: unknown): s is string {
  return typeof s === "string" && RAW_RE.test(s);
}

export function parseRaw(s: string): bigint {
  if (!isRawAmount(s)) throw new Error(`非法整数金额: ${s}`);
  return BigInt(s);
}

export function isDecimalString(s: unknown): s is string {
  return typeof s === "string" && DECIMAL_RE.test(s);
}

/** 十进制小数串 → 定点 bigint（乘 10^scale，向下截断多余位）。 */
export function decimalToFixed(s: string, scale: number): bigint {
  if (!isDecimalString(s)) throw new Error(`非法十进制串: ${s}`);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(scale)).slice(0, scale);
  const v = BigInt(intPart + frac);
  return neg ? -v : v;
}

/** 定点 bigint → 十进制小数串（去尾零，保留至少整数位）。 */
export function fixedToDecimal(v: bigint, scale: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(scale + 1, "0");
  const intPart = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  const out = frac.length > 0 ? `${intPart}.${frac}` : intPart;
  return neg ? `-${out}` : out;
}

/** raw → 显示量（按 decimals）十进制串。 */
export function formatUnits(raw: string, decimals: number): string {
  return fixedToDecimal(parseRaw(raw), decimals);
}

/**
 * 最小到账量：expectedOut × (10000 − slippageBps) / 10000，**向下取整**。
 * 这是链上硬边界；调用方必须让用户确认这个具体整数。
 */
export function computeMinOutRaw(expectedOutRaw: string, maxSlippageBps: number): string {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps >= 10_000) {
    throw new Error(`非法滑点 bps: ${maxSlippageBps}`);
  }
  const out = parseRaw(expectedOutRaw);
  return ((out * BigInt(10_000 - maxSlippageBps)) / 10_000n).toString();
}

/**
 * OKX `priceImpactPercent` → 不利冲击 bps。
 * 语义（技术设计 §4.2）：上游为百分数字符串；**负值 = 不利**（用户拿到的比中间价少），
 * 正值 = 有利。未确认语义前不取绝对值：正值视为 0 不利冲击，负值取其绝对值。
 * null / 空 / NaN / 非法 → null（未知，绝不转 0）。
 *
 * ⚠ 该符号约定为本项目默认（D-080），Lane B 首日探针若发现相反语义，改此处并更新黄金样本。
 */
export function parseAdverseImpactBps(priceImpactPercent: string | null | undefined): number | null {
  if (priceImpactPercent === null || priceImpactPercent === undefined) return null;
  const s = priceImpactPercent.trim();
  if (!isDecimalString(s)) return null;
  // 百分数 → bps：×100，定点 2 位小数后取整（向不利方向取整 = 向上取绝对值）
  const fixed = decimalToFixed(s, 4); // 10^-4 %
  // bps = percent × 100 → fixed(4) 表示 percent×10^4，故 bps×100 = fixed → bps = fixed/100
  if (fixed >= 0n) return 0;
  const absFixed = -fixed;
  const bps = (absFixed + 99n) / 100n; // 向上取整
  return Number(bps);
}

/** bps（整数）→ OKX slippagePercent 字符串（如 50 → "0.5"）。 */
export function bpsToPercentString(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`非法 bps: ${bps}`);
  return fixedToDecimal(BigInt(bps), 2);
}

/**
 * 偏差 bps：(a / b − 1) × 10^4，定点计算，四舍五入到整数 bps。
 * a、b 为十进制串（同一计价单位）。b ≤ 0 → null。
 */
export function deviationBps(a: string, b: string): number | null {
  const SCALE = 18;
  const A = decimalToFixed(a, SCALE);
  const B = decimalToFixed(b, SCALE);
  if (B <= 0n) return null;
  // (A/B − 1)·10^4 = (A − B)·10^4 / B
  const num = (A - B) * 10_000n * 2n;
  const q = num / B;
  // 四舍五入：(2x ± 1)/2
  const rounded = q >= 0n ? (q + 1n) / 2n : (q - 1n) / 2n;
  return Number(rounded);
}

/**
 * 可执行单价（USD/股）：
 *   usdIn = amountInRaw / 10^inDecimals × usdPerInputToken
 *   shares = expectedOutRaw / 10^outDecimals × sharesPerToken
 *   price = usdIn / shares
 * 任一换算缺失 → null。结果保留 12 位小数（截断）。
 */
export function executableUsdPerShare(args: {
  amountInRaw: string;
  inDecimals: number;
  usdPerInputToken: string | null;
  expectedOutRaw: string;
  outDecimals: number;
  sharesPerToken: string | null;
}): string | null {
  const { amountInRaw, inDecimals, usdPerInputToken, expectedOutRaw, outDecimals, sharesPerToken } = args;
  if (usdPerInputToken === null || sharesPerToken === null) return null;
  const S = 18;
  const usdIn = parseRaw(amountInRaw) * decimalToFixed(usdPerInputToken, S); // scale: inDecimals + S
  const shares = parseRaw(expectedOutRaw) * decimalToFixed(sharesPerToken, S); // scale: outDecimals + S
  if (shares <= 0n) return null;
  // price = usdIn/10^(inDec+S) ÷ shares/10^(outDec+S) = usdIn·10^(outDec) / (shares·10^(inDec))
  const OUT = 12;
  const num = usdIn * 10n ** BigInt(outDecimals) * 10n ** BigInt(OUT);
  const den = shares * 10n ** BigInt(inDecimals);
  return fixedToDecimal(num / den, OUT);
}
