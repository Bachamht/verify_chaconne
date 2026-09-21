/** 公开战报代理：/api/pub/reports[/:shareId] → VERIFY_SERVICE_URL/pub/reports…（无 API key、无 cookie；同源便于 CSP） */
import { NextResponse, type NextRequest } from "next/server";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";
const ALLOWED = /^reports(\/[A-Za-z0-9_-]+)?$/;

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!ALLOWED.test(joined)) return NextResponse.json({ error: "not_allowed" }, { status: 404 });
  const url = new URL(req.url);
  let res: Response;
  try {
    res = await fetch(`${SERVICE}/pub/${joined}${url.search}`, { cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "service_unreachable" }, { status: 502 });
  }
  const text = await res.text();
  return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "public, max-age=30" } });
}
