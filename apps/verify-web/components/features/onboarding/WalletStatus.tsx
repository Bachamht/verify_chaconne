"use client";
import { Hash } from "@/components/kit/Hash";
import { ToneTag } from "@/components/kit/StatusBadge";
import { useI18n } from "@/lib/i18n";

/** 签名前的钱包状态：未连接 / 是任务 owner / 不是 owner（给修法）。签名只能由 owner 钱包完成 */
export function WalletStatus({ account, owner }: { account: string | null; owner: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const match = !!account && account.toLowerCase() === owner.toLowerCase();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-surface-2 px-3 py-2 text-sm">
      <span className="text-fg-2">{zh ? "签名钱包" : "Signing wallet"}</span>
      {account ? <Hash value={account} kind="address" explorer={false} /> : <span className="text-fg-3">{zh ? "未连接" : "Not connected"}</span>}
      {!account ? <ToneTag tone="neutral">{zh ? "点开始签名时会请你连接" : "You will be asked to connect"}</ToneTag>
        : match ? <ToneTag tone="ok">{zh ? "是任务的 owner" : "Task owner"}</ToneTag>
        : <ToneTag tone="warn">{zh ? "不是任务的 owner" : "Not the task owner"}</ToneTag>}
      {account && !match ? <span className="flex basis-full items-center gap-1 text-xs text-warn">{zh ? "请在钱包里切换到" : "Switch your wallet to"} <Hash value={owner} kind="address" explorer={false} /></span> : null}
    </div>
  );
}
