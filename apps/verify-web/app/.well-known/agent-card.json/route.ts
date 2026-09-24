/** 薄代理（V-40）：/.well-known/agent-card.json → verify-service GET /pub/agent-card.json（免 key） */
import { NextResponse } from "next/server";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";

export async function GET() {
  try {
    const res = await fetch(`${SERVICE}/pub/agent-card.json`, { cache: "no-store" });
    const text = await res.text();
    return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
  } catch {
    return NextResponse.json({ error: "service_unreachable" }, { status: 502 });
  }
}

export const dynamic = "force-dynamic";
