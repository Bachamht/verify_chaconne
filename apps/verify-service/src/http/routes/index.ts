/**
 * v7 路由挂载点（Lane I，开发计划 §2.8）。
 * app.ts 只调用这里的两个函数；每条 lane 只改自己的模块（v7x / v7a / v7d / v7r），互不冲突。
 *   - registerV7Early：在所有旧路由之前执行（Lane A 的服务 key 默认拒绝中间件、轮次令牌解析放这里）
 *   - registerV7Routes：在旧路由之后、405 / 404 之前挂载各 lane 的新路由
 * 所有 v7 能力缺省关闭（interfaces §12.12）；对应开关为 false 时各 lane 的模块不挂路由或回 503 hosted_disabled。
 */
import type { Express } from "express";
import type { AppDeps } from "../app";
import { registerV7X, type V7XHandles } from "./v7x";
import { registerV7A, registerV7AEarly, type V7AHandles } from "./v7a";
import { registerV7D, type V7DHandles } from "./v7d";
import { registerV7R, type V7RHandles } from "./v7r";

/** 各 lane 的服务句柄（由 index.ts 装配后放进 AppDeps.v7）；类型在各 lane 自己的模块里定义 */
export interface V7Handles {
  x?: V7XHandles;
  a?: V7AHandles;
  d?: V7DHandles;
  r?: V7RHandles;
}

export function registerV7Early(app: Express, d: AppDeps): void {
  registerV7AEarly(app, d);
}

export function registerV7Routes(app: Express, d: AppDeps): void {
  registerV7R(app, d);
  registerV7X(app, d);
  registerV7A(app, d);
  registerV7D(app, d);
}
