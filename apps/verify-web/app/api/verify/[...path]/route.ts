/**
 * 服务端代理：/api/verify/<path> → VERIFY_SERVICE_URL/<path>
 * - 注入 x-api-key（浏览器永远拿不到）；
 * - x-verify-caller = 任务 owner 地址：必须是钱包登录会话里的地址（FIX-175，/api/session）；请求里写别的真实地址 → 401 wallet_signin_required，
 *   浏览器端 api() 自动弹登录签名再重试；占位地址（无钱包模拟）免登录，只有它还经 cookie 记住（规则见 lib/proxyOwner.ts）；
 * - 透传 x402 头（PAYMENT-SIGNATURE / PAYMENT-REQUIRED / PAYMENT-RESPONSE）。
 */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ownerFromBody, resolveCaller } from "@/lib/proxyOwner";
import { SESSION_COOKIE, sessionAddress, sessionSecret } from "@/lib/sessionToken";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";
const KEY = process.env["VERIFY_WEB_API_KEY"] ?? "";
const ALLOWED = new RegExp(
  "^(" +
    [
      "v1/assets",
      "v1/policies",
      "v1/products",
      "healthz",
      "v1/jobs(/[A-Za-z0-9_]+(/(report|prepare-execution|submissions|bundle|bill))?)?",
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
    ].join("|") +
    ")$",
);
/** 这些 POST 的 body 带 ownerAddress（或已签 mandate 的 owner）→ 写 owner cookie（按钱包隔离任务） */
const OWNER_SETTERS = new Set(["v1/jobs", "v1/plans", "v1/simulations", "v1/mandates", "v1/profiles/me", "v1/tasks", "v1/budget-groups", "v1/theses"]);
const COOKIE = "verify_owner";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!ALLOWED.test(joined)) return NextResponse.json({ error: "not_allowed" }, { status: 404 });
  const url = new URL(req.url);
  const target = `${SERVICE}/${joined}${url.search}`;

  const jar = await cookies();
  let bodyText: string | undefined;
  if (req.method === "POST" || req.method === "PUT") bodyText = await req.text();
  const secret = sessionSecret();
  const { caller: owner, persist, denied } = resolveCaller({
    sessionOwner: secret ? sessionAddress(jar.get(SESSION_COOKIE)?.value, secret, Date.now()) : null,
    cookieOwner: jar.get(COOKIE)?.value,
    queryOwner: url.searchParams.get("owner"),
    pathOwner: /^v1\/portfolio\/(0x[0-9a-fA-F]{40})/.exec(joined)?.[1],
    bodyOwner: bodyText !== undefined ? ownerFromBody(bodyText) : null,
  }, { ownerSetter: OWNER_SETTERS.has(joined) });
  if (denied) return NextResponse.json({ error: "wallet_signin_required", address: denied, message: "Sign in with this wallet first (one signature, no transaction)." }, { status: 401, headers: { "cache-control": "private, no-store" } });
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": KEY };
  if (owner) headers["x-verify-caller"] = owner;
  const ps = req.headers.get("payment-signature");
  if (ps) headers["payment-signature"] = ps;

  let res: Response;
  try {
    res = await fetch(target, { method: req.method, headers, body: bodyText, cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "service_unreachable" }, { status: 502 });
  }
  const text = await res.text();
  const out = new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "private, no-store" } });
  for (const h of ["payment-required", "payment-response"]) {
    const v = res.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  if (persist && res.status < 300) {
    out.cookies.set(COOKIE, persist, { httpOnly: true, sameSite: "lax", secure: process.env["NODE_ENV"] === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  }
  return out;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const dynamic = "force-dynamic";
