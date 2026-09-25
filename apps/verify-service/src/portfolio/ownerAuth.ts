/**
 * owner 鉴权（interfaces §11.7 末段）：组合、资金组、回调注册一律验 owner；单凭钱包地址不能获知私密信息。
 * 通过条件（任一）：
 *   1. 受信代理通配 key 细分出的 callerId 以 `:<owner>` 结尾（auth.ts 的 `web:*` 机制 → `web:0x…`）；
 *   2. 调用方本身就是该地址（callerId === owner）；
 *   3. API key 调用方此前已为该 owner 登记过任务 / 规划 / 授权（有既存关系的 Agent）。
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyJobs, verifyMandates, verifyPlans, verifyTasks } from "@chaconne/db";
import { isEvmAddress } from "@chaconne/core/verify";
import { HttpError } from "../jobs/service";
import { callerActsFor } from "../http/auth";

export { callerActsFor };

export async function callerHasRelationship(db: Db, callerId: string, owner: string): Promise<boolean> {
  const o = owner.toLowerCase();
  const [m, j, p, t] = await Promise.all([
    db.select({ id: verifyTasks.id }).from(verifyTasks).where(and(eq(verifyTasks.callerId, callerId), eq(verifyTasks.ownerAddress, o))).limit(1),
    db.select({ id: verifyMandates.id }).from(verifyMandates).where(and(eq(verifyMandates.callerId, callerId), eq(verifyMandates.ownerAddress, o))).limit(1),
    db.select({ id: verifyJobs.id }).from(verifyJobs).where(and(eq(verifyJobs.callerId, callerId), eq(verifyJobs.ownerAddress, o))).limit(1),
    db.select({ id: verifyPlans.id }).from(verifyPlans).where(and(eq(verifyPlans.callerId, callerId), eq(verifyPlans.ownerAddress, o))).limit(1),
  ]);
  return m.length > 0 || j.length > 0 || p.length > 0 || t.length > 0;
}

export async function assertOwner(db: Db, callerId: string, owner: string): Promise<string> {
  if (!isEvmAddress(owner)) throw new HttpError(400, "invalid_owner", "owner 须为 EVM 地址");
  if (callerActsFor(callerId, owner)) return owner.toLowerCase();
  if (await callerHasRelationship(db, callerId, owner)) return owner.toLowerCase();
  throw new HttpError(403, "owner_forbidden", "调用方不能代表该 owner：需要受信代理的 x-verify-caller，或此前已为该地址登记过任务/授权");
}
