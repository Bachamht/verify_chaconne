/**
 * v7 R5 · 公开值守看板（开发计划 §2.8 `POST /v1/tasks/:id/share-activity`、`GET /pub/tasks/:shareId/activity`；P-07 / R-06）。
 * 复用 `verify_shares`（kind = task_activity，refId = taskId，(kind, refId) 唯一 → 每个任务一条分享）；隐私参数沿用战报的形状
 * （hideAssets / hideAmounts / owner 恒隐藏），本 kind 固定全部隐藏且只出类别：输出只有 类别 + 时间 + 操作者类别。
 * 服务端缓存 5 s（同一 shareId 5 s 内返回同一份视图），页面轮询不会打到数据库。
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyShares } from "@chaconne/db";
import { HttpError } from "../jobs/service";
import { allTimelineRows, publicActivityView, type PublicActivityView } from "./activity";

export const TASK_ACTIVITY_SHARE_KIND = "task_activity";
export const PUBLIC_ACTIVITY_CACHE_MS = 5_000;
/** 固定隐私参数（与战报 SharePrivacy 同名字段 + 本 kind 的「只出类别」） */
export const TASK_ACTIVITY_PRIVACY = { hideOwner: true, hideAssets: true, hideAmounts: true, categoriesOnly: true } as const;

export interface TaskActivityShare {
  shareId: string;
  public: boolean;
  publicUrl: string | null;
  privacy: typeof TASK_ACTIVITY_PRIVACY;
}

export async function setTaskActivityShare(db: Db, a: { callerId: string; owner: string; taskId: string; public: boolean; now: Date }): Promise<TaskActivityShare> {
  const existing = (await db.select().from(verifyShares).where(and(eq(verifyShares.kind, TASK_ACTIVITY_SHARE_KIND), eq(verifyShares.refId, a.taskId))).limit(1))[0];
  const shareId = existing?.shareId ?? `shr_${randomBytes(12).toString("hex")}`;
  if (existing) await db.update(verifyShares).set({ public: a.public, privacyJson: TASK_ACTIVITY_PRIVACY, updatedAt: a.now }).where(eq(verifyShares.shareId, shareId));
  else await db.insert(verifyShares).values({ shareId, callerId: a.callerId, ownerAddress: a.owner.toLowerCase(), kind: TASK_ACTIVITY_SHARE_KIND, refId: a.taskId, privacyJson: TASK_ACTIVITY_PRIVACY, public: a.public, createdAt: a.now, updatedAt: a.now });
  publicCache.delete(shareId);
  return { shareId, public: a.public, publicUrl: a.public ? `/pub/tasks/${shareId}/activity` : null, privacy: TASK_ACTIVITY_PRIVACY };
}

const publicCache = new Map<string, { at: number; view: PublicActivityView }>();

/** 公开视图（5 s 缓存）；私密 / 不存在 / 非本 kind → 404 */
export async function publicTaskActivity(db: Db, shareId: string, now: Date): Promise<PublicActivityView> {
  const hit = publicCache.get(shareId);
  if (hit && now.getTime() - hit.at < PUBLIC_ACTIVITY_CACHE_MS) return hit.view;
  const share = (await db.select().from(verifyShares).where(eq(verifyShares.shareId, shareId)).limit(1))[0];
  if (!share || share.kind !== TASK_ACTIVITY_SHARE_KIND || !share.public) {
    publicCache.delete(shareId);
    throw new HttpError(404, "share_not_found", "this activity board is private or does not exist");
  }
  const view = publicActivityView(await allTimelineRows(db, share.refId), now.toISOString());
  publicCache.set(shareId, { at: now.getTime(), view });
  if (publicCache.size > 5_000) for (const [k, v] of publicCache) if (now.getTime() - v.at >= PUBLIC_ACTIVITY_CACHE_MS) publicCache.delete(k);
  return view;
}

/** @internal 测试用 */
export function resetPublicActivityCache(): void {
  publicCache.clear();
}
