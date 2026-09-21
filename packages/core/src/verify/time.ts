/**
 * 时间单位换算 —— 全项目唯一入口（技术设计 §4.3）。
 *  - Pyth publish_time：Unix 秒
 *  - OKX market/price `time`：Unix 毫秒
 *  - 链上 deadline/issuedAt/validUntil：Unix 秒
 *  - 链下证据/报告：ISO-8601 UTC 字符串
 * 任何隐式 Date.now() 都不在本模块：调用方显式传 evaluatedAt。
 */

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** 严格解析 ISO-8601 UTC（必须以 Z 结尾），返回毫秒；非法 → 抛错。 */
export function parseIsoUtc(s: string): number {
  if (!ISO_UTC_RE.test(s)) throw new Error(`非法 ISO-8601 UTC 时间: ${s}`);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间: ${s}`);
  return ms;
}

/** 毫秒 → ISO-8601 UTC（固定 3 位毫秒）。 */
export function isoFromMs(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error(`非法毫秒时间: ${ms}`);
  return new Date(ms).toISOString();
}

/** Unix 秒（Pyth）→ ISO。 */
export function isoFromUnixSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) throw new Error(`非法 Unix 秒: ${sec}`);
  return isoFromMs(sec * 1000);
}

/** Unix 毫秒（OKX `time`，可能是字符串）→ ISO。 */
export function isoFromUnixMillis(ms: number | string): string {
  const n = typeof ms === "string" ? Number(ms) : ms;
  if (!Number.isFinite(n) || n < 0) throw new Error(`非法 Unix 毫秒: ${ms}`);
  // 粗防秒/毫秒混用：2001-09-09 之前的毫秒值极可能是秒
  if (n < 1_000_000_000_000) throw new Error(`疑似把秒当毫秒: ${ms}`);
  return isoFromMs(n);
}

/** ISO → Unix 秒（向下取整）。 */
export function unixSecondsFromIso(iso: string): number {
  return Math.floor(parseIsoUtc(iso) / 1000);
}

/** 年龄（秒）：`now - at`；at 在未来时为负数。 */
export function ageSeconds(atIso: string, nowIso: string): number {
  return (parseIsoUtc(nowIso) - parseIsoUtc(atIso)) / 1000;
}

/** at 是否超前 now 超过容忍（源时间来自未来 → 拒绝/降级）。 */
export function isFutureBeyondTolerance(atIso: string, nowIso: string, toleranceSeconds: number): boolean {
  return ageSeconds(atIso, nowIso) < -toleranceSeconds;
}
