/**
 * 通知（C4，D-087）：outbox 幂等（`${type}:${entityId}:${version}`）→ 渠道投递（webhook HMAC-SHA256 / Telegram 独立 bot 只推送）。
 * 载荷只含 id/类型/版本/摘要/链接；通知不携带权限，接收方必须重新取任务/报价/证据后执行。
 * webhook 连续 3 次投递失败 → 渠道停用并写任务时间线（TimelineSink，由任务层实现；默认记日志 + outbox deliveries）。
 * 执行器心跳（60 s）→ verify_executor_heartbeats；在线态三态由 core executorPresence 判定。
 *
 * 对 Lane B 暴露：`notify(type, entityId, version, summary, url, ownerAddress)` 入队；`presence(mandateId)`。
 */
import { createHmac, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyExecutorHeartbeats, verifyMandates, verifyNotificationChannels, verifyNotificationOutbox } from "@chaconne/db";
import { isEvmAddress, type ExecutorPresence, type NotificationPayload, type NotificationType } from "@chaconne/core/verify";
import { buildNotificationPayload, executorPresence, forbiddenKeysIn, HEARTBEAT_INTERVAL_S, type ExecutorPath } from "@chaconne/core/verify/budget/index";
import { HttpError } from "../jobs/service";
import { newId } from "../ids";
import { log } from "../log";
import { assertOwner } from "../portfolio/ownerAuth";

export type ChannelRow = typeof verifyNotificationChannels.$inferSelect;
export type OutboxRow = typeof verifyNotificationOutbox.$inferSelect;

export const SIGNATURE_HEADER = "x-chaconne-signature";
export const TIMESTAMP_HEADER = "x-chaconne-timestamp";
export const MAX_CHANNEL_FAILURES = 3;
const RETRY_BACKOFF_MS = [10_000, 60_000, 300_000];
const LINK_CODE_TTL_MS = 10 * 60_000;

/** 任务时间线：由任务层（Lane B）实现；渠道停用等事件写到任务 */
export interface TimelineSink {
  append(entry: { entityId: string; kind: "notification_channel_disabled" | "notification_failed"; at: string; detail: Record<string, unknown> }): Promise<void>;
}
export interface TelegramSender {
  send(chatId: string, text: string): Promise<{ ok: boolean; status: number; error?: string }>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface NotifyDeps {
  db: Db;
  now?: () => Date;
  fetchImpl?: FetchLike;
  telegram?: TelegramSender | null;
  timeline?: TimelineSink;
  webhookTimeoutMs?: number;
  publicBaseUrl?: string;
  /** 非生产允许 http://（本机联调） */
  allowInsecureWebhook?: boolean;
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** 真实 Telegram Bot API（只用 sendMessage；token 只从 env 来） */
export function telegramSender(token: string, fetchImpl: typeof fetch = fetch): TelegramSender {
  return {
    async send(chatId, text) {
      try {
        const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) });
        return { ok: r.ok, status: r.status, error: r.ok ? undefined : `telegram_${r.status}` };
      } catch (e) {
        return { ok: false, status: 0, error: e instanceof Error ? e.message.slice(0, 120) : String(e) };
      }
    },
  };
}

