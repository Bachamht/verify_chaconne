/**
 * Lane D 专用代理：/agent/events/api/<path> → VERIFY_SERVICE_URL/<path>（与 /api/verify 同一机制，只放行事件台用到的路径）。
 * - API key 只在服务端；x-verify-caller = verify_owner cookie（既有流程写入），没有 cookie 时用页面给的 owner（只读事件台；
 *   写动作仍由 verify-service 按 owner 校验——地址绑定调用方只能操作自己的任务）
 * - 不透传任何支付头；不设置 cookie
 */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";
const KEY = process.env["VERIFY_WEB_API_KEY"] ?? "";
const ALLOWED = /^(v1\/event-impacts(\/actions)?|v1\/events\/earnings\/coverage|v1\/tasks)$/;

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!ALLOWED.test(joined)) return NextResponse.json({ error: "not_allowed" }, { status: 404 });
  const url = new URL(req.url);
  const target = `${SERVICE}/${joined}${url.search}`;
  const jar = await cookies();
  let owner = jar.get("verify_owner")?.value ?? "";
  let bodyText: string | undefined;
  if (req.method === "POST") {
    bodyText = await req.text();
    if (!owner) {
      try {
        const b = JSON.parse(bodyText || "{}") as { owner?: string; ownerAddress?: string };
        const cand = b.owner ?? b.ownerAddress;
        if (typeof cand === "string" && /^0x[0-9a-fA-F]{40}$/.test(cand)) owner = cand.toLowerCase();
      } catch {
        /* 交给服务校验 */
      }
    }
  } else if (!owner) {
    const q = url.searchParams.get("owner") ?? "";
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) owner = q.toLowerCase();
  }
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": KEY };
  if (owner) headers["x-verify-caller"] = owner;
  let res: Response;
  try {
    res = await fetch(target, { method: req.method, headers, body: bodyText, cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "service_unreachable" }, { status: 502 });
  }
  const text = await res.text();
  return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "private, no-store" } });
}

export const GET = proxy;
export const POST = proxy;
export const dynamic = "force-dynamic";
