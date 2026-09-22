/** OG 图（next/og）：服务端直连 verify-service 公开端点，隐私过滤后的三层信息。 */
import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

import { normalizePublicReport } from "@/lib/api-v2";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "http://127.0.0.1:8790";
const COLORS: Record<string, string> = { completed: "#22c55e", partial: "#f59e0b", waiting: "#a3a3a3", rejected: "#f04e5e", simulation: "#8b5cf6" };

export default async function Image({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  let r: { status?: string; headline?: { en: string } | null; goal?: { side: string; outputSymbols: string[]; inputSymbol: string; policyId: string; amountDisplay: string | null }; result?: { completionBps: number | null; feesDisplay: string | null }; evidence?: { reportHash: string | null }; evidenceMode?: string; persona?: { name: string } | null } = {};
  try {
    const res = await fetch(`${SERVICE}/pub/reports/${shareId}`, { cache: "no-store" });
    if (res.ok) r = (normalizePublicReport(await res.json()) ?? {}) as typeof r;
  } catch {
    /* 私密或不可达：渲染通用图 */
  }
  const status = r.status ?? "waiting";
  const color = COLORS[status] ?? "#a3a3a3";
  const goal = r.goal ? `${r.goal.side} ${r.goal.outputSymbols.join(" + ")} with ${r.goal.inputSymbol}${r.goal.amountDisplay ? ` · ${r.goal.amountDisplay}` : ""} · ${r.goal.policyId}` : "Chaconne Verify battle report";
  const meta = [
    r.result?.completionBps !== null && r.result?.completionBps !== undefined ? `completion ${(r.result.completionBps / 100).toFixed(0)}%` : null,
    r.result?.feesDisplay ? `fees ${r.result.feesDisplay}` : null,
    r.persona?.name ? `agent ${r.persona.name}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = r.headline?.en ?? (status === "rejected" ? "Rejected — the correct answer today." : status === "simulation" ? "A rehearsal on real data, nothing moved." : "Verified before it moved.");
  const footLeft = r.evidence?.reportHash ? `reportHash ${r.evidence.reportHash.slice(0, 18)}…` : "evidence-hashed · verify at verify.chaconne.xyz/verify-bundle";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 56, background: "#0a0a0a", color: "#f5f5f5", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", width: 28, height: 28, borderRadius: 8, background: "#8b5cf6" }} />
          <div style={{ display: "flex", fontSize: 28, fontWeight: 700 }}>Chaconne Agent</div>
          <div style={{ display: "flex", marginLeft: "auto", fontSize: 22, padding: "6px 14px", border: `2px solid ${color}`, borderRadius: 10, color }}>{status.toUpperCase()}</div>
          <div style={{ display: "flex", fontSize: 22, padding: "6px 14px", border: "2px solid #444", borderRadius: 10, color: "#ccc" }}>{r.evidenceMode ?? "—"}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", fontSize: 54, fontWeight: 700, lineHeight: 1.15 }}>{title}</div>
          <div style={{ display: "flex", fontSize: 28, color: "#d4d4d4" }}>{goal}</div>
          <div style={{ display: "flex", fontSize: 24, color: "#a3a3a3" }}>{meta}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, color: "#737373" }}>
          <div style={{ display: "flex" }}>{footLeft}</div>
          <div style={{ display: "flex" }}>OKX Dev Day 2026 · X Layer</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