export class NotifyService {
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;
  private timeline: TimelineSink;
  constructor(private readonly d: NotifyDeps) {
    this.now = d.now ?? (() => new Date());
    this.fetchImpl = d.fetchImpl ?? ((url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status })));
    this.timeline = d.timeline ?? { append: async (e) => log.warn("任务时间线（未接任务层）", { entityId: e.entityId, kind: e.kind, ...e.detail }) };
  }
  /** Lane B 接上任务时间线 */
  setTimelineSink(sink: TimelineSink): void {
    this.timeline = sink;
  }
  get telegramConfigured(): boolean {
    return Boolean(this.d.telegram);
  }

  /* ---------- 入队（幂等） ---------- */
  async notify(type: NotificationType, entityId: string, version: number, summary: string, url: string, ownerAddress: string): Promise<{ enqueued: boolean; outboxId: string; idempotencyKey: string; payload: NotificationPayload }> {
    const payload = buildNotificationPayload(type, entityId, version, summary, url, this.now().toISOString());
    const bad = forbiddenKeysIn(payload);
    if (bad.length > 0) throw new Error(`通知载荷含禁用键：${bad.join(",")}`);
    const now = this.now();
    const [row] = await this.d.db
      .insert(verifyNotificationOutbox)
      .values({ id: newId("ntf"), idempotencyKey: payload.idempotencyKey, ownerAddress: ownerAddress.toLowerCase(), type, entityId, version, payload, state: "pending", attempts: 0, nextAttemptAt: now, deliveries: [], lastError: null, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: verifyNotificationOutbox.idempotencyKey })
      .returning({ id: verifyNotificationOutbox.id });
    if (row) return { enqueued: true, outboxId: row.id, idempotencyKey: payload.idempotencyKey, payload };
    const existing = (await this.d.db.select({ id: verifyNotificationOutbox.id }).from(verifyNotificationOutbox).where(eq(verifyNotificationOutbox.idempotencyKey, payload.idempotencyKey)).limit(1))[0]!;
    return { enqueued: false, outboxId: existing.id, idempotencyKey: payload.idempotencyKey, payload };
  }

  async outbox(entityId: string): Promise<OutboxRow[]> {
    return this.d.db.select().from(verifyNotificationOutbox).where(eq(verifyNotificationOutbox.entityId, entityId)).orderBy(asc(verifyNotificationOutbox.createdAt));
  }
  async outboxById(id: string): Promise<OutboxRow | null> {
    return (await this.d.db.select().from(verifyNotificationOutbox).where(eq(verifyNotificationOutbox.id, id)).limit(1))[0] ?? null;
  }

  /* ---------- 渠道 ---------- */
  channelView(c: ChannelRow) {
    return { channelId: c.id, kind: c.kind as "webhook" | "telegram", owner: c.ownerAddress, target: c.kind === "webhook" ? c.target : c.target ? "linked" : null, state: c.state as "active" | "pending_link" | "disabled", consecutiveFailures: c.consecutiveFailures, disabledAt: c.disabledAt?.toISOString() ?? null, disabledReason: c.disabledReason, linkedAt: c.linkedAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString() };
  }

  async registerWebhook(callerId: string, raw: unknown) {
    const b = (raw ?? {}) as { ownerAddress?: string; url?: string; secret?: string };
    if (!isEvmAddress(b.ownerAddress)) throw new HttpError(400, "invalid_request", "ownerAddress 须为 EVM 地址");
    let u: URL;
    try {
      u = new URL(String(b.url));
    } catch {
      throw new HttpError(400, "invalid_request", "url 非法");
    }
    if (u.protocol !== "https:" && !(this.d.allowInsecureWebhook && u.protocol === "http:")) throw new HttpError(400, "invalid_request", "webhook 须为 https");
    if (typeof b.secret !== "string" || b.secret.length < 16 || b.secret.length > 256) throw new HttpError(400, "invalid_request", "secret 须为 16–256 字符（用于 HMAC-SHA256 签名）");
    const owner = await assertOwner(this.d.db, callerId, b.ownerAddress!);
    const now = this.now();
    const [row] = await this.d.db.insert(verifyNotificationChannels).values({ id: newId("nch"), callerId, ownerAddress: owner, kind: "webhook", target: u.toString(), secret: b.secret, state: "active", consecutiveFailures: 0, createdAt: now, updatedAt: now }).returning();
    return this.channelView(row!);
  }

  async requireChannel(callerId: string, id: string): Promise<ChannelRow> {
    const row = (await this.d.db.select().from(verifyNotificationChannels).where(eq(verifyNotificationChannels.id, id)).limit(1))[0];
    if (!row) throw new HttpError(404, "channel_not_found");
    await assertOwner(this.d.db, callerId, row.ownerAddress);
    return row;
  }
  async deleteChannel(callerId: string, id: string): Promise<void> {
    await this.requireChannel(callerId, id);
    await this.d.db.delete(verifyNotificationChannels).where(eq(verifyNotificationChannels.id, id));
  }
  async channelsFor(owner: string): Promise<ChannelRow[]> {
    return this.d.db.select().from(verifyNotificationChannels).where(eq(verifyNotificationChannels.ownerAddress, owner.toLowerCase())).orderBy(asc(verifyNotificationChannels.createdAt));
  }

  /**
   * Telegram 链接码流程（Q-07）：
   *   第一步 {ownerAddress} → 生成链接码（10 分钟）；用户把 chat id 与链接码交回；
   *   第二步 {ownerAddress, code, chatId} → 用独立 bot 向该 chat 推一条含链接码的确认消息（只推送，不读更新），推送成功才算链接完成。
   * token 未配置 → 503 not_configured（明确，不伪装）。
   */
  async telegramLink(callerId: string, raw: unknown) {
    if (!this.d.telegram) throw new HttpError(503, "not_configured", "VERIFY_TG_BOT_TOKEN 未配置：Telegram 推送不可用");
    const b = (raw ?? {}) as { ownerAddress?: string; code?: string; chatId?: string };
    if (!isEvmAddress(b.ownerAddress)) throw new HttpError(400, "invalid_request", "ownerAddress 须为 EVM 地址");
    const owner = await assertOwner(this.d.db, callerId, b.ownerAddress!);
    const now = this.now();
    if (!b.code) {
      const code = randomBytes(4).toString("hex").toUpperCase();
      const [row] = await this.d.db.insert(verifyNotificationChannels).values({ id: newId("nch"), callerId, ownerAddress: owner, kind: "telegram", target: null, secret: null, state: "pending_link", consecutiveFailures: 0, linkCode: code, linkExpiresAt: new Date(now.getTime() + LINK_CODE_TTL_MS), createdAt: now, updatedAt: now }).returning();
      return { step: "code_issued" as const, channelId: row!.id, code, expiresAt: row!.linkExpiresAt!.toISOString(), instructions: "Open a chat with the Chaconne notification bot, then call this endpoint again with { ownerAddress, code, chatId } — the bot will push a confirmation containing this code; the link is complete only when that push succeeds. The bot only sends; it never reads your messages." };
    }
    if (typeof b.chatId !== "string" || !/^-?\d{1,20}$/.test(b.chatId)) throw new HttpError(400, "invalid_request", "chatId 须为 Telegram 数字 chat id");
    const pending = (await this.d.db.select().from(verifyNotificationChannels).where(and(eq(verifyNotificationChannels.ownerAddress, owner), eq(verifyNotificationChannels.kind, "telegram"), eq(verifyNotificationChannels.state, "pending_link"), eq(verifyNotificationChannels.linkCode, String(b.code).toUpperCase()))).limit(1))[0];
    if (!pending) throw new HttpError(404, "link_code_not_found");
    if (pending.linkExpiresAt && pending.linkExpiresAt.getTime() < now.getTime()) throw new HttpError(410, "link_code_expired");
    const r = await this.d.telegram.send(b.chatId, `Chaconne Verify: link code ${pending.linkCode} confirmed for ${owner.slice(0, 6)}…${owner.slice(-4)}. This chat will receive task notifications (wake-up only; no permissions are carried).`);
    if (!r.ok) throw new HttpError(502, "telegram_push_failed", "确认消息推送失败，链接未完成", { status: r.status, error: r.error });
    const [row] = await this.d.db.update(verifyNotificationChannels).set({ target: b.chatId, state: "active", linkedAt: now, linkCode: null, linkExpiresAt: null, updatedAt: now }).where(eq(verifyNotificationChannels.id, pending.id)).returning();
    return { step: "linked" as const, channel: this.channelView(row!) };
  }

  /** POST /v1/notify/test：入队一条测试通知并立即派发，返回各渠道结果 */
  async sendTest(callerId: string, raw: unknown) {
    const b = (raw ?? {}) as { ownerAddress?: string };
    if (!isEvmAddress(b.ownerAddress)) throw new HttpError(400, "invalid_request", "ownerAddress 须为 EVM 地址");
    const owner = await assertOwner(this.d.db, callerId, b.ownerAddress!);
    const version = Math.floor(this.now().getTime() / 1000);
    const q = await this.notify("task.status_changed", `notify-test:${owner}`, version, "Test notification from Chaconne Verify (no action required).", `${this.d.publicBaseUrl ?? ""}/v1/portfolio/${owner}`, owner);
    const r = await this.dispatchOnce();
    const row = await this.outboxById(q.outboxId);
    return { outboxId: q.outboxId, idempotencyKey: q.idempotencyKey, enqueued: q.enqueued, dispatched: r, state: row?.state ?? null, deliveries: row?.deliveries ?? [] };
  }

  /* ---------- 派发 ---------- */
  async dispatchOnce(limit = 50): Promise<{ picked: number; sent: number; failed: number; disabledChannels: string[] }> {
    const now = this.now();
    const rows = await this.d.db
      .select()
      .from(verifyNotificationOutbox)
      .where(and(eq(verifyNotificationOutbox.state, "pending"), or(isNull(verifyNotificationOutbox.nextAttemptAt), lte(verifyNotificationOutbox.nextAttemptAt, now))))
      .orderBy(asc(verifyNotificationOutbox.createdAt))
      .limit(limit);
    let sent = 0;
    let failed = 0;
    const disabledChannels: string[] = [];
    for (const row of rows) {
      const channels = (await this.channelsFor(row.ownerAddress)).filter((c) => c.state === "active");
      const prior = (row.deliveries as Array<{ channelId: string; ok: boolean }>) ?? [];
      const doneChannels = new Set(prior.filter((p) => p.ok).map((p) => p.channelId));
      const deliveries = [...prior];
      let anyFail = false;
      for (const c of channels) {
        if (doneChannels.has(c.id)) continue;
        const r = await this.deliver(c, row.payload as NotificationPayload);
        deliveries.push({ channelId: c.id, kind: c.kind, ok: r.ok, status: r.status, at: this.now().toISOString(), ...(r.error ? { error: r.error } : {}) } as { channelId: string; ok: boolean });
        if (r.ok) {
          if (c.consecutiveFailures > 0) await this.d.db.update(verifyNotificationChannels).set({ consecutiveFailures: 0, updatedAt: this.now() }).where(eq(verifyNotificationChannels.id, c.id));
          continue;
        }
        anyFail = true;
        const failures = c.consecutiveFailures + 1;
        const disable = failures >= MAX_CHANNEL_FAILURES;
        await this.d.db.update(verifyNotificationChannels).set({ consecutiveFailures: failures, ...(disable ? { state: "disabled", disabledAt: this.now(), disabledReason: `${MAX_CHANNEL_FAILURES}_consecutive_failures` } : {}), updatedAt: this.now() }).where(eq(verifyNotificationChannels.id, c.id));
        if (disable) {
          disabledChannels.push(c.id);
          await this.timeline.append({ entityId: row.entityId, kind: "notification_channel_disabled", at: this.now().toISOString(), detail: { channelId: c.id, kind: c.kind, failures, lastStatus: r.status, lastError: r.error ?? null, notificationType: row.type } });
          log.warn("通知渠道已停用", { channelId: c.id, kind: c.kind, entityId: row.entityId, failures });
        }
      }
      const attempts = row.attempts + 1;
      if (!anyFail) {
        await this.d.db.update(verifyNotificationOutbox).set({ state: channels.length === 0 ? "no_channel" : "sent", attempts, deliveries, nextAttemptAt: null, lastError: null, updatedAt: this.now() }).where(eq(verifyNotificationOutbox.id, row.id));
        sent += 1;
      } else if (attempts >= RETRY_BACKOFF_MS.length) {
        await this.d.db.update(verifyNotificationOutbox).set({ state: "failed", attempts, deliveries, nextAttemptAt: null, lastError: "max_attempts", updatedAt: this.now() }).where(eq(verifyNotificationOutbox.id, row.id));
        await this.timeline.append({ entityId: row.entityId, kind: "notification_failed", at: this.now().toISOString(), detail: { outboxId: row.id, idempotencyKey: row.idempotencyKey, attempts } });
        failed += 1;
      } else {
        await this.d.db.update(verifyNotificationOutbox).set({ attempts, deliveries, nextAttemptAt: new Date(this.now().getTime() + RETRY_BACKOFF_MS[attempts - 1]!), lastError: "delivery_failed", updatedAt: this.now() }).where(eq(verifyNotificationOutbox.id, row.id));
        failed += 1;
      }
    }
    return { picked: rows.length, sent, failed, disabledChannels };
  }

  private async deliver(c: ChannelRow, payload: NotificationPayload): Promise<{ ok: boolean; status: number; error?: string }> {
    if (c.kind === "telegram") {
      if (!this.d.telegram) return { ok: false, status: 0, error: "not_configured" };
      if (!c.target) return { ok: false, status: 0, error: "not_linked" };
      return this.d.telegram.send(c.target, `[Chaconne] ${payload.type} · ${payload.summary}\n${payload.url}`);
    }
    if (!c.target || !c.secret) return { ok: false, status: 0, error: "channel_incomplete" };
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(this.now().getTime() / 1000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.d.webhookTimeoutMs ?? 8000);
    try {
      const r = await this.fetchImpl(c.target, { method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signWebhookBody(c.secret, ts, body), [TIMESTAMP_HEADER]: ts, "x-chaconne-idempotency-key": payload.idempotencyKey }, body, signal: ctrl.signal });
      return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `http_${r.status}` };
    } catch (e) {
      return { ok: false, status: 0, error: e instanceof Error ? e.message.slice(0, 120) : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 执行器心跳（Q-08） ---------- */
  async heartbeat(callerId: string, mandateId: string, raw: unknown): Promise<void> {
    const b = (raw ?? {}) as { executorId?: string; path?: string; meta?: unknown };
    const m = (await this.d.db.select().from(verifyMandates).where(eq(verifyMandates.id, mandateId)).limit(1))[0];
    if (!m) throw new HttpError(404, "mandate_not_found");
    if (m.callerId !== callerId) await assertOwner(this.d.db, callerId, m.ownerAddress);
    const path: ExecutorPath = b.path === "browser_wallet" ? "browser_wallet" : "agent_wallet";
    const executorId = typeof b.executorId === "string" && /^[A-Za-z0-9_\-:.]{1,80}$/.test(b.executorId) ? b.executorId : callerId;
    const now = this.now();
    const meta = b.meta && typeof b.meta === "object" ? (b.meta as Record<string, unknown>) : null;
    await this.d.db
      .insert(verifyExecutorHeartbeats)
      .values({ id: newId("hb"), mandateId, executorId, path, lastSeenAt: now, meta, createdAt: now })
      .onConflictDoUpdate({ target: [verifyExecutorHeartbeats.mandateId, verifyExecutorHeartbeats.executorId], set: { path, lastSeenAt: now, meta } });
  }

  async presence(mandateId: string): Promise<{ presence: ExecutorPresence; lastSeenAt: string | null; text: string; heartbeatIntervalSeconds: number }> {
    const rows = await this.d.db.select().from(verifyExecutorHeartbeats).where(eq(verifyExecutorHeartbeats.mandateId, mandateId)).orderBy(desc(verifyExecutorHeartbeats.lastSeenAt)).limit(20);
    const p = executorPresence(rows.map((r) => ({ path: r.path as ExecutorPath, lastSeenAt: r.lastSeenAt.toISOString() })), this.now().toISOString());
    return { ...p, heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_S };
  }

  async presenceMany(mandateIds: string[]): Promise<Map<string, Awaited<ReturnType<NotifyService["presence"]>>>> {
    const out = new Map<string, Awaited<ReturnType<NotifyService["presence"]>>>();
    if (mandateIds.length === 0) return out;
    const rows = await this.d.db.select().from(verifyExecutorHeartbeats).where(inArray(verifyExecutorHeartbeats.mandateId, mandateIds));
    const nowIso = this.now().toISOString();
    for (const id of mandateIds) {
      const p = executorPresence(rows.filter((r) => r.mandateId === id).map((r) => ({ path: r.path as ExecutorPath, lastSeenAt: r.lastSeenAt.toISOString() })), nowIso);
      out.set(id, { ...p, heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_S });
    }
    return out;
  }
}

export function startNotifyDispatcher(notify: NotifyService, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    notify
      .dispatchOnce()
      .catch((err) => log.error("通知派发失败", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
