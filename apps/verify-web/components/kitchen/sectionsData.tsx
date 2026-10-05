"use client";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { Panel } from "@/components/kit/Panel";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { AgentSays, SourceChip } from "@/components/kit/AgentSays";
import { Amount } from "@/components/kit/Amount";
import { DataTable } from "@/components/kit/DataTable";
import { EmptyState } from "@/components/kit/FourStates";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { KeyValue } from "@/components/kit/KeyValue";
import type { UiStatus } from "@/lib/status";

export function KpiSection() {
  return (
    <Panel>
      <Panel.Header eyebrow="04" title="StatTile · KpiRow · KeyValue" description="没有值显示 —，不显示 0" />
      <Panel.Body className="flex flex-col gap-4">
        <KpiRow>
          <StatTile label="已完成步数" value={<span>3 / 5</span>} hint="上次成交 2 小时前" />
          <StatTile label="已用预算" value={<Amount raw="8000000" decimals={6} symbol="USDG" maxFrac={2} />} hint="上限 13 USDG" />
          <StatTile label="参考价" value="$337.02" delta={-0.31} hint="收盘价" />
          <StatTile label="需要你" value="2" tone="warn" hint="签卖出授权" />
        </KpiRow>
        <KpiRow><StatTile label="持仓" value={null} hint="未返回" /></KpiRow>
        <KeyValue items={[
          { label: "范围", value: "AAPLx、NVDAx 买入；AAPLx 允许卖出" },
          { label: "单笔上限", value: <Amount raw="3000000" decimals={6} symbol="USDG" maxFrac={2} /> },
          { label: "有效期至", value: <Timestamp at={new Date(Date.now() + 3 * 86400_000).toISOString()} mode="abs" /> },
          { label: "交易时段", value: null, hint: "未设置时按常规时段" },
        ]} />
      </Panel.Body>
    </Panel>
  );
}

export function AgentSection() {
  return (
    <Panel>
      <Panel.Header eyebrow="05" title="AgentSays" description="品牌底 + 左线 + 来源 chip；中英混排长段落" />
      <Panel.Body className="flex flex-col gap-3">
        <AgentSays meta={<Timestamp at={new Date(Date.now() - 20 * 60_000).toISOString()} mode="rel" />} source={<><SourceChip href="#evidence">okx-dex 报价</SourceChip><SourceChip>收盘价 · 2 个来源</SourceChip></>}>
          {"AAPLx 的链上价格比收盘参考价低 0.4%，在你设的 1% 以内；FOMC 纪要还有 6 小时发布，按你的规则事件前 30 分钟暂停。所以现在买第 3 步，金额 3 USDG。\nThe on-chain price is within your deviation limit, and the next macro event is outside the pause window, so step 3 proceeds now."}
        </AgentSays>
        <AgentSays who="Agent">还在等：美股不在常规时段。</AgentSays>
      </Panel.Body>
    </Panel>
  );
}

interface Row { id: string; title: string; status: UiStatus; next: string; spentRaw: string | null; mode: "simulation" | "live"; updated: string }
const now = Date.now();
const ROWS: Row[] = [
  { id: "tsk_c7bc0d49075b80b3d83e1a8c", title: "分 5 步买入 AAPLx，财报前暂停", status: "running", next: "等美股开盘", spentRaw: "9000000", mode: "live", updated: new Date(now - 3600_000).toISOString() },
  { id: "tsk_3c52ccd03b47f5ffe727ac91", title: "NVDAx 跌 3% 时买入", status: "needs_you", next: "签卖出授权", spentRaw: "6000000", mode: "live", updated: new Date(now - 7200_000).toISOString() },
  { id: "tsk_sim0001", title: "观察：TSLAx 定投", status: "waiting", next: "下次检查 14:30", spentRaw: null, mode: "simulation", updated: new Date(now - 86400_000).toISOString() },
  { id: "tsk_done01", title: "已结束：MSFTx 三步买入", status: "done", next: "—", spentRaw: "13000000", mode: "live", updated: new Date(now - 3 * 86400_000).toISOString() },
];
const COLS: ColumnDef<Row, unknown>[] = [
  { accessorKey: "title", header: "任务", cell: ({ row }) => <Link href={`/agent/tasks/${row.original.id}`} className="font-medium text-fg-1 hover:text-brand-300">{row.original.title}</Link>, meta: { className: "w-[40%]" } },
  { accessorKey: "status", header: "状态", cell: ({ row }) => <StatusBadge status={row.original.status} /> },
  { accessorKey: "next", header: "下一步", cell: ({ row }) => <span className="text-fg-2">{row.original.next}</span> },
  { accessorKey: "spentRaw", header: "已用预算", cell: ({ row }) => <Amount raw={row.original.spentRaw} decimals={6} symbol="USDG" maxFrac={2} />, meta: { align: "right" } },
  { accessorKey: "updated", header: "更新", cell: ({ row }) => <Timestamp at={row.original.updated} mode="rel" className="text-fg-3" />, meta: { align: "right" } },
];

export function DataSection() {
  return (
    <Panel>
      <Panel.Header eyebrow="07" title="DataTable" description="sticky 表头 · 固定行高 · 数字右对齐 · 整行可点 · 手机变卡片" />
      <Panel.Body flush className="flex flex-col gap-6 pb-5">
        <DataTable columns={COLS} data={ROWS} rowHref={(r) => `/agent/tasks/${r.id}`} caption="任务列表示例" cardRow={(r) => (
          <Link href={`/agent/tasks/${r.id}`} className="flex flex-col gap-2 rounded-md border bg-surface-1 p-3">
            <span className="flex items-start justify-between gap-2"><span className="text-sm font-medium text-fg-1">{r.title}</span><StatusBadge status={r.status} /></span>
            <span className="flex justify-between text-xs text-fg-3"><span>{r.next}</span><Amount raw={r.spentRaw} decimals={6} symbol="USDG" maxFrac={2} /></span>
          </Link>
        )} />
        <div className="px-5"><DataTable columns={COLS} data={[]} empty={<EmptyState size="sm" title="还没有任务" description="先让 Agent 观察一次，再决定要不要真实运行。" />} /></div>
      </Panel.Body>
    </Panel>
  );
}
