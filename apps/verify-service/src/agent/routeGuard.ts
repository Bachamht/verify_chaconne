/**
 * 服务 key 的默认拒绝路由白名单（D-093 / CV-D25，开发计划 §2.9）。
 * authKind=service 的请求先过这里；不在白名单 → 403 service_route_forbidden，根本到不了各服务自己的鉴权
 * （建任务、事件影响动作、授权计划、组合、通知、资金组、调仓、key、理由卡创建、Lab 对照、运营者端点都在这里被挡）。
 *
 * agent:hosted → §2.8 标 H 的路由 + §2.9 的 agent_write 路由 + 白名单工具背后的读路由 + 免费端点 + /v1/agent/*
 * executor:hosted → 只有 /v1/executor/*
 */
import type { ServiceCaller } from "../http/auth";

export type RouteScope =
  /** 免费端点：不需要轮次令牌 */
  | "free"
  /** /v1/context：带 taskId 时需要令牌且必须是令牌绑定的任务 */
  | "context"
  /** /v1/agent/claim、/v1/agent/heartbeat：不需要令牌 */
  | "agent_open"
  /** /v1/agent/runs/:runId/*：需要令牌且 runId == 令牌的轮次 */
  | "agent_run"
  /** /v1/tasks/:id/*：需要令牌且 :id == 令牌绑定的任务 */
  | "task"
  /** /v1/theses/:id/*：需要令牌且理由卡所属任务 == 令牌绑定的任务 */
  | "thesis"
  /** /v1/executor/*（执行身份） */
  | "executor";

export interface RouteRule {
  method: "GET" | "POST" | "*";
  pattern: RegExp;
  scope: RouteScope;
  /** 人读的路由模板（测试与报告用） */
  route: string;
}

const T = "([A-Za-z0-9_-]+)";
const rule = (method: RouteRule["method"], route: string, scope: RouteScope): RouteRule => {
  const pattern = new RegExp(`^${route.replace(/\//g, "\\/").replace(/:[A-Za-z]+/g, T).replace(/\*$/, ".*")}$`);
  return { method, pattern, scope, route };
};

/** agent:hosted 的白名单（顺序无关；全部精确匹配整条路径） */
export const AGENT_ROUTE_ALLOWLIST: readonly RouteRule[] = [
  // 免费端点（只读）
  rule("GET", "/healthz", "free"),
  rule("GET", "/openapi.json", "free"),
  rule("GET", "/llms.txt", "free"),
  rule("GET", "/.well-known/*", "free"),
  rule("GET", "/pub/*", "free"),
  rule("GET", "/v1/assets", "free"),
  rule("GET", "/v1/policies", "free"),
  rule("GET", "/v1/products", "free"),
  rule("GET", "/v1/playbooks", "free"),
  rule("GET", "/v1/events", "free"),
  rule("GET", "/v1/events/:id/revisions", "free"),
  rule("GET", "/v1/context", "context"),
  // 轮次队列（§2.8 /v1/agent/*）
  rule("POST", "/v1/agent/claim", "agent_open"),
  rule("POST", "/v1/agent/heartbeat", "agent_open"),
  rule("POST", "/v1/agent/runs/:runId/checkpoint", "agent_run"),
  rule("POST", "/v1/agent/runs/:runId/complete", "agent_run"),
  // §2.8 标 H 的任务路由（读）
  rule("GET", "/v1/tasks/:id/delegation", "task"),
  rule("GET", "/v1/tasks/:id/activity", "task"),
  rule("GET", "/v1/tasks/:id/timeline", "task"),
  rule("GET", "/v1/tasks/:id/runs", "task"),
  rule("GET", "/v1/tasks/:id/runs/:runId", "task"),
  rule("GET", "/v1/tasks/:id/positions", "task"),
  rule("GET", "/v1/tasks/:id/agent-context", "task"),
  rule("GET", "/v1/tasks/:id/memory", "task"),
  // 白名单工具背后的读路由（explain_task_wait → Lab）
  rule("GET", "/v1/tasks/:id/explain-wait", "task"),
  // §2.9 agent_write：意图（提交 / 撤回）、agent-status、memory、quotes、理由卡 review-items
  rule("POST", "/v1/tasks/:id/quotes", "task"),
  rule("POST", "/v1/tasks/:id/memory", "task"),
  rule("POST", "/v1/tasks/:id/intents", "task"),
  rule("POST", "/v1/tasks/:id/intents/:intentId/withdraw", "task"),
  rule("POST", "/v1/tasks/:id/agent-status", "task"),
  rule("GET", "/v1/theses/:id", "thesis"),
  rule("POST", "/v1/theses/:id/review-items", "thesis"),
];

export const EXECUTOR_ROUTE_ALLOWLIST: readonly RouteRule[] = [rule("*", "/v1/executor/*", "executor")];

export function allowlistFor(caller: ServiceCaller): readonly RouteRule[] {
  return caller === "agent:hosted" ? AGENT_ROUTE_ALLOWLIST : EXECUTOR_ROUTE_ALLOWLIST;
}

export interface RouteMatch {
  rule: RouteRule;
  /** task / thesis / agent_run 路由里的资源 id（第一个路径参数） */
  resourceId: string | null;
}

/** HEAD 视同 GET；路径按 express 的 req.path（不含 query） */
export function matchServiceRoute(caller: ServiceCaller, method: string, path: string): RouteMatch | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  for (const r of allowlistFor(caller)) {
    if (r.method !== "*" && r.method !== m) continue;
    const hit = r.pattern.exec(p);
    if (hit) return { rule: r, resourceId: hit[1] ?? null };
  }
  return null;
}

/** 服务 key 的独立限频（每分钟） */
export const SERVICE_RATE_LIMIT_PER_MIN: Record<ServiceCaller, number> = { "agent:hosted": 300, "executor:hosted": 600 };
