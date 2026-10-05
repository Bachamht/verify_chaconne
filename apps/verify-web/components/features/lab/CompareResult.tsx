"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { formatAbs } from "@/lib/numbers";
import { taskUiStatus } from "@/lib/status";
import { lab, type CompareView } from "@/components/agent/lab/api";
import { bothWaitingForOpen } from "@/components/agent/lab/compareHints";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { DataTable, type ColumnDef } from "@/components/kit/DataTable";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { StatusBadge, ToneTag } from "@/components/kit/StatusBadge";
import { blockerText } from "@/components/kit/Blockers";
import { actionErrorText, compareRows, diffLabel, type CompareRow } from "./labText";
import { SnapshotLine } from "./SnapshotLine";

/** 对照结果：提示（两套都在等开盘）→ 证据快照一行摘要 → 四列表（字段 / A / B / 差异）→ 用某一套建一个模拟 */
export function CompareResult({ d }: { d: CompareView }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [la, lb] = [d.outcomeDiff?.[0]?.label ?? "A", d.outcomeDiff?.[1]?.label ?? "B"];
  const rows = useMemo(() => compareRows(d, locale, (iso) => formatAbs(new Date(iso), locale), (c) => blockerText({ code: c }, locale)), [d, locale]);
  const cols = useMemo<ColumnDef<CompareRow, unknown>[]>(() => {
    const cell = (v: string) => <span className="block truncate" title={v}>{v}</span>;
    return [
      { accessorKey: "field", header: zh ? "字段" : "Field", cell: ({ row }) => <span className="font-medium text-fg-1">{row.original.field}</span>, meta: { className: "w-[22%]" } },
      { accessorKey: "a", header: `A · ${la}`, cell: ({ row }) => (row.original.aTone ? <ToneTag tone={row.original.aTone}>{row.original.a}</ToneTag> : cell(row.original.a)) },
      { accessorKey: "b", header: `B · ${lb}`, cell: ({ row }) => (row.original.bTone ? <ToneTag tone={row.original.bTone}>{row.original.b}</ToneTag> : cell(row.original.b)) },
      { id: "diff", header: zh ? "差异" : "Difference", cell: ({ row }) => { const m = diffLabel(row.original.diff, locale); return <ToneTag tone={m.tone}>{m.label}</ToneTag>; }, meta: { className: "w-24" } },
    ];
  }, [zh, la, lb, locale]);

  const [pending, setPending] = useState(false);
  const [simId, setSimId] = useState<string | null>(null);
  async function remix() {
    if (!d.remix?.simulationBody) return;
    setPending(true);
    const r = await lab.simulate(d.remix.simulationBody).catch(() => ({ status: 0, data: null }));
    setPending(false);
    if (r.status === 201 && r.data) { setSimId(r.data.simulationId); toast.success(zh ? "模拟已创建" : "Simulation created"); }
    else toast.error(zh ? "模拟没有创建" : "Simulation was not created", { description: actionErrorText(r, locale) });
  }

  return (
    <Panel>
      <Panel.Header title={zh ? "对照结果" : "Comparison"} description={zh ? (d.note?.zh ?? undefined) : (d.note?.en ?? undefined)} />
      <Panel.Body className="flex flex-col gap-4">
        {bothWaitingForOpen(d.outcomeDiff) ? (
          <Panel as="div" tone="warn"><Panel.Body className="py-3 text-sm text-fg-1">{zh ? "现在两套都在等开盘（美股不在常规时段）；开盘后再对照，差异才有意义。" : "Both are waiting for the open (US market outside regular hours); the difference only means something once it opens."}</Panel.Body></Panel>
        ) : null}
        <SnapshotLine s={d.snapshot} />
        {d.task ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
            {zh ? "真实任务" : "Real task"} <StatusBadge status={taskUiStatus(d.task.status)} />
            <span>{zh ? "条件没改，也没写任何授权。" : "Conditions untouched; no authorization written."}</span>
          </p>
        ) : null}
        <DataTable columns={cols} data={rows} getRowId={(r) => r.key} caption={zh ? "两套规则逐项对照" : "Item-by-item comparison"} cardRow={(r) => (
          <div className="flex flex-col gap-1.5 rounded-md border bg-surface-1 p-3 text-sm">
            <span className="flex items-center justify-between gap-2"><span className="font-medium text-fg-1">{r.field}</span><ToneTag tone={diffLabel(r.diff, locale).tone}>{diffLabel(r.diff, locale).label}</ToneTag></span>
            <span className="break-words text-fg-2"><span className="text-fg-3">A · </span>{r.a}</span>
            <span className="break-words text-fg-2"><span className="text-fg-3">B · </span>{r.b}</span>
          </div>
        )} />
      </Panel.Body>
      <Panel.Footer>
        <AsyncButton variant="outline" size="sm" pending={pending} pendingLabel={zh ? "正在创建…" : "Creating…"} disabled={!d.remix?.simulationBody} disabledReason={zh ? "这次对照没有给出可复用的模拟。" : "This comparison returned nothing to simulate."} onClick={() => void remix()}>
          {zh ? `用 ${d.remix?.variantLabel ?? "A"} 建一个模拟` : `Create a simulation from ${d.remix?.variantLabel ?? "A"}`}
        </AsyncButton>
        {simId ? <Button asChild variant="link" size="sm"><Link href={`/play?simulation=${simId}`}>{zh ? "查看模拟" : "View simulation"}</Link></Button> : null}
      </Panel.Footer>
    </Panel>
  );
}
