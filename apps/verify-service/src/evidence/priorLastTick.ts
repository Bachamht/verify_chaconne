/**
 * C2 接库（W5 / CV-D06）：为 LiveEvidenceProvider 提供"已记录的 last_tick 收盘"，供次日 previousClose 确认。
 * 查 verify_evidence（任务证据）与 verify_mandate_evaluations.evidence_json（授权计划评估证据）里 kind=ref_close、closeSource=last_tick 的记录。
 */
import { desc, sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyEvidence, verifyMandateEvaluations } from "@chaconne/db";
import type { EvidenceRecord } from "@chaconne/core/verify";

export function priorLastTickFromDb(db: Db): (underlyingId: string, tradingDate: string) => Promise<string | null> {
  return async (underlyingId, tradingDate) => {
    const rows = await db
      .select({ record: verifyEvidence.record })
      .from(verifyEvidence)
      .where(sql`${verifyEvidence.record} -> 'payload' ->> 'kind' = 'ref_close' AND ${verifyEvidence.record} -> 'payload' ->> 'closeSource' = 'last_tick' AND ${verifyEvidence.record} -> 'payload' ->> 'underlyingId' = ${underlyingId} AND ${verifyEvidence.record} -> 'payload' ->> 'tradingDate' = ${tradingDate}`)
      .orderBy(desc(verifyEvidence.createdAt))
      .limit(1);
    const r = rows[0]?.record as EvidenceRecord | undefined;
    if (r && r.payload.kind === "ref_close") return r.payload.closeUsd;
    const evals = await db.select({ evidenceJson: verifyMandateEvaluations.evidenceJson }).from(verifyMandateEvaluations).where(sql`${verifyMandateEvaluations.evidenceJson} @> ${JSON.stringify([{ payload: { kind: "ref_close", closeSource: "last_tick", underlyingId, tradingDate } }])}::jsonb`).orderBy(desc(verifyMandateEvaluations.evaluatedAt)).limit(1);
    const list = (evals[0]?.evidenceJson as EvidenceRecord[] | undefined) ?? [];
    const hit = list.find((e) => e.payload.kind === "ref_close" && e.payload.closeSource === "last_tick" && e.payload.underlyingId === underlyingId && e.payload.tradingDate === tradingDate);
    return hit && hit.payload.kind === "ref_close" ? hit.payload.closeUsd : null;
  };
}
