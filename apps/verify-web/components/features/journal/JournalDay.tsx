"use client";
import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import type { RecapView } from "@/lib/api-v2";
import type { AssetEntry } from "@/lib/assets";
import { evidenceMode } from "@/lib/status";
import { Panel } from "@/components/kit/Panel";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { Amount } from "@/components/kit/Amount";
import { ModeTag, ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { buildReceipts, dayText, fillCounts } from "./receipts";
import { ReceiptList } from "./ReceiptList";
import { Decisions } from "./Decisions";
import { JournalExtras } from "./JournalExtras";
import { ShareDialog } from "./ShareDialog";

/** 一天的日志：概况行（模式 / 生成时刻 / 分享）→ 数据源提示 → KPI → 需要你决定 → 回执 → 里程碑与可复用结构 */
export function JournalDay({ r, assets, titles, live }: { r: RecapView; assets: AssetEntry[]; titles: Map<string, string>; live: ReadonlyMap<string, string> | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const stable = assets.find((a) => a.role === "stable_input")?.assetKey ?? null;
  const receipts = useMemo(() => buildReceipts(r, { locale, assets, stableAssetKey: stable }), [r, locale, assets, stable]);
  const a = r.agent;
  const fc = fillCounts(receipts, a?.fills ?? []);
  const rounds = a?.runs?.total;
  const down = (["tasks", "mandates", "events"] as const).filter((k) => r.coverage?.[k] !== "ok");
  const srcName = { tasks: zh ? "任务" : "tasks", mandates: zh ? "授权" : "authorizations", events: zh ? "事件" : "events" };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-2">
        <span className="font-medium text-fg-1 tabular-nums">{dayText(r.date, locale)}</span>
        {r.modes.map((m) => { const em = evidenceMode(m); return em ? <ModeTag key={m} mode={em} /> : null; })}
        {r.earlyClose ? <ToneTag tone="warn">{zh ? "提前收盘" : "Early close"}</ToneTag> : null}
        <span className="text-xs text-fg-3">{zh ? "生成于 " : "Generated "}<Timestamp at={r.generatedAt} mode="both" /></span>
        <span className="ml-auto"><ShareDialog key={r.id} recap={r} /></span>
      </div>
      {down.length > 0 ? (
        <Panel tone="warn">
          <Panel.Body className="pt-4 text-sm text-fg-1">
            {zh
              ? `这份日志没拿到「${down.map((k) => srcName[k]).join("、")}」数据：下面为 0 的部分不代表什么都没发生。生成之后新建的任务也不在里面，可以点「重新生成」。`
              : `This journal did not receive ${down.map((k) => srcName[k]).join(", ")}: a zero below does not mean nothing happened. Tasks created after generation are not included either; use Regenerate.`}
          </Panel.Body>
        </Panel>
      ) : null}
      <KpiRow>
        <StatTile label={zh ? "Agent 分析轮次" : "Agent rounds"} value={a && typeof rounds === "number" ? String(rounds) : null} hint={!a ? (zh ? "这份日志没有 Agent 段" : "No agent section in this journal") : typeof rounds !== "number" ? (zh ? "轮次未返回" : "Rounds not returned") : undefined} />
        <StatTile label={zh ? "链上成交" : "On-chain fills"} value={String(fc.total)} hint={(zh ? `买 ${fc.buy} · 卖 ${fc.sell}` : `${fc.buy} buy · ${fc.sell} sell`) + (fc.legacy ? (zh ? ` · 早期授权计划 ${fc.legacy}` : ` · ${fc.legacy} from earlier plans`) : "")} />
        <StatTile label={zh ? "模型成本" : "Model cost"} value={a ? <Amount raw={a.cost?.totalUsdMicros ?? null} decimals={6} prefix="$" maxFrac={2} minFrac={2} /> : null} hint={zh ? "当天全部 Agent 轮次" : "All agent rounds that day"} />
        <StatTile label={zh ? "需要你决定" : "Needs your decision"} value={String(r.sections.decisions.length)} tone={r.sections.decisions.length > 0 ? "warn" : "default"} />
      </KpiRow>
      <Decisions items={r.sections.decisions} titles={titles} live={live} />
      <ReceiptList receipts={receipts} titles={titles} hasAgent={Boolean(a)} />
      <JournalExtras r={r} assets={assets} />
    </div>
  );
}
