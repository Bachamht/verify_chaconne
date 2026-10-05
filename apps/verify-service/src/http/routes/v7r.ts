/**
 * v7 · 分页时间线、活动流、轮次记录读取、公开值守看板（Lane R，§12.8 中 timeline、activity、runs、share-activity、/pub/tasks/*）
 * 本文件只由 Lane R 修改；app.ts 经 routes/index.ts 调用 registerV7R。
 *
 * Lane R 没有能力开关（P1-B）：只要任务服务已装配（d.tasks）就挂载。鉴权与既有任务读接口一致：
 * `tasks.requireTask(callerId, id)`（O = owner 会话或该钱包的 key）。托管 Agent（H）的 read 权限由 Lane A 在 requireTask 里接入
 * （op = "read"，令牌绑定本任务），这里不重复判断。
 */
import type { Express, NextFunction, Request, Response } from "express";
import type { TaskRuntime } from "@chaconne/core/verify";
import type { AppDeps } from "../app";
import { apiKeyAuth, callerOf } from "../auth";
import { publicBase } from "../a2mcp";
import { HttpError } from "../../jobs/service";
import type { TaskRow } from "../../tasks/service";
import { activityPage, ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, parseCursor, parseLimit, timelinePage, TIMELINE_PAGE_DEFAULT, TIMELINE_PAGE_MAX } from "../../records/activity";
import { listRunSummaries, runDetail } from "../../records/runs";
import { publicTaskActivity, setTaskActivityShare } from "../../records/share";

/** Lane R 的服务句柄（由 src/index.ts 装配进 AppDeps.v7.r）；Lane R 按需定义字段 */
export interface V7RHandles {
  readonly lane: "r";
  /**
   * 【钩子 · Lane X / A】任务运行态（§2.1 TaskRuntime）。活动流响应的 `runtime` 字段由它给出；
   * 未装配时 `runtime: null`（页面按「运行态暂不可用」显示）。Lane I 在 index.ts 装配：`v7: { r: { lane: "r", runtime: (row) => … } }`。
   */
  runtime?: (row: TaskRow) => Promise<TaskRuntime | null>;
}

export function registerV7R(app: Express, d: AppDeps): void {
  if (!d.tasks) return;
  const tasks = d.tasks;
  const db = tasks.deps.db;
  const handles = d.v7?.r;
  const auth = apiKeyAuth(d.cfg.apiKeys, d.cfg.RATE_LIMIT_PER_MIN, { open: d.cfg.authOpen, resolve: d.keys ? (k) => d.keys!.resolve(k) : undefined, keysUrl: `${publicBase(d.cfg)}/agent/keys` });
  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
  const readTask = (res: Response, req: Request): Promise<TaskRow> => tasks.requireTask(callerOf(res), String(req.params["id"]), "read");

  /* ---------- R2：分页全量时间线 ---------- */
  app.get(
    "/v1/tasks/:id/timeline",
    auth,
    wrap(async (req, res) => {
      const row = await readTask(res, req);
      const cursor = parseCursor(req.query["cursor"]);
      const limit = parseLimit(req.query["limit"], TIMELINE_PAGE_DEFAULT, TIMELINE_PAGE_MAX);
      if (cursor === null || limit === null) throw new HttpError(400, "invalid_request", "cursor must be a timeline id (digits); limit 1..500", [{ field: cursor === null ? "cursor" : "limit", code: "invalid" }]);
      const page = await timelinePage(db, row.id, cursor, limit);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ taskId: row.id, ...page });
    }),
  );

  /* ---------- R2：增量活动流 {items, nextCursor, runtime} ---------- */
  app.get(
    "/v1/tasks/:id/activity",
    auth,
    wrap(async (req, res) => {
      const row = await readTask(res, req);
      const since = parseCursor(req.query["since"]);
      const limit = parseLimit(req.query["limit"], ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX);
      if (since === null || limit === null) throw new HttpError(400, "invalid_request", "since must be a timeline id (digits); limit 1..200", [{ field: since === null ? "since" : "limit", code: "invalid" }]);
      const page = await activityPage(db, row.id, since, limit);
      // 【钩子】运行态由 Lane X / A 提供（V7RHandles.runtime）；未装配 → null
      const runtime = handles?.runtime ? await handles.runtime(row).catch(() => null) : null;
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ taskId: row.id, taskStatus: row.status, items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, runtime });
    }),
  );

  /* ---------- R2：轮次摘要 / 详情（只给预览与哈希，永不返回 messages_json） ---------- */
  app.get(
    "/v1/tasks/:id/runs",
    auth,
    wrap(async (req, res) => {
      const row = await readTask(res, req);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ taskId: row.id, runs: await listRunSummaries(db, row.id) });
    }),
  );
  app.get(
    "/v1/tasks/:id/runs/:runId",
    auth,
    wrap(async (req, res) => {
      const row = await readTask(res, req);
      const detail = await runDetail(db, row.id, String(req.params["runId"]));
      if (!detail) throw new HttpError(404, "run_not_found", "no such run for this task");
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ taskId: row.id, ...detail });
    }),
  );

  /* ---------- R5：公开值守看板（只出类别 + 时间 + 操作者类别；5 s 服务端缓存） ---------- */
  const now = d.now ?? (() => new Date());
  app.post(
    "/v1/tasks/:id/share-activity",
    auth,
    wrap(async (req, res) => {
      // owner_write（§2.9）：托管 Agent 不能开分享
      const row = await tasks.requireTask(callerOf(res), String(req.params["id"]), "owner_write");
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b["public"] !== undefined && typeof b["public"] !== "boolean") throw new HttpError(400, "invalid_request", "public must be a boolean", [{ field: "public", code: "expected_boolean" }]);
      const share = await setTaskActivityShare(db, { callerId: callerOf(res), owner: row.ownerAddress, taskId: row.id, public: b["public"] !== false, now: now() });
      res.status(201).json({ taskId: row.id, ...share, note: "The public board shows only activity categories, actor categories and timestamps: no amounts, quantities, addresses, ids or free text." });
    }),
  );
  app.get(
    "/pub/tasks/:shareId/activity",
    wrap(async (req, res) => {
      const view = await publicTaskActivity(db, String(req.params["shareId"]), now());
      res.setHeader("Cache-Control", "public, max-age=5");
      res.json({ shareId: String(req.params["shareId"]), ...view });
    }),
  );
}
