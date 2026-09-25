/**
 * 钱包绑定的 API key（FIX-175）：钱包签一条消息（core `apiKeyIssueMessage`）→ 签发 `vk_live_…`，调用方 = `agent:<钱包>`。
 * 只存 sha256；nonce 唯一（签名不能重放）；issuedAt 与服务器时钟相差超过 10 分钟拒绝；吊销后立即失效。
 * 签发端点不走 API key 鉴权（签名就是凭证）；列出 / 吊销要求调用方代表该钱包（网页会话或该钱包的 key）。
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { verifyMessage, type Hex } from "viem";
import type { Db } from "@chaconne/db";
import { verifyApiKeys } from "@chaconne/db";
import { API_KEY_ISSUE_MAX_SKEW_MS, API_KEY_MAX_ACTIVE_PER_OWNER, apiKeyIssueMessage, normalizeApiKeyIssueFields } from "@chaconne/core/verify";
import { callerActsFor } from "../http/auth";
import { newId } from "../ids";
import { HttpError } from "../jobs/service";

export const API_KEY_PREFIX = "vk_live_";
const TOUCH_INTERVAL_MS = 10 * 60_000;

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function callerIdForKeyOwner(owner: string): string {
  return `agent:${owner.toLowerCase()}`;
}
const hintOf = (raw: string) => `${raw.slice(0, API_KEY_PREFIX.length + 4)}…${raw.slice(-4)}`;

export interface ApiKeyView {
  id: string;
  label: string;
  hint: string;
  ownerAddress: string;
  callerId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

type Row = typeof verifyApiKeys.$inferSelect;

export class ApiKeysService {
  private readonly touched = new Map<string, number>();
  constructor(private readonly d: { db: Db; now: () => Date }) {}

  private view(r: Row): ApiKeyView {
    return { id: r.id, label: r.label, hint: r.hint, ownerAddress: r.ownerAddress, callerId: callerIdForKeyOwner(r.ownerAddress), createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null };
  }

  /** 签发：验签 → 唯一 nonce → 返回明文 key（只此一次） */
  async issue(raw: unknown): Promise<ApiKeyView & { apiKey: string }> {
    const n = normalizeApiKeyIssueFields(raw);
    if (!n.ok) throw new HttpError(400, "invalid_request", `${n.field}: ${n.code}`, [{ field: n.field, code: n.code }]);
    const sig = (raw as { signature?: unknown } | null)?.signature;
    if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new HttpError(400, "invalid_request", "signature: expected a 65-byte hex signature", [{ field: "signature", code: "invalid_signature" }]);
    const now = this.d.now();
    if (Math.abs(now.getTime() - Date.parse(n.fields.issuedAt)) > API_KEY_ISSUE_MAX_SKEW_MS) throw new HttpError(400, "issued_at_out_of_window", "issuedAt must be within 10 minutes of the server clock");
    let ok = false;
    try {
      ok = await verifyMessage({ address: n.fields.owner as Hex, message: apiKeyIssueMessage(n.fields), signature: sig as Hex });
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(401, "bad_signature", "The signature was not produced by this wallet for this message");
    const dup = (await this.d.db.select({ id: verifyApiKeys.id }).from(verifyApiKeys).where(eq(verifyApiKeys.nonce, n.fields.nonce)).limit(1))[0];
    if (dup) throw new HttpError(409, "nonce_reused", "This signed message was already used to issue a key");
    const active = await this.d.db.select({ id: verifyApiKeys.id }).from(verifyApiKeys).where(and(eq(verifyApiKeys.ownerAddress, n.fields.owner), isNull(verifyApiKeys.revokedAt)));
    if (active.length >= API_KEY_MAX_ACTIVE_PER_OWNER) throw new HttpError(409, "too_many_keys", `A wallet can hold at most ${API_KEY_MAX_ACTIVE_PER_OWNER} active keys; revoke one first`);
    const rawKey = `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
    const [row] = await this.d.db
      .insert(verifyApiKeys)
      .values({ id: newId("key"), keyHash: hashApiKey(rawKey), ownerAddress: n.fields.owner, label: n.fields.label, hint: hintOf(rawKey), nonce: n.fields.nonce, createdAt: now })
      .returning();
    return { ...this.view(row!), apiKey: rawKey };
  }

  async list(owner: string): Promise<ApiKeyView[]> {
    const rows = await this.d.db.select().from(verifyApiKeys).where(and(eq(verifyApiKeys.ownerAddress, owner.toLowerCase()), isNull(verifyApiKeys.revokedAt))).orderBy(desc(verifyApiKeys.createdAt));
    return rows.map((r) => this.view(r));
  }

  /** 吊销：不存在或不代表该钱包 → 404（不泄漏存在性）；幂等 */
  async revoke(callerId: string, id: string): Promise<ApiKeyView & { revoked: true }> {
    const row = (await this.d.db.select().from(verifyApiKeys).where(eq(verifyApiKeys.id, id)).limit(1))[0];
    if (!row || !callerActsFor(callerId, row.ownerAddress)) throw new HttpError(404, "key_not_found");
    if (!row.revokedAt) await this.d.db.update(verifyApiKeys).set({ revokedAt: this.d.now() }).where(eq(verifyApiKeys.id, id));
    return { ...this.view(row), revoked: true };
  }

  /** 鉴权中间件用：明文 key → 调用方；吊销的当不存在。最多每 10 分钟记一次 lastUsedAt */
  async resolve(rawKey: string): Promise<{ callerId: string; id: string } | null> {
    if (!rawKey.startsWith(API_KEY_PREFIX)) return null;
    const row = (await this.d.db.select({ id: verifyApiKeys.id, ownerAddress: verifyApiKeys.ownerAddress, revokedAt: verifyApiKeys.revokedAt }).from(verifyApiKeys).where(eq(verifyApiKeys.keyHash, hashApiKey(rawKey))).limit(1))[0];
    if (!row || row.revokedAt) return null;
    const t = this.d.now().getTime();
    if ((this.touched.get(row.id) ?? 0) + TOUCH_INTERVAL_MS < t) {
      this.touched.set(row.id, t);
      void this.d.db.update(verifyApiKeys).set({ lastUsedAt: new Date(t) }).where(eq(verifyApiKeys.id, row.id)).catch(() => undefined);
    }
    return { callerId: callerIdForKeyOwner(row.ownerAddress), id: row.id };
  }
}
