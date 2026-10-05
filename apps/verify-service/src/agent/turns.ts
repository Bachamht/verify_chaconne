/**
 * 托管轮次与动作的绑定（CV-D25）：每个 (taskId, turnVersion) 只接受一个终结动作；被拒的意图同轮可改一次。
 * 记录在 verify_agent_runs.action_json（每个 (taskId, turnVersion) 一行）。TasksService 在接受意图 / 状态报告前后调用。
 */
import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyAgentRuns, verifyTaskIntents } from "@chaconne/db";
import type { RecordedTurnAction, TurnActionState } from "@chaconne/core/verify/agent/index";

export async function hostedTurnState(db: Db, taskId: string, turnVersion: number): Promise<TurnActionState> {
  const run = (await db.select({ actionJson: verifyAgentRuns.actionJson }).from(verifyAgentRuns).where(and(eq(verifyAgentRuns.taskId, taskId), eq(verifyAgentRuns.turnVersion, turnVersion))).limit(1))[0];
  const rejected = (await db.select({ n: count() }).from(verifyTaskIntents).where(and(eq(verifyTaskIntents.taskId, taskId), eq(verifyTaskIntents.turnVersion, turnVersion), eq(verifyTaskIntents.status, "rejected"))))[0];
  return { terminal: (run?.actionJson as RecordedTurnAction | null) ?? null, rejectedIntents: Number(rejected?.n ?? 0) };
}

/** 记下终结动作（只在尚未记录时写；并发下第二个写入不生效） */
export async function recordHostedTurnAction(db: Db, taskId: string, turnVersion: number, action: RecordedTurnAction, now: Date): Promise<boolean> {
  const r = await db
    .update(verifyAgentRuns)
    .set({ actionJson: action, updatedAt: now })
    .where(and(eq(verifyAgentRuns.taskId, taskId), eq(verifyAgentRuns.turnVersion, turnVersion), isNull(verifyAgentRuns.actionJson)))
    .returning({ id: verifyAgentRuns.id });
  return r.length > 0;
}
