/** 事件卡主动作的选择（V-34）：有命中任务 → 按规则等待；没有任务但可建观察任务 → 建；否则查看依据。纯函数，页面与测试共用。 */
import type { ImpactAction } from "@chaconne/core/verify";

export function primaryActionOf(enabled: ImpactAction[], hasTask: boolean): ImpactAction | null {
  if (hasTask && enabled.includes("wait_by_rule")) return "wait_by_rule";
  if (!hasTask && enabled.includes("create_watch_task")) return "create_watch_task";
  if (enabled.includes("view_evidence")) return "view_evidence";
  return enabled[0] ?? null;
}
