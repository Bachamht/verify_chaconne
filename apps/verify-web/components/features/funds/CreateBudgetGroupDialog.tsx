"use client";
/** 新建资金组（30 天周期）：表单用人类单位，按所选币种精度换成最小单位再提交（与 v7 一致）；失败在框内说明，不关框 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { FormField } from "@/components/kit/FormField";
import { budgetGroups } from "@/lib/api-v2";
import { humanToRaw } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { writeErrorText } from "../common/writeError";
import type { AssetMeta } from "./fundsModel";

/** 金额输入 → raw；小数位超过精度或非正数 → null（humanToRaw 会静默截断，先拒绝） */
export function amountToRaw(v: string, decimals: number | null, allowZero = false): string | null {
  if (decimals === null) return null;
  const s = v.trim();
  if (allowZero && /^(0+(\.0+)?)?$/.test(s)) return "0";
  if ((s.split(".")[1]?.length ?? 0) > decimals) return null;
  return humanToRaw(s, decimals);
}

export function CreateBudgetGroupDialog({ open, onOpenChange, owner, assets, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; owner: string; assets: AssetMeta[]; onCreated: (id: string) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const stables = assets.filter((a) => a.role === "stable_input");
  const [form, setForm] = useState({ name: "", asset: "", cap: "", floor: "0" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cur = stables.find((a) => a.assetKey === form.asset) ?? null;
  const dec = cur?.tokenDecimals ?? null;
  const capRaw = amountToRaw(form.cap, dec);
  const floorRaw = amountToRaw(form.floor, dec, true);
  const ready = Boolean(form.name.trim() && cur && capRaw && floorRaw !== null);

  async function create() {
    if (!ready) return;
    setPending(true);
    setError(null);
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86_400_000);
    const r = await budgetGroups.create({ owner: owner as `0x${string}`, name: form.name.trim(), inputAssetKey: form.asset, periodStart: now.toISOString(), periodEnd: end.toISOString(), capRaw: capRaw!, cashFloorRaw: floorRaw! }).catch(() => ({ status: 0, data: null }));
    setPending(false);
    if (r.status !== 201 || !r.data) {
      setError(writeErrorText(r, zh, zh ? "资金组没有创建。" : "No budget group was created."));
      return;
    }
    toast.success(zh ? "资金组已创建" : "Budget group created");
    setForm({ name: "", asset: "", cap: "", floor: "0" });
    onCreated((r.data as { id?: string; group?: { id?: string } }).id ?? (r.data as { group?: { id?: string } }).group?.id ?? "");
  }

  const symHint = cur ? (zh ? `（${cur.displaySymbol}）` : ` (${cur.displaySymbol})`) : "";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) { setError(null); onOpenChange(o); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{zh ? "新建资金组" : "New budget group"}</DialogTitle>
          <DialogDescription>{zh ? "周期 30 天。上限是服务额度，不是链上额度，也不会冻结钱包里的钱。" : "30-day period. The cap is a service budget, not an on-chain allowance, and freezes nothing in your wallet."}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <FormField label={zh ? "名称" : "Name"}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={zh ? "例如：十月定投" : "e.g. October DCA"} /></FormField>
          <FormField label={zh ? "资金币种" : "Currency"}>
            <Select value={form.asset} onValueChange={(v) => setForm({ ...form, asset: v })}>
              <SelectTrigger className="w-full"><SelectValue placeholder={zh ? "选一个稳定币" : "Pick a stablecoin"} /></SelectTrigger>
              <SelectContent>{stables.map((a) => <SelectItem key={a.assetKey} value={a.assetKey}>{a.displaySymbol}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
          <FormField label={`${zh ? "本期上限" : "Cap per period"}${symHint}`} error={form.cap !== "" && dec !== null && capRaw === null ? (zh ? "请输入正数金额，小数位不超过该币种精度。" : "Enter a positive amount within the token's precision.") : undefined}>
            <Input inputMode="decimal" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value.trim() })} placeholder="100" />
          </FormField>
          <FormField label={`${zh ? "现金下限" : "Cash floor"}${symHint}`} hint={zh ? "钱包里至少留这么多，不给任务用" : "Always keep this much in the wallet"} error={dec !== null && floorRaw === null ? (zh ? "现金下限须为 0 或正数金额。" : "The cash floor must be 0 or a positive amount.") : undefined}>
            <Input inputMode="decimal" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value.trim() })} />
          </FormField>
          {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{zh ? "先不" : "Not now"}</Button>
          <AsyncButton pending={pending} pendingLabel={zh ? "创建中…" : "Creating…"} disabled={!ready} disabledReason={zh ? "先填名称、币种和上限" : "Fill in name, currency and cap first"} onClick={() => void create()}>{zh ? "创建资金组" : "Create budget group"}</AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
