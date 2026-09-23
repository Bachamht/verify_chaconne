/**
 * Recap 存储：内存缓存永远在；`verify_recaps` 表（迁移 0018，Lane C）落地后由 DbRecapStore 持久化。
 * 表不存在时 DbRecapStore 第一次失败即降级为内存并 warn 一次，不拒启、不伪装。
 */
import { eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyRecaps } from "@chaconne/db";
import { log } from "../log";
import type { Recap } from "./types";

export interface StoredRecap {
  callerId: string;
  recap: Recap;
}

export interface RecapStore {
  get(id: string): Promise<StoredRecap | null>;
  byShareId(shareId: string): Promise<StoredRecap | null>;
  put(callerId: string, recap: Recap): Promise<void>;
}

export class MemoryRecapStore implements RecapStore {
  private readonly byId = new Map<string, StoredRecap>();
  async get(id: string) {
    return this.byId.get(id) ?? null;
  }
  async byShareId(shareId: string) {
    for (const v of this.byId.values()) if (v.recap.share.shareId === shareId) return v;
    return null;
  }
  async put(callerId: string, recap: Recap) {
    this.byId.set(recap.id, { callerId, recap });
  }
}

export class DbRecapStore implements RecapStore {
  private degraded = false;
  private readonly mem = new MemoryRecapStore();
  constructor(private readonly db: Db) {}
  private async guard<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.degraded) return fallback();
    try {
      return await fn();
    } catch (err) {
      this.degraded = true;
      log.warn("verify_recaps 不可用（迁移 0018 未落？）：Recap 退回内存缓存", { error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
      return fallback();
    }
  }
  get(id: string) {
    return this.guard(async () => {
      const rows = await this.db.select().from(verifyRecaps).where(eq(verifyRecaps.id, id)).limit(1);
      const r = rows[0];
      return r ? { callerId: r.callerId, recap: r.recapJson as Recap } : null;
    }, () => this.mem.get(id));
  }
  byShareId(shareId: string) {
    return this.guard(async () => {
      const rows = await this.db.select().from(verifyRecaps).where(eq(verifyRecaps.shareId, shareId)).limit(1);
      const r = rows[0];
      return r && r.public ? { callerId: r.callerId, recap: r.recapJson as Recap } : null;
    }, () => this.mem.byShareId(shareId));
  }
  put(callerId: string, recap: Recap) {
    return this.guard(async () => {
      const now = new Date();
      const values = { callerId, ownerAddress: recap.owner, nyDate: recap.date, generateAfter: new Date(recap.generateAfterUtc), generatedAt: new Date(recap.generatedAt), recapJson: recap, shareId: recap.share.shareId, public: recap.share.public, hideAssets: recap.share.hideAssets, hideAmounts: recap.share.hideAmounts, updatedAt: now };
      await this.db.insert(verifyRecaps).values({ id: recap.id, ...values, createdAt: now }).onConflictDoUpdate({ target: verifyRecaps.id, set: values });
      await this.mem.put(callerId, recap);
    }, () => this.mem.put(callerId, recap));
  }
}
