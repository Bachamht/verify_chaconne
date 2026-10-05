/**
 * v7 · 事件实际值（Lane D，interfaces §12.7 / §12.8）。
 * 没有新路由：既有 `GET /v1/events`、`GET /v1/events/:id/revisions`（app.ts）直接读 EventStore，
 * 这里在装配时按 `cfg.v7.outcomes` 打开存储的 v7 视图——开时事件带 `outcome`、`outcomeRevision`、`dataStatus`，
 * 摄入分类出 `data_arrived` 并调用实际值回调；关时与 v6 完全一致。
 * 本文件只由 Lane D 修改；app.ts 经 routes/index.ts 调用 registerV7D。
 */
import type { Express } from "express";
import type { AppDeps } from "../app";

/** Lane D 的服务句柄（由 src/index.ts 装配进 AppDeps.v7.d）；目前无需额外句柄 */
export interface V7DHandles {
  readonly lane: "d";
}

export function registerV7D(_app: Express, d: AppDeps): void {
  const on = d.cfg.v7.outcomes;
  d.events?.setOutcomesEnabled(on);
  d.laneD?.store.setOutcomesEnabled(on);
}
