/**
 * monitor worker（W2）：对 ACTIVE / PAUSED 授权计划定期取新证据 → 评估 → 记录变化；READY → 预生成步骤证书。
 * 间隔随时段变化（常规 30 s / 休市 5 min），每轮后按当前时段重排下一轮。只推进状态，不发交易。
 */
import { log } from "../log";
import type { MandatesService } from "./service";

export async function monitorOnce(mandates: MandatesService): Promise<{ checked: number; ready: number; expiredSteps: number; expiredMandates: number }> {
  const expiredSteps = await mandates.expireSteps();
  const expiredMandates = await mandates.expireMandates();
  const rows = await mandates.activeMandates();
  let ready = 0;
  for (const row of rows) {
    try {
      const { evaluation } = await mandates.evaluate(row);
      if (evaluation.status === "READY") ready += 1;
    } catch (err) {
      log.warn("授权计划评估失败", { mandateId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (rows.length > 0) log.info("monitor 轮次", { checked: rows.length, ready, expiredSteps, expiredMandates });
  return { checked: rows.length, ready, expiredSteps, expiredMandates };
}

export function startMonitor(mandates: MandatesService): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    if (stopped) return;
    monitorOnce(mandates)
      .catch((err) => log.error("monitor 失败", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, mandates.intervalMs());
        timer.unref();
      });
  };
  timer = setTimeout(tick, 5_000);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
