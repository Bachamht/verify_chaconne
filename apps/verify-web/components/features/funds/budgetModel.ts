/** 资金组（服务端协调，D-086）的归一化与文案：portfolio.budgetGroups 与 GET /v1/budget-groups/:id 两种形状 */
import type { PortfolioView } from "@/lib/api-v2";

const RAW = /^\d+$/;

/** portfolio.budgetGroups 的一项（服务端字段：groupId / period / summary） */
export interface PortfolioBudgetGroup {
  id: string;
  name: string;
  inputAssetKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  /** null = 接口没给（页面写「未返回」，不当 0） */
  capRaw: string | null;
  cashFloorRaw: string | null;
  spentRaw: string | null;
  reservedRaw: string | null;
  pendingRaw: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
/** 缺值 → null（未返回），不补 "0" */
const raw = (x: unknown): string | null => (typeof x === "string" && RAW.test(x) ? x : null);

/** 兼容两种形状：portfolio 里的 {groupId, period, summary} 与 GET /v1/budget-groups/:id 的 {group, summary} */
export function normalizeBudgetGroup(input: unknown): PortfolioBudgetGroup | null {
  if (!isObj(input)) return null;
  const g = isObj(input["group"]) ? input["group"] : input;
  const sum = isObj(input["summary"]) ? input["summary"] : g;
  const period = isObj(g["period"]) ? g["period"] : {};
  const id = str(g["id"]) ?? str(g["groupId"]);
  if (!id) return null;
  return {
    id,
    name: str(g["name"]) ?? id,
    inputAssetKey: str(g["inputAssetKey"]) ?? "",
    periodStart: str(g["periodStart"]) ?? str(period["start"]),
    periodEnd: str(g["periodEnd"]) ?? str(period["end"]),
    capRaw: raw(sum["capRaw"] ?? g["capRaw"]),
    cashFloorRaw: raw(g["cashFloorRaw"]),
    spentRaw: raw(sum["spentRaw"]),
    reservedRaw: raw(sum["reservedRaw"]),
    pendingRaw: raw(sum["pendingRaw"]),
  };
}

export function budgetGroupsOf(portfolio: PortfolioView | null): PortfolioBudgetGroup[] | null {
  if (!portfolio || !Array.isArray(portfolio.budgetGroups)) return null;
  return portfolio.budgetGroups.map(normalizeBudgetGroup).filter((g): g is PortfolioBudgetGroup => g !== null);
}

export interface AllocationView { taskId: string; mandateId: string; priority: number; reservedRaw: string | null; state: string }
export function allocationsOf(input: unknown): AllocationView[] {
  const list = isObj(input) && Array.isArray(input["allocations"]) ? input["allocations"] : [];
  return list.filter(isObj).map((a) => ({ taskId: str(a["taskId"]) ?? "", mandateId: str(a["mandateId"]) ?? "", priority: Number(a["priority"] ?? 0), reservedRaw: raw(a["reservedRaw"]), state: str(a["state"]) ?? "" }));
}

/** 预算分配状态 → 文案（未知值不露出原始枚举） */
export function allocationStateLabel(state: string, zh: boolean): string {
  const m: Record<string, [string, string]> = {
    reserved: ["已预留", "Reserved"],
    waiting: ["等额度", "Waiting for room"],
    released: ["已释放", "Released"],
    settled: ["已结算", "Settled"],
  };
  const hit = m[state];
  return hit ? (zh ? hit[0] : hit[1]) : zh ? "其它" : "Other";
}

export function periodEnded(g: Pick<PortfolioBudgetGroup, "periodEnd">, now: Date = new Date()): boolean {
  return Boolean(g.periodEnd && Date.parse(g.periodEnd) < now.getTime());
}
