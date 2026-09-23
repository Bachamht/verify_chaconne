/**
 * 执行器在线态（Q-08，interfaces §11.5）：3 分钟内有心跳 = online；浏览器钱包路径 = awaiting_signature；都无 = offline。
 * 信息项，不阻塞签发。
 */
import type { ExecutorPresence } from "../contracts";

export const HEARTBEAT_WINDOW_MS = 3 * 60_000;
export const HEARTBEAT_INTERVAL_S = 60;

export type ExecutorPath = "agent_wallet" | "browser_wallet";

export interface HeartbeatView {
  path: ExecutorPath;
  lastSeenAt: string;
}

export function executorPresence(heartbeats: readonly HeartbeatView[], nowIso: string, windowMs = HEARTBEAT_WINDOW_MS): { presence: ExecutorPresence; lastSeenAt: string | null; text: string } {
  const now = Date.parse(nowIso);
  const fresh = heartbeats.filter((h) => now - Date.parse(h.lastSeenAt) <= windowMs);
  const latest = heartbeats.reduce<string | null>((m, h) => (m === null || h.lastSeenAt > m ? h.lastSeenAt : m), null);
  if (fresh.some((h) => h.path === "agent_wallet")) return { presence: "online", lastSeenAt: latest, text: "Authorized and an executor is online; steps can be executed unattended." };
  if (fresh.some((h) => h.path === "browser_wallet") || heartbeats.some((h) => h.path === "browser_wallet")) return { presence: "awaiting_signature", lastSeenAt: latest, text: "Waiting for the user to come back and sign in the browser wallet; nothing is scheduled unattended." };
  return { presence: "offline", lastSeenAt: latest, text: "No executor heartbeat in the last 3 minutes; a prepared step will not be executed until an executor returns." };
}
