/**
 * 通知载荷（D-087 / Q-05）：幂等键 `${type}:${entityId}:${version}`；载荷只含 id、类型、版本、摘要与链接，
 * 不含任何签名、证书、calldata。通知只是唤醒，不携带权限。
 */
import type { NotificationPayload, NotificationType } from "../contracts";
import { NOTIFICATION_TYPES } from "../contracts";

export function notificationKey(type: NotificationType, entityId: string, version: number): string {
  return `${type}:${entityId}:${version}`;
}

/** 载荷里绝不允许出现的键（大小写不敏感、任意深度） */
export const NOTIFICATION_FORBIDDEN_KEYS = ["signature", "certificate", "certificateSignature", "calldata", "routerCalldata", "typedData", "mandateSignature", "privateKey", "apiKey"] as const;

export function buildNotificationPayload(type: NotificationType, entityId: string, version: number, summary: string, url: string, atIso: string): NotificationPayload {
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) throw new Error(`未知通知类型 ${type}`);
  if (!Number.isInteger(version) || version < 0) throw new Error("version 必须是非负整数");
  if (!entityId) throw new Error("entityId 必填");
  return { type, entityId, version, idempotencyKey: notificationKey(type, entityId, version), summary: summary.slice(0, 500), url, at: atIso };
}

/** 载荷安全检查：递归扫描，命中禁用键 → 返回路径 */
export function forbiddenKeysIn(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (NOTIFICATION_FORBIDDEN_KEYS.some((f) => f.toLowerCase() === k.toLowerCase())) out.push(p);
    out.push(...forbiddenKeysIn(v, p));
  }
  return out;
}
