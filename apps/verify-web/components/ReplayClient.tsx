"use client";
/** 事件前后回放（T-05 / V-13）：同一资产两组证据并排；数据来自 public/replay/<symbol>.json；角标 REPLAY；字段用人话标签，时间本地化。 */
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { reasonText } from "@/lib/reasons";
import { fmtLocal, rawToHuman } from "@/lib/format";
import { Card, Pill, Row } from "@/components/ui";

interface Bi { en: string; zh: string }
interface Side { observedAt: string | null; observedLabel: Bi | null; ratio: string; stockPriceUsd: string; quote: { amountInRaw: string; expectedOutRaw: string; executableUsdPerShare: string }; unitNote: Bi | string }
interface Replay { mode: string; label: string; assetKey: string; displaySymbol: string; before: Side; after: Side; reasonCodes: string[] }

const FILES: Record<string, string> = { "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a": "aaplx", aaplx: "aaplx", AAPLx: "aaplx" };

export function ReplayClient({ assetKey }: { assetKey: string }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const [d, setD] = useState<Replay | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const f = FILES[assetKey];
    if (!f) return setMissing(true);
    fetch(`/replay/${f}.json`).then((r) => (r.ok ? r.json() : null)).then((j) => (j ? setD(j as Replay) : setMissing(true)));
  }, [assetKey]);
  if (missing) return <p className="text-fg-2">{zh ? "没有这个资产的回放样本。" : "No replay sample for this asset."}</p>;
  if (!d) return <p className="text-fg-2">{t("loading")}</p>;
  const bi = (x: Bi | string) => (typeof x === "string" ? x : zh ? x.zh : x.en);
  // UI-19：After 一侧把变了的行标出来（warn 左边线 + 浅底），数值后跟差值
  const pctDelta = (a: string, b: string): string | null => {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || x === y) return null;
    const d = ((y - x) / Math.abs(x)) * 100;
    return `${d > 0 ? "+" : "\u2212"}${Math.abs(d).toFixed(2)}%`;
  };
  const side = (s: Side, title: string, other: Side | null) => {
    const cell = (label: string, val: string, rawA: string, rawB: string | null) => {
      const delta = rawB !== null ? pctDelta(rawB, rawA) : null;
      return (
        <Row
          key={label}
          k={label}
          tone={delta ? "changed" : undefined}
          mono
          v={
            delta ? (
              <span>
                {val} <span className="text-warn">{delta}</span>
              </span>
            ) : (
              val
            )
          }
        />
      );
    };
    return (
      <Card title={title} right={<Pill tone="warn">{d.label}</Pill>}>
        <Row k={t("replay_observed")} v={s.observedAt ? fmtLocal(s.observedAt, locale) : s.observedLabel ? bi(s.observedLabel) : t("replay_launch")} mono />
        {cell(t("replay_ratio"), s.ratio, s.ratio, other?.ratio ?? null)}
        {cell(t("replay_stock"), `$${s.stockPriceUsd}`, s.stockPriceUsd, other?.stockPriceUsd ?? null)}
        {cell(t("replay_in"), `${rawToHuman(s.quote.amountInRaw, 6)} USDG`, s.quote.amountInRaw, other?.quote.amountInRaw ?? null)}
        {cell(t("replay_out"), `${rawToHuman(s.quote.expectedOutRaw, 18, 8)} ${d.displaySymbol}`, s.quote.expectedOutRaw, other?.quote.expectedOutRaw ?? null)}
        {cell(t("replay_unit_price"), `$${s.quote.executableUsdPerShare}`, s.quote.executableUsdPerShare, other?.quote.executableUsdPerShare ?? null)}
        <p className="mt-2 text-xs text-fg-2">{bi(s.unitNote)}</p>
        {other && <p className="mt-2 text-[11px] text-fg-3">{zh ? "左边线 = 与事件前相比变了的行" : "Left bar = rows that changed vs. before"}</p>}
      </Card>
    );
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("replay_h")} · {d.displaySymbol}</h1>
        <Pill tone="warn">{d.mode}</Pill>
      </div>
      <p className="text-sm text-neutral-300">{t("replay_p")}</p>
      <p className="text-xs text-fg-3">{t("replay_note_constructed")}</p>
      <div className="grid gap-4 md:grid-cols-2">
        {side(d.before, zh ? "事件前" : "Before", null)}
        {side(d.after, zh ? "事件后" : "After", d.before)}
      </div>
      <Card title={t("reasons")}>
        <ul className="space-y-1 text-sm">{d.reasonCodes.map((c) => <li key={c}><Pill tone="warn">{c}</Pill> {reasonText(c, locale)}</li>)}</ul>
        <p className="mt-3 text-sm text-neutral-200">{t("replay_takeaway")}</p>
      </Card>
    </div>
  );
}
