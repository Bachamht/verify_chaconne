/**
 * 服务端代理：/api/verify/<path> → VERIFY_SERVICE_URL/<path>
 * - 注入 x-api-key（浏览器永远拿不到）；
 * - x-verify-caller = 任务 owner 地址（创建时取 body.ownerAddress 并写 cookie；之后读 cookie）；
 * - 透传 x402 头（PAYMENT-SIGNATURE / PAYMENT-REQUIRED / PAYMENT-RESPONSE）。
 */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

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
    ].join("|") +
    ")$",
);
/** 这些 POST 的 body 带 ownerAddress（或已签 mandate 的 owner）→ 写 owner cookie（按钱包隔离任务） */
const OWNER_SETTERS = new Set(["v1/jobs", "v1/plans", "v1/simulations", "v1/mandates", "v1/profiles/me"]);
const COOKIE = "verify_owner";

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!ALLOWED.test(joined)) return NextResponse.json({ error: "not_allowed" }, { status: 404 });
  const url = new URL(req.url);
  const target = `${SERVICE}/${joined}${url.search}`;

  const jar = await cookies();
  let owner = jar.get(COOKIE)?.value ?? "";
  let bodyText: string | undefined;
  if (req.method === "POST" || req.method === "PUT") {
    bodyText = await req.text();
    if (OWNER_SETTERS.has(joined)) {
      try {
        const b = JSON.parse(bodyText || "{}") as { ownerAddress?: string; goal?: { ownerAddress?: string }; typedData?: { message?: { owner?: string } } };
        const cand = b.ownerAddress ?? b.goal?.ownerAddress ?? b.typedData?.message?.owner;
        if (typeof cand === "string" && /^0x[0-9a-fA-F]{40}$/.test(cand)) owner = cand.toLowerCase();
      } catch {
        /* 交给服务校验 */
      }
    }
  }
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
  if (OWNER_SETTERS.has(joined) && res.status < 300 && owner) {
    out.cookies.set(COOKIE, owner, { httpOnly: true, sameSite: "lax", secure: process.env["NODE_ENV"] === "production", path: "/", maxAge: 60 * 60 * 24 * 30 });
  }
  return out;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const dynamic = "force-dynamic";
