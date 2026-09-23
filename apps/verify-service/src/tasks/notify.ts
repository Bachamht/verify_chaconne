/**
 * 通知钩子：任务层只产出 NotificationPayload（D-087：只含 id/类型/版本/摘要/链接，不含签名、证书、calldata）。
 * 真身是 Lane C 的 outbox（`notify/service.ts NotifyService.notify(...)`，经 `tasks/integrations.ts` 适配）；
 * 未接时 NoopTaskNotifier 只记内存（测试断言用）。幂等键 `${type}:${entityId}:${version}`。
 */
import type { NotificationPayload, NotificationType } from "@chaconne/core/verify";
import { log } from "../log";

export interface TaskNotifier {
  emit(payload: NotificationPayload, ownerAddress: string): Promise<void>;
}

export function notificationPayload(type: NotificationType, entityId: string, version: number, summary: string, url: string, at: string): NotificationPayload {
  return { type, entityId, version, idempotencyKey: `${type}:${entityId}:${version}`, summary, url, at };
}

export class NoopTaskNotifier implements TaskNotifier {
  readonly emitted: NotificationPayload[] = [];
  async emit(payload: NotificationPayload): Promise<void> {
    this.emitted.push(payload);
    if (this.emitted.length > 500) this.emitted.splice(0, this.emitted.length - 500);
    log.info("通知（未接 outbox，no-op）", { type: payload.type, entityId: payload.entityId, key: payload.idempotencyKey });
  }
}

/** 同时记内存并转发到 outbox（测试可断言，生产入队） */
export class FanoutTaskNotifier implements TaskNotifier {
  readonly emitted: NotificationPayload[] = [];
  constructor(private readonly sinks: TaskNotifier[]) {}
  async emit(payload: NotificationPayload, ownerAddress: string): Promise<void> {
    this.emitted.push(payload);
    if (this.emitted.length > 500) this.emitted.splice(0, this.emitted.length - 500);
    for (const s of this.sinks) await s.emit(payload, ownerAddress).catch((err) => log.warn("通知转发失败", { type: payload.type, error: err instanceof Error ? err.message : String(err) }));
  }
}
