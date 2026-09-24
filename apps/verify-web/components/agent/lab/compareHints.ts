/** 休市时两套都在等开盘：对照没有信息量，先提示（V-33）。纯函数，页面与测试共用。 */
export function bothWaitingForOpen(diff: Array<{ outcome: string; blockingCodes?: string[] }> | null | undefined): boolean {
  const d = diff ?? [];
  return d.length >= 2 && d.every((o) => o.outcome === "UNSATISFIED" && (o.blockingCodes ?? []).includes("SESSION_RULE_BLOCK"));
}
