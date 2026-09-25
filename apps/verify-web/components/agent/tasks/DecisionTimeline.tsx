"use client";
/**
 * 决策时间线（CV-D16 批次 5）：当前轮次 → 每条意图（agent 为什么、依据分「我们核验的 / agent 提供的 / 不采信」、四道核验、计划偏离）→ 时间线。
 * 只对有授权范围的任务显示；没有意图也显示轮次与「怎么接入」提示。
 */
import { useI18n } from "@/lib/i18n";
import type { AgentTradeIntent, AgentTurn, TaskTimelineEntry } from "@/lib/api-v2";
import { formatAmount, formatTime } from "@/lib/format";
import { reasonText } from "@/lib/reasons";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { Card, Pill } from "@/components/ui";
import { EXPLORER, short } from "@/lib/wallet";
import { bucketLabel, checkLabel, claimLines, decisionEntries, entryLabel, intentStatusLabel, turnReasonLabel, turnStateLabel } from "./decisionTimelineLabels";

const TURN_TONE: Record<AgentTurn["state"], "ok" | "warn" | "info" | "neutral" | "bad"> = { awaiting_agent: "info", intent_received: "ok", accepted: "info", declined: "neutral", needs_evidence: "warn", plan_revised: "info", ended: "neutral", no_response: "warn" };
const INTENT_TONE: Record<AgentTradeIntent["status"], "ok" | "warn" | "info" | "neutral" | "bad"> = { certified: "ok", simulated: "info", rejected: "bad", withdrawn: "neutral", expired: "neutral" };

