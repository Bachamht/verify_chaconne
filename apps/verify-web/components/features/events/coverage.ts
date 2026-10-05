/** 财报覆盖表的纯函数（单测覆盖）。 */
import type { AssetEntry } from "@/lib/assets";
import type { CoverageRow } from "./api";

export interface CoverageView { symbol: string; state: CoverageRow["state"]; lastProbedAt: string | null; nextReport: string | null }

/** 覆盖行 + 登记表 → 表格行；下一份财报取 eventIds 里不早于今天的最早日期（id = source:EARNINGS:YYYY-MM-DD:SYM）；登记表外的跳过 */
export function coverageRows(rows: CoverageRow[], assets: AssetEntry[], todayIso: string): CoverageView[] {
  const sym = new Map(assets.filter((a) => a.role === "stock_output").map((a) => [a.underlyingId, a.displaySymbol]));
  return rows
    .filter((r) => sym.has(r.underlyingId))
    .map((r) => {
      const dates = r.eventIds.map((id) => id.split(":")[2] ?? "").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= todayIso).sort();
      return { symbol: sym.get(r.underlyingId)!, state: r.state, lastProbedAt: r.lastProbedAt, nextReport: dates[0] ?? null };
    })
    .sort((a, b) => (a.nextReport ?? "9999").localeCompare(b.nextReport ?? "9999") || a.symbol.localeCompare(b.symbol));
}
