"use client";
/**
 * 「收回额度」二次确认：这是链上授权变更，确认框写清后果，并和暂停 / 取消 / 链上撤销区分开。
 * 两种方式（与 v7 一致，逻辑复用 components/agent/funds/allowanceActions）：签名收回多余部分（平台代付）/ 自己发交易清零（你付 gas）。
 */
import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Amount } from "@/components/kit/Amount";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { KeyValue } from "@/components/kit/KeyValue";
import { approveZero, approveZeroAvailable, reclaimExcess, type AllowanceActionOutcome } from "@/components/agent/funds/allowanceActions";
import { useI18n } from "@/lib/i18n";
import { writeErrorText } from "../common/writeError";
import type { AssetRow } from "./fundsModel";

type Method = "sign" | "zero";

export function reclaimConsequence(method: Method, symbol: string, zh: boolean): string {
  if (method === "sign") {
    return zh
      ? `你会签一份新的额度签名，把给 PlanGuard 的 ${symbol} 链上额度设回仍需要的量，平台代付上链。签名不是交易，你不付 gas。`
      : `You sign a new allowance that sets the ${symbol} allowance to PlanGuard back to what is still needed; the platform pays to put it on-chain. A signature is not a transaction; you pay no gas.`;
  }
  return zh
    ? `你的钱包会发一笔交易，把给 PlanGuard 的 ${symbol} 额度直接清零，你付 gas。仍在进行的任务之后要重新签额度才能继续。`
    : `Your wallet sends a transaction that sets the ${symbol} allowance to PlanGuard to zero; you pay gas. Active tasks need a new allowance before they can continue.`;
}

export function ReclaimDialog({ row, owner, onOpenChange, onDone }: { row: AssetRow | null; owner: string; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [method, setMethod] = useState<Method>("sign");
  const [pending, setPending] = useState(false);
  const zeroOk = approveZeroAvailable();
  const pg = row?.planGuard ?? null;

  function report(o: AllowanceActionOutcome) {
    const none = zh ? "还没有签名，链上额度没有变化。" : "Nothing was signed; the on-chain allowance is unchanged.";
    if (o.kind === "ok") {
      toast.success(method === "sign" ? (zh ? "已提交，等待上链。" : "Submitted; waiting for on-chain confirmation.") : (zh ? "额度已清零" : "Allowance set to zero"));
      onOpenChange(false);
      onDone();
    } else if (o.kind === "rejected") toast.warning(zh ? "你在钱包里取消了，链上额度没有变化。" : "You cancelled in the wallet; the allowance is unchanged.");
    else if (o.kind === "api") toast.error(zh ? "没能收回额度" : "Could not reclaim the allowance", { description: writeErrorText(o.res, zh, none) });
    else if (o.kind === "unreachable") toast.error(zh ? "提交没有回应" : "No response to the submission", { description: zh ? "签名可能已送出，刷新后看额度是否变化，不要重复签。" : "The signature may have been sent. Refresh to check the allowance before signing again." });
    else toast.error(zh ? "没能收回额度" : "Could not reclaim the allowance", { description: o.message });
  }

  async function confirm() {
    if (!row?.token || !pg) return;
    setPending(true);
    try {
      report(method === "sign" ? await reclaimExcess(owner, { token: pg.token }, zh) : await approveZero(owner, { token: pg.token }, zh));
    } finally {
      setPending(false);
    }
  }

  return (
    <ConfirmDialog
      open={row !== null}
      onOpenChange={(o) => { if (!o) setMethod("sign"); onOpenChange(o); }}
      title={zh ? `收回 ${row?.symbol ?? "未登记资产"} 的多余额度？` : `Reclaim the extra ${row?.symbol ?? "unregistered asset"} allowance?`}
      consequence={reclaimConsequence(method, row?.symbol ?? (zh ? "未登记资产" : "unregistered asset"), zh)}
      confirmLabel={method === "sign" ? (zh ? "签名收回" : "Sign to reclaim") : (zh ? "发交易清零" : "Send zeroing transaction")}
      pending={pending}
      onConfirm={() => void confirm()}
    >
      {pg && row ? (
        <div className="flex flex-col gap-4">
          <KeyValue dense items={[
            { label: zh ? "链上额度" : "On-chain", value: <Amount raw={pg.onchainRaw} decimals={row.decimals} symbol={row.symbol} /> },
            { label: zh ? "仍在进行的授权需要" : "Still needed", value: <Amount raw={pg.requiredRaw} decimals={row.decimals} symbol={row.symbol} /> },
            { label: zh ? "多出" : "Extra", value: <Amount raw={pg.excessRaw} decimals={row.decimals} symbol={row.symbol} /> },
          ]} />
          <RadioGroup value={method} onValueChange={(v) => setMethod(v as Method)} aria-label={zh ? "收回方式" : "How to reclaim"}>
            <div className="flex items-start gap-3">
              <RadioGroupItem value="sign" id="reclaim-sign" className="mt-0.5" />
              <Label htmlFor="reclaim-sign" className="flex flex-col items-start gap-0.5 text-sm font-normal text-fg-1">
                {zh ? "签名收回多余部分" : "Sign to reclaim the extra"}
                <span className="text-xs text-fg-3">{zh ? "平台代付上链，推荐" : "Platform pays gas; recommended"}</span>
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <RadioGroupItem value="zero" id="reclaim-zero" className="mt-0.5" disabled={!zeroOk} />
              <Label htmlFor="reclaim-zero" className="flex flex-col items-start gap-0.5 text-sm font-normal text-fg-1">
                {zh ? "自己发交易清零" : "Zero it with your own transaction"}
                <span className="text-xs text-fg-3">{zeroOk ? (zh ? "你付 gas；仍在进行的任务要重新签额度" : "You pay gas; active tasks need a new allowance") : (zh ? "这个部署没有配置 PlanGuard 地址，暂不可用" : "Unavailable: PlanGuard address is not configured here")}</span>
              </Label>
            </div>
          </RadioGroup>
          <p className="text-xs text-fg-3">{zh ? "收回额度不会暂停或取消任务，也不会撤销你已签的授权；那些在任务页里各自操作。" : "Reclaiming does not pause or cancel tasks, and does not revoke authorizations you signed; those are separate actions on the task page."}</p>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