export function DecisionTimeline({ turn, intents, timeline, assets, stable, trustTier, issuance, txByRef = {} }: { turn: AgentTurn | null; intents: AgentTradeIntent[] | null; timeline: TaskTimelineEntry[] | undefined; assets: AssetEntry[]; stable: AssetEntry | null | undefined; trustTier: string; issuance: string; /** `${mandateId}:${stepIndex}` → 交易哈希：step_confirmed 条目直接给区块浏览器链接 */ txByRef?: Record<string, string> }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const entries = decisionEntries(timeline);
  const dec = stable?.tokenDecimals ?? 6;
  const tierText = trustTier === "platform_only" ? (zh ? "只信我们核验过的事实" : "only facts we verified") : trustTier === "agent_data" ? (zh ? "也接受 agent 带来源的数据（未核验）" : "also agent-sourced data (unverified)") : (zh ? "也接受 agent 的研究结论（未核验）" : "also the agent's research (unverified)");
  return (
    <Card title={zh ? "决策时间线" : "Decision timeline"}>
      <p className="ag-note mb-2">{zh ? `信任档位：${tierText}` : `Trust tier: ${tierText}`}</p>
      {turn ? (
        <div className="rounded-md border border-line p-3 text-sm">
          <div className="ag-actions"><Pill tone={TURN_TONE[turn.state]}>{turnStateLabel(turn.state, locale)}</Pill><span className="text-fg-2">{zh ? "第" : "turn"} {turn.version} {zh ? "轮" : ""} · {turnReasonLabel(turn.reason, locale)}</span></div>
          <p className="mt-1">{turn.summary}</p>
          <p className="ag-note">{zh ? "叫醒于" : "requested"} {formatTime(turn.requestedAt, locale)} · {turn.state === "awaiting_agent" ? `${zh ? "请在" : "respond by"} ${formatTime(turn.respondBy, locale)} ${zh ? "前回应" : ""}` : turn.respondedAt ? `${zh ? "回应于" : "responded"} ${formatTime(turn.respondedAt, locale)}` : ""}</p>
          {turn.response && <p className="mt-1 text-fg-2">{turn.response.note}{turn.response.requestedEvidence?.length ? ` · ${zh ? "想看" : "wants"}: ${turn.response.requestedEvidence.join("; ")}` : ""}</p>}
        </div>
      ) : (
        <p className="ag-note">{issuance === "agent" ? (zh ? "授权后，条件一清空就会叫醒 agent；这里会显示每一轮。" : "Once authorized, the agent is woken as soon as conditions clear; each turn shows here.") : (zh ? "这个任务由平台按计划签发；agent 仍可随时提交交易意图，会记录在这里。" : "This task issues by plan; the agent may still submit trade intents, which are recorded here.")}</p>
      )}
      {intents && intents.length > 0 && (
        <ul className="mt-3 space-y-3">
          {intents.map((it) => {
            const out = assetByKey(assets, it.outputAssetKey);
            const lines = claimLines(it);
            return (
              <li key={it.id} className="rounded-md border border-line p-3 text-sm">
                <div className="ag-actions">
                  <Pill tone={INTENT_TONE[it.status]}>{intentStatusLabel(it.status, locale)}</Pill>
                  <strong>{it.kind === "sell" ? (zh ? "卖出" : "Sell") : (zh ? "买入" : "Buy")} {out?.displaySymbol ?? it.outputAssetKey.slice(-6)} · {formatAmount(it.amountInRaw, dec, stable?.displaySymbol)}</strong>
                  <span className="mono text-xs text-fg-3">{formatTime(it.createdAt, locale)}</span>
                  {it.step && <span className="text-xs text-fg-2">{zh ? "步骤" : "step"} {it.step.stepIndex}</span>}
                  {it.decision.revisionOf && <span className="text-xs text-fg-3">{zh ? "修订自" : "revises"} {it.decision.revisionOf.slice(0, 12)}…</span>}
                </div>
                <p className="mt-1"><span className="text-fg-3">{zh ? "agent 说：" : "agent: "}</span>{it.decision.rationale}</p>
                {lines.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {lines.map((l, i) => <li key={i}><Pill tone={l.bucket === "verified" ? "ok" : l.bucket === "agent" ? "warn" : "bad"}>{bucketLabel(l.bucket, locale)}</Pill> {l.text}{l.source ? <span className="text-fg-3"> · {l.source}</span> : null}</li>)}
                  </ul>
                )}
                <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                  {it.checks.map((c) => (
                    <li key={c.id}><Pill tone={c.ok ? "ok" : "bad"}>{c.ok ? "✓" : "✗"} {checkLabel(c.id, locale)}</Pill>{!c.ok && c.reasons.length > 0 && <span className="ml-1 text-fg-2">{[...new Set(c.reasons.map((r) => r.code))].slice(0, 3).map((code) => reasonText(code, locale)).join("；")}</span>}{!c.ok && c.reasons.length === 0 && typeof c.detail["skipped"] === "string" && <span className="ml-1 text-fg-3">{zh ? "未执行（前一道未过）" : "skipped (earlier check failed)"}</span>}</li>
                  ))}
                </ul>
                {it.planDeviations.length > 0 && <p className="ag-note mt-1">{zh ? "偏离计划（不阻塞，只记录）：" : "Plan deviations (recorded, not blocking): "}{[...new Set(it.planDeviations.map((r) => r.code))].map((code) => reasonText(code, locale)).join("；")}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {entries.length > 0 && (
        <ol className="mt-3 space-y-1 border-t border-line pt-2 text-xs">
          {entries.slice(-30).map((e, i) => <li key={i}><span className="mono text-fg-3">{formatTime(e.at, locale)}</span> · <strong>{entryLabel(e.type, locale)}</strong>{e.note ? <span className="text-fg-2"> · {e.note.length > 160 ? `${e.note.slice(0, 160)}…` : e.note}</span> : null}{e.ref && txByRef[e.ref] ? <> · <a className="mono underline" href={`${EXPLORER}/tx/${txByRef[e.ref]}`} target="_blank" rel="noreferrer">{short(txByRef[e.ref]!)} ↗</a></> : null}</li>)}
        </ol>
      )}
      <p className="ag-note mt-2">{zh ? "决策记录只被分类和存档，从不放宽任何一道核验；签证书不等于发交易，执行仍由 agent 或你的钱包完成。" : "The decision record is classified and archived; it never relaxes a check. A certificate is not a transaction: execution is still done by the agent or your wallet."}</p>
    </Card>
  );
}
