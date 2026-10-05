/**
 * /healthz 的 executor 段（interfaces §12.15）：{ enabled, address, gasOk, lastHeartbeatAt }。
 * address = 最近一次心跳的执行身份地址（链上公开信息）；gasOk = 该地址最近心跳未报 gasLow；无心跳 → address / lastHeartbeatAt 为 null、gasOk 为 null（未知）。
 */
export interface ExecutorHealth {
  enabled: boolean;
  address: string | null;
  gasOk: boolean | null;
  lastHeartbeatAt: string | null;
}

export function executorHealth(enabled: boolean, statuses: ReadonlyArray<{ executor: string; lastHeartbeatAt: Date | null }>, gasLow: (executor: string) => boolean): ExecutorHealth {
  let latest: { executor: string; lastHeartbeatAt: Date } | null = null;
  for (const s of statuses) {
    if (!s.lastHeartbeatAt) continue;
    if (!latest || s.lastHeartbeatAt.getTime() > latest.lastHeartbeatAt.getTime()) latest = { executor: s.executor, lastHeartbeatAt: s.lastHeartbeatAt };
  }
  if (!latest) return { enabled, address: null, gasOk: null, lastHeartbeatAt: null };
  return { enabled, address: latest.executor.toLowerCase(), gasOk: !gasLow(latest.executor), lastHeartbeatAt: latest.lastHeartbeatAt.toISOString() };
}
