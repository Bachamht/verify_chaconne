/**
 * 控制台的纯推导（无 React，test/v8Console.test.ts 覆盖）：状态、主动作、步骤时间线、预算、下次检查。
 * 只认「链上确认」为成交；签发 / 广播都只是进行中。
 */
import type { TaskRuntime } from "@chaconne/core/verify";
import { isTerminal, modeUiStatus, taskUiStatus, type UiStatus } from "@/lib/status";
import type { StepState } from "@/components/kit/StepFlow";

export interface FillLite { mandateId: string; stepIndex: string; state: string; txHash: string | null; spent: string | null }
export interface MandateLite { mandateId: string; state: string; current?: boolean; spent?: string; stepsDone?: number; maxSteps?: number }

export interface ConsoleFacts {
  status: string;
  mode: "LIVE" | "SIMULATION" | null;
  runtime: TaskRuntime | null;
  delegationComplete: boolean | null;
  plannedSteps: number | null;
  fills: FillLite[];
}

export function consoleStatus(f: Pick<ConsoleFacts, "status" | "mode">): { status: UiStatus; mode: UiStatus | null; terminal: boolean; paused: boolean; stoppable: boolean } {
  const status = taskUiStatus(f.status);
  return {
    status,
    mode: modeUiStatus(f.mode),
    terminal: isTerminal(status),
    paused: f.status === "PAUSED",
    stoppable: ["ACTIVE", "WAITING", "STEP_PREPARED", "PARTIAL"].includes(f.status),
  };
}

/** 主动作：需要委托 → 完成委托；暂停 → 继续；其余没有主动作（控制按钮是次动作） */
export type PrimaryAction = "delegate" | "resume" | null;
export function primaryAction(f: ConsoleFacts): PrimaryAction {
  const sim = f.mode === "SIMULATION";
  if (!sim && (f.runtime?.needsOwner?.some((n) => n.code === "delegation_incomplete") || f.delegationComplete === false || (f.status === "AWAITING_AUTHORIZATION" && !!f.runtime))) return "delegate";
  if (f.status === "PAUSED") return "resume";
  return null;
}

/** 买入授权（当前 mandate）的步骤时间线：已确认 = done；已提交未确认 = active；其余 idle */
export function stepTimeline(planned: number | null, fills: FillLite[], buyMandateId: string | null, running: boolean): Array<{ index: number; state: StepState; fill: FillLite | null }> {
  if (!planned || planned <= 0) return [];
  const mine = fills.filter((x) => !buyMandateId || x.mandateId === buyMandateId);
  const by = new Map(mine.map((x) => [Number(x.stepIndex), x]));
  const out: Array<{ index: number; state: StepState; fill: FillLite | null }> = [];
  let nextMarked = false;
  for (let i = 0; i < Math.min(planned, 20); i += 1) {
    const fill = by.get(i) ?? null;
    let state: StepState = "idle";
    if (fill?.state === "CONFIRMED") state = "done";
    else if (fill && ["FAILED", "REVERTED"].includes(fill.state)) state = "failed";
    else if (fill) state = "active";
    else if (running && !nextMarked) { state = "active"; nextMarked = true; }
    if (state === "active") nextMarked = true;
    out.push({ index: i, state, fill });
  }
  return out;
}

/** 下次检查：暂停 / 终态不显示（方案 §5.6） */
export function visibleNextCheck(f: Pick<ConsoleFacts, "status" | "runtime">, taskNextCheckAt: string | null | undefined): string | null {
  const s = taskUiStatus(f.status);
  if (f.status === "PAUSED" || isTerminal(s)) return null;
  const pres = f.runtime?.presence;
  if (pres && pres.mode === "hosted" && pres.state === "paused") return null;
  return (pres && "nextCheckAt" in pres ? (pres.nextCheckAt as string | null) : null) ?? taskNextCheckAt ?? null;
}

/** 已用预算：优先当前买入授权的 spent；没有就用确认成交的 spent 合计；都没有 → null（不补 0） */
export function spentRaw(mandates: MandateLite[] | undefined, fills: FillLite[]): string | null {
  const buy = (mandates ?? []).find((m) => m.current) ?? (mandates ?? [])[0];
  if (buy?.spent && /^\d+$/.test(buy.spent)) return buy.spent;
  const confirmed = fills.filter((x) => x.state === "CONFIRMED" && x.spent && /^\d+$/.test(x.spent));
  if (confirmed.length === 0) return null;
  return confirmed.reduce((a, x) => a + BigInt(x.spent!), 0n).toString();
}
