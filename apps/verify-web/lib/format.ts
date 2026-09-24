"use client";
/** 面向人的格式化与校验（V-09 / V-16）：本地时间+时区、人类单位↔raw、地址行内校验、nextStep 人话。 */
import type { PlanCandidate, PlanNextStep } from "@chaconne/core/verify";
import type { Locale } from "./i18n";
import { fmtUnits } from "./wallet";

/** 本地时间 + 时区缩写；接受 ISO 串、unix 秒或毫秒 */
export function fmtLocal(input: string | number | Date | null | undefined, locale: Locale = "en"): string {
  if (input === null || input === undefined || input === "") return "—";
  let d: Date;
  if (input instanceof Date) d = input;
  else if (typeof input === "number") d = new Date(input < 1e12 ? input * 1000 : input);
  else if (/^\d+$/.test(input)) d = new Date(Number(input) < 1e12 ? Number(input) * 1000 : Number(input));
  else d = new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** 当前时区标签，如 "AEST（UTC+10）" */
export function tzLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date());
    const short = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const off = -new Date().getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const h = Math.floor(Math.abs(off) / 60);
    const m = Math.abs(off) % 60;
    return `${short}（UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}）`;
  } catch {
    return "";
  }
}

/** "12.5" → raw（按精度截断）；非法返回 null */
export function humanToRaw(human: string, decimals: number): string | null {
  const s = human.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const raw = BigInt(i! + (f + "0".repeat(decimals)).slice(0, decimals)).toString();
  return raw === "0" ? null : raw;
}

/** 金额统一出口（V-32 / 4.6-4）：raw + 精度 + 符号 → "2 USDG"；raw 缺失 → "—"（未知不算零） */
export function formatAmount(raw: string | bigint | null | undefined, decimals: number, symbol?: string, maxFrac = 6): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  let human: string;
  try {
    human = fmtUnits(raw, decimals, maxFrac);
  } catch {
    return "—";
  }
  return symbol ? `${human} ${symbol}` : human;
}

/** 时间统一出口（4.6-3）：本地时间；ISO 只出现在开发者视图 */
export const formatTime = fmtLocal;

export function rawToHuman(raw: string | bigint | null | undefined, decimals: number, maxFrac = 6): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  try {
    return fmtUnits(raw, decimals, maxFrac);
  } catch {
    return String(raw);
  }
}

/** 地址行内校验：格式错 / 与已连接钱包不一致；null = 没问题 */
export function addressProblem(value: string, connected: string | null | undefined, locale: Locale): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return locale === "zh" ? "地址格式不对：应为 0x 开头的 40 位十六进制" : "Invalid address: expected 0x followed by 40 hex characters";
  if (connected && v.toLowerCase() !== connected.toLowerCase()) return locale === "zh" ? `与已连接钱包不一致（${connected.slice(0, 6)}…${connected.slice(-4)}）；签名时会被拒绝` : `Differs from the connected wallet (${connected.slice(0, 6)}…${connected.slice(-4)}); signing will be refused`;
  return null;
}

export function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

const NEXT_EXPL: Record<PlanNextStep, { en: string; zh: string }> = {
  READY: { en: "Everything checks out — you can create the task now.", zh: "各项都通过，现在就可以创建任务。" },
  ACCEPT_PARTIAL: { en: "Only part of the budget clears your limits. Accepting it is a smaller trade, not the original goal.", zh: "只有一部分预算能过你的限额。接受它是一笔更小的交易，不等于完成原目标。" },
  SWITCH_INPUT: { en: "This funding currency has no good route; another allowed currency does.", zh: "这个资金币种没有好路由，另一个允许的币种有。" },
  WAIT_CONDITION: { en: "Blocked by a time condition (market hours / stale reference / old quote). Keep the goal and let the monitor retry.", zh: "被时间条件挡住（市场时段 / 参考价过旧 / 报价过旧）。保留目标，让监测器稍后重试。" },
  PROVIDE_DATA: { en: "A data source is missing (route, source time, or USD conversion). Nothing to execute until it returns.", zh: "缺一项数据（路由、源时间或美元换算）。数据回来前没有可执行的东西。" },
  USER_MUST_RELAX_LIMIT: { en: "Your own limit (price impact / deviation) blocks this size. The service never relaxes it for you.", zh: "是你自己设的上限（冲击 / 偏差）拦住了这个金额。服务不会替你放宽。" },
};
export function nextStepText(step: PlanNextStep, locale: Locale): string {
  return NEXT_EXPL[step]?.[locale] ?? step;
}

/** 无推荐时：哪条限额在挡 + 下一步建议（按候选里出现最多的阻断码） */
export function blockingSummary(candidates: PlanCandidate[], locale: Locale): string {
  const count = new Map<string, number>();
  for (const c of candidates) for (const r of c.reasons) if (r.severity === "block") count.set(r.code, (count.get(r.code) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  const steps = new Set(candidates.map((c) => c.nextStep));
  const hint = steps.has("USER_MUST_RELAX_LIMIT")
    ? locale === "zh" ? "下一步：降低金额，或明确放宽冲击/偏差上限后重新规划。" : "Next: reduce the amount, or explicitly relax the impact/deviation limit and plan again."
    : steps.has("WAIT_CONDITION")
      ? locale === "zh" ? "下一步：保留目标等待条件满足（美股常规时段 / 参考价更新）。" : "Next: keep the goal and wait for the condition (regular hours / fresh reference)."
      : steps.has("SWITCH_INPUT")
        ? locale === "zh" ? "下一步：换一个允许的资金币种。" : "Next: switch to another allowed funding currency."
        : locale === "zh" ? "下一步：等数据源恢复后重新规划。" : "Next: plan again once the data source is back.";
  if (top.length === 0) return hint;
  return (locale === "zh" ? `挡住候选的主要是：${top.join("、")}。` : `Blocked mainly by: ${top.join(", ")}. `) + hint;
}
