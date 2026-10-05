"use client";
import { useEffect, useMemo, useState } from "react";
import type { Condition } from "@chaconne/core/verify";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import type { AssetEntry } from "@/lib/assets";
import { lab, type ReplayView } from "@/components/agent/lab/api";
import { playbookTitle } from "@/components/agent/tasks/taskTitle";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/kit/Panel";
import { FormField } from "@/components/kit/FormField";
import { SelectField } from "@/components/kit/SelectField";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ErrorState } from "@/components/kit/FourStates";
import { ModeTag } from "@/components/kit/StatusBadge";
import { actionErrorText } from "./labText";
import { ReplayResult } from "./ReplayResult";

const PLAYBOOKS = ["session_dca", "event_aware_accumulate", "discount_watch"] as const;
/** Date → datetime-local 的值（浏览器本地时区） */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 决策回放（POST /v1/replays）：每个评估点只用当时已知的数据；缺口如实显示；不是收益回测 */
export function ReplayTab({ assets, assetsFailed = false, initialAsset, initialDate }: { assets: AssetEntry[]; assetsFailed?: boolean; initialAsset: string | null; initialDate: string | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const stocks = useMemo(() => assets.filter((a) => a.role === "stock_output"), [assets]);
  const [assetKey, setAssetKey] = useState("");
  const [playbookId, setPlaybookId] = useState<string>("session_dca");
  const [afterMin, setAfterMin] = useState(20);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [step, setStep] = useState(60);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<{ status: number; data: unknown } | null>(null);
  const [d, setD] = useState<ReplayView | null>(null);

  useEffect(() => {
    const pick = (initialAsset && stocks.find((a) => a.assetKey.toLowerCase() === initialAsset.toLowerCase())) || stocks.find((a) => a.executionAllowed) || stocks[0];
    if (pick) setAssetKey((cur) => cur || pick.assetKey);
  }, [stocks, initialAsset]);
  // 默认区间挂载后再填（水合安全）：最近 3 天；链接带 ?date= 时取那一整天
  useEffect(() => {
    if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) { setFrom(`${initialDate}T00:00`); setTo(`${initialDate}T23:59`); return; }
    const now = Date.now();
    setTo(toLocalInput(now - 60_000));
    setFrom(toLocalInput(now - 3 * 86_400_000));
  }, [initialDate]);

  const items = useMemo<Condition[]>(() => (playbookId === "discount_watch"
    ? [{ type: "session", allow: ["US_REGULAR"] }, { type: "premium_bps_lte", value: 50, referenceKind: "live", liveOnlyForExecution: true }]
    : [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin, includeEstimated: true, wholeDayIfDayPrecision: true }]), [playbookId, afterMin]);
  const rangeBad = Boolean(from && to && Date.parse(from) >= Date.parse(to));

  async function run() {
    setPending(true);
    setErr(null);
    const r = await lab.replay({ playbookId, assetKey, conditions: { items }, from: new Date(from).toISOString(), to: new Date(to).toISOString(), stepMinutes: step, locale }).catch(() => ({ status: 0, data: null }));
    setPending(false);
    if (r.status === 201 && r.data) { setD(r.data as ReplayView); toast.success(zh ? "回放完成" : "Replay done"); }
    else { setD(null); setErr({ status: r.status, data: r.data }); }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel>
        <Panel.Header
          title={zh ? "当时已知的数据会让规则放行吗？" : "Would the rule have passed on what was known then?"}
          description={zh ? "每个评估点只用当时已可知的证据与事件版本，后来的修订不用。没有存档的区间显示为缺口，不补值。这不是收益回测。" : "Each point uses only evidence and event versions known at that time. Intervals without an archive show as gaps and are never filled in. This is not a returns backtest."}
          action={<ModeTag mode="REPLAY" />}
        />
        <Panel.Body className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label={zh ? "股票" : "Stock"}
            value={assetKey}
            onChange={setAssetKey}
            placeholder={assetsFailed ? (zh ? "资产登记表未返回" : "Asset registry not returned") : zh ? "加载中…" : "Loading…"}
            options={stocks.map((a) => ({ value: a.assetKey, label: `${a.displaySymbol}${a.executionAllowed ? "" : (zh ? "（未放行）" : " (not allowed)")}` }))}
          />
          <SelectField label={zh ? "规则模板" : "Rule template"} value={playbookId} onChange={setPlaybookId} options={PLAYBOOKS.map((p) => ({ value: p, label: playbookTitle(p, locale) }))} />
          <FormField label={zh ? "事件后等待（分钟）" : "Wait after event (min)"} hint={playbookId === "discount_watch" ? (zh ? "折价观察不用这一项" : "Not used by discount watch") : undefined}>
            <Input type="number" min={0} max={720} value={afterMin} disabled={playbookId === "discount_watch"} onChange={(e) => setAfterMin(Math.max(0, Math.min(720, Number(e.target.value) || 0)))} />
          </FormField>
          <FormField label={zh ? "从" : "From"}><Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label={zh ? "到" : "To"} error={rangeBad ? (zh ? "结束要晚于开始。" : "The end must be after the start.") : undefined}><Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
          <FormField label={zh ? "步长（分钟）" : "Step (min)"}><Input type="number" min={5} max={1440} value={step} onChange={(e) => setStep(Math.max(5, Math.min(1440, Number(e.target.value) || 60)))} /></FormField>
        </Panel.Body>
        <Panel.Footer>
          <AsyncButton pending={pending} pendingLabel={zh ? "正在回放…" : "Replaying…"} disabled={!assetKey || !from || !to || rangeBad} disabledReason={!assetKey ? (assetsFailed ? (zh ? "资产登记表没读到，选不了股票。" : "The asset registry did not load; no stock to pick.") : (zh ? "先选一只股票。" : "Pick a stock first.")) : !from || !to ? (zh ? "先填开始和结束时间。" : "Fill in the start and end first.") : rangeBad ? (zh ? "结束要晚于开始。" : "The end must be after the start.") : undefined} onClick={() => void run()}>
            {zh ? "开始回放" : "Run replay"}
          </AsyncButton>
        </Panel.Footer>
      </Panel>
      {err ? (
        <Panel><ErrorState size="sm" status={err.status} title={zh ? "回放没有完成" : "The replay did not finish"} description={actionErrorText(err, locale)} onRetry={() => void run()} /></Panel>
      ) : d ? <ReplayResult d={d} /> : null}
    </div>
  );
}
