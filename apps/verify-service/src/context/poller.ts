/** crowsnest 轮询（每 60 s 拉 latest.json；有 events.json 时一并摄入事件）。只推进快照，不发交易。 */
import { validateMarketEvent, type MarketEvent } from "@chaconne/core/verify";
import { log } from "../log";
import type { CrowsnestAdapter } from "./crowsnest";
import type { EventStore } from "../events/store";

export interface ContextPollerOptions {
  contextUrl: string;
  eventsUrl?: string;
  intervalMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function pollContextOnce(adapter: CrowsnestAdapter, events: EventStore, o: ContextPollerOptions): Promise<{ context: boolean; events: number }> {
  const r = await adapter.pull(o.contextUrl, "LIVE");
  let n = 0;
  if (o.eventsUrl) {
    try {
      const res = await (o.fetchImpl ?? fetch)(o.eventsUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const raw = (await res.json()) as unknown;
        const list = Array.isArray(raw) ? raw : Array.isArray((raw as { events?: unknown })?.events) ? ((raw as { events: unknown[] }).events) : [];
        const valid: MarketEvent[] = [];
        for (const e of list) {
          const v = validateMarketEvent(e);
          if (v.ok) valid.push(v.event);
        }
        const up = await events.upsert(valid, (o.now ?? (() => new Date()))());
        n = up.inserted.length + up.revised.length;
      }
    } catch (err) {
      log.warn("events.json 拉取失败", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { context: r.ok, events: n };
}

export function startContextPoller(adapter: CrowsnestAdapter, events: EventStore, o: ContextPollerOptions): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = () => {
    if (stopped) return;
    pollContextOnce(adapter, events, o)
      .catch((err) => log.error("context poll 失败", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        if (stopped) return;
        timer = setTimeout(tick, o.intervalMs);
        timer.unref();
      });
  };
  timer = setTimeout(tick, 2_000);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
