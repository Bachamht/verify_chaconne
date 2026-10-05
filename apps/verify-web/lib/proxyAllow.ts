/**
 * 网页代理（/api/verify/*）的路径白名单与 /activity 限频。纯函数，路由与测试共用。
 *
 * v7（开发计划 §2.8 末条）：只放行标 O（代表 owner）的新路由；
 * `/v1/executor/*`（执行身份）、`/v1/agent/*`（托管 Agent）、`/v1/ops/*`（运营者）**永不**放行——
 * 网页代理带的是网站 key，放行就等于让任何浏览器冒用这些身份。测试逐条断言。
 */
const ID = "[A-Za-z0-9_]+";
const ADDR = "0x[0-9a-fA-F]{40}";

/** v6 及以前的放行名单（原样迁自 route.ts） */
const LEGACY = [
  "v1/assets",
  "v1/policies",
  "v1/products",
  "healthz",
  "v1/jobs(/[A-Za-z0-9_]+(/(report|bundle|bill))?)?",
  "v1/plans(/[A-Za-z0-9_]+(/jobs)?)?",
  "v1/mandates(/[A-Za-z0-9_]+(/(pause|resume|cancel|prepare-step|bundle|bill|steps/[0-9]+/submissions))?)?",
  "v1/simulations(/[A-Za-z0-9_]+)?",
  "v1/profiles/me",
  "v1/templates(/[A-Za-z0-9_]+)?",
  "v1/shares",
  /* v6（interfaces §11.7）：Lane B/C/D/E 端点一次放行，未部署时服务回 404，页面显示「尚未就绪」 */
  "v1/context",
  "v1/events(/[A-Za-z0-9_.:-]+/revisions)?",
  "v1/event-impacts",
  "v1/tasks(/[A-Za-z0-9_]+(/(pause|resume|cancel|authorize|prepare-step|explain-wait|compare-policies|conditions|agent-status|brief|bundle|intents(/[A-Za-z0-9_]+(/withdraw)?)?))?)?",
  "v1/theses(/[A-Za-z0-9_]+(/review-items)?)?",
  "v1/budget-groups(/[A-Za-z0-9_]+(/allocations)?)?",
  "v1/portfolio/0x[0-9a-fA-F]{40}(/cost-overrides)?",
  "v1/notify/(webhooks(/[A-Za-z0-9_]+)?|telegram/link|test)",
  "v1/replays(/[A-Za-z0-9_]+)?",
  "v1/rebalance/(preview|plans(/[A-Za-z0-9_]+)?)",
  "v1/recaps(/[A-Za-z0-9_]+(/share)?)?",
  "v1/missions",
  /* 钱包账户化：按 owner 列出该钱包的全部记录（任务 / 授权 / 规划 / 核验 / 模拟） */
  "v1/records",
  /* FIX-175：钱包签发的 Agent API key（签发 / 列出 / 吊销） */
  "v1/keys(/[A-Za-z0-9_]+)?",
  /* Lane D 的动作与覆盖端点、Lane C 的执行器端点（F 的名单漏了这三条） */
  "v1/event-impacts/actions",
  "v1/events/earnings/coverage",
  "v1/mandates/[A-Za-z0-9_]+/executor(/heartbeat)?",
];

/** v7 的 O 路由（interfaces §12.8）。`authorize`（改：body 增 itemId）已在旧名单里。 */
export const V7_OWNER_ROUTES = [
  `v1/tasks/${ID}/delegation(/refresh)?`,
  `v1/tasks/${ID}/allowances`,
  `v1/tasks/${ID}/handover`,
  `v1/tasks/${ID}/activity`,
  `v1/tasks/${ID}/timeline`,
  `v1/tasks/${ID}/runs(/${ID})?`,
  `v1/tasks/${ID}/positions`,
  `v1/tasks/${ID}/agent-context`,
  `v1/tasks/${ID}/quotes`,
  `v1/tasks/${ID}/memory`,
  `v1/tasks/${ID}/share-activity`,
  `v1/owners/${ADDR}/allowances(/(reclaim|submit))?`,
];

export const PROXY_ALLOWED = new RegExp("^(" + [...LEGACY, ...V7_OWNER_ROUTES].join("|") + ")$");

/** 这些前缀属于服务身份 / 运营者，代理永远不放行（与名单无关的第二道防线） */
const NEVER = /^v1\/(executor|agent|ops)(\/|$)/;

export function proxyAllowed(joined: string): boolean {
  if (NEVER.test(joined)) return false;
  return PROXY_ALLOWED.test(joined);
}

/** 路径里带的 owner 地址（组合与 owner 额度路由）：真实地址必须有它的登录会话（lib/proxyOwner） */
export function ownerFromPath(joined: string): string | undefined {
  return /^v1\/(?:portfolio|owners)\/(0x[0-9a-fA-F]{40})/.exec(joined)?.[1];
}

/* ---------- /activity 单列限频（每 owner 120 次 / 分钟；其它路由沿用服务侧的每调用方 60 次 / 分钟） ---------- */
export const ACTIVITY_LIMIT_PER_MIN = 120;
const ACTIVITY_PATH = new RegExp(`^v1/tasks/${ID}/activity$`);
export function isActivityPath(joined: string): boolean {
  return ACTIVITY_PATH.test(joined);
}

/** 固定窗口计数器（进程内）：key → {窗口起点, 次数} */
export function createRateLimiter(limit: number, windowMs = 60_000) {
  const buckets = new Map<string, { start: number; n: number }>();
  return {
    /** 允许 → { ok:true }；超限 → { ok:false, retryAfterS } */
    hit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
      const b = buckets.get(key);
      if (!b || now - b.start >= windowMs) {
        buckets.set(key, { start: now, n: 1 });
        if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.start >= windowMs) buckets.delete(k);
        return { ok: true };
      }
      if (b.n >= limit) return { ok: false, retryAfterS: Math.max(1, Math.ceil((b.start + windowMs - now) / 1000)) };
      b.n += 1;
      return { ok: true };
    },
  };
}
