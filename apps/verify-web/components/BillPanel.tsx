"use client";
import type { Bill } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { Card, Pill } from "@/components/ui";
import { EXPLORER, short } from "@/lib/wallet";

export function BillPanel({ bill }: { bill: Bill | null }) {
  const { t } = useI18n();
  if (!bill) return null;
  const group = (label: string, lines: Bill["serviceFees"]) => (
    <div className="mb-3">
      <div className="mb-1 text-xs uppercase tracking-wide text-neutral-400">{label}</div>
      {lines.length === 0 ? <p className="text-xs text-neutral-500">—</p> : lines.map((l, i) => (
        <div key={i} className="flex flex-wrap justify-between gap-2 border-b border-neutral-800 py-1 text-sm last:border-0">
          <span>{l.label}</span>
          <span className="mono">{l.amountRaw} {l.asset}{l.amountUsd ? ` · $${l.amountUsd}` : ""} {l.txHash && <a className="underline" href={`${EXPLORER}/tx/${l.txHash}`} target="_blank" rel="noreferrer">{short(l.txHash)}</a>}</span>
        </div>
      ))}
    </div>
  );
  return (
    <Card title={t("task_bill")} right={bill.selfPayment ? <Pill tone="warn">{t("bill_self")}</Pill> : null}>
      {group(t("bill_fees"), bill.serviceFees)}
      {group(t("bill_principal"), bill.principal)}
      {group(t("bill_gas"), bill.gas)}
    </Card>
  );
}
