"use client";
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SelectField } from "@/components/kit/SelectField";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Panel } from "@/components/kit/Panel";
import { FormField } from "@/components/kit/FormField";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { DetailSheet } from "@/components/kit/DetailSheet";
import { KeyValue } from "@/components/kit/KeyValue";
import { StatusBadge } from "@/components/kit/StatusBadge";

export function FormSection() {
  const [budget, setBudget] = useState("20");
  const err = Number(budget) > 13 ? "超过钱包余额 13 USDG。降低总预算，或先充值。" : undefined;
  return (
    <Panel>
      <Panel.Header eyebrow="09" title="Forms" description="label 在上 · 错误在下 · 焦点环" />
      <Panel.Body className="grid gap-4 md:grid-cols-2">
        <FormField label="总预算（USDG）" hint="Agent 最多花这么多" error={err}><Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></FormField>
        <DirectionField />
        <FormField label="策略说明" optional="（可选）" className="md:col-span-2"><Textarea rows={3} placeholder="例如：财报前一天不买，跌 3% 再买第二笔" /></FormField>
        <div className="flex items-center gap-3"><Switch id="kit-sw" defaultChecked /><Label htmlFor="kit-sw">只在常规时段交易</Label></div>
        <div className="flex items-center gap-3"><Checkbox id="kit-cb" /><Label htmlFor="kit-cb">我知道卖出可以包含钱包里原有的持仓</Label></div>
        <Tabs defaultValue="a" className="md:col-span-2">
          <TabsList><TabsTrigger value="a">诊断</TabsTrigger><TabsTrigger value="b">对照</TabsTrigger><TabsTrigger value="c">回放</TabsTrigger></TabsList>
          <TabsContent value="a" className="pt-3 text-sm text-fg-2">诊断面板内容</TabsContent>
          <TabsContent value="b" className="pt-3 text-sm text-fg-2">对照面板内容</TabsContent>
          <TabsContent value="c" className="pt-3 text-sm text-fg-2">回放面板内容</TabsContent>
        </Tabs>
      </Panel.Body>
    </Panel>
  );
}

export function OverlaySection() {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [sheet, setSheet] = useState(false);
  return (
    <Panel>
      <Panel.Header eyebrow="10" title="Overlays" description="Dialog / Sheet / Dropdown / Tooltip / Toast：surface-3 + shadow-pop" />
      <Panel.Body className="flex flex-wrap gap-3">
        <Button variant="destructive" onClick={() => setConfirm(true)}>取消任务…</Button>
        <Button variant="outline" onClick={() => setSheet(true)}>打开抽屉</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="更多"><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem>分享看板</DropdownMenuItem><DropdownMenuItem variant="destructive">删除记录</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
        <Tooltip><TooltipTrigger asChild><Button variant="ghost">悬停看说明</Button></TooltipTrigger><TooltipContent>暂停不会撤销链上额度</TooltipContent></Tooltip>
        <Button variant="ghost" onClick={() => toast.success("已复制")}>Toast</Button>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="取消这个任务？"
          consequence="取消后 Agent 不再检查和下单，已成交的不受影响。链上额度不会自动收回，需要的话去「资金」里收回。"
          confirmLabel="取消任务"
          pending={pending}
          onConfirm={() => { setPending(true); setTimeout(() => { setPending(false); setConfirm(false); toast.success("任务已取消"); }, 1200); }}
        />
        <DetailSheet open={sheet} onOpenChange={setSheet} title="分 5 步买入 AAPLx" badges={<><StatusBadge status="running" /><StatusBadge status="live" /></>} footer={<Button>打开控制台</Button>}>
          <KeyValue items={[{ label: "下一步", value: "等美股开盘" }, { label: "已用预算", value: "9 USDG" }]} />
        </DetailSheet>
      </Panel.Body>
    </Panel>
  );
}

function DirectionField() {
  const [v, setV] = useState("buy");
  return <SelectField label="方向" value={v} onChange={setV} options={[{ value: "buy", label: "只买入" }, { value: "both", label: "买入，也允许卖出" }]} hint="默认只买入" />;
}
