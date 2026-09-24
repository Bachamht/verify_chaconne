/** 薄代理（V-40）：/llms.txt → verify-service GET /pub/llms.txt（纯文本；免 key） */
import { NextResponse } from "next/server";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";

export async function GET() {
  try {
    const res = await fetch(`${SERVICE}/pub/llms.txt`, { cache: "no-store" });
    const text = await res.text();
    return new NextResponse(text, { status: res.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
  } catch {
    return new NextResponse("service_unreachable", { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

export const dynamic = "force-dynamic";
