"use client";
import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { useI18n } from "@/lib/i18n";
import { signatureCount, type FormDraft } from "../task-form/model";

/**
 * 底部固定操作条：主按钮「先观察（模拟）」+ 次按钮「直接真实运行」（二次确认，写清签名次数与卖出范围）。
 * 不可提交时给可见原因（C3）。
 */
export function NewTaskActionBar({ draft, valid, pending, onCreate }: {
  draft: FormDraft | null;
  valid: boolean;
  pending: "SIMULATION" | "LIVE" | null;
  onCreate: (mode: "SIMULATION" | "LIVE") => Promise<void>;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [confirm, setConfirm] = useState(false);
  const blocked = !draft || !valid;
  const reason = blocked ? (zh ? "先修改上面标红的字段。" : "Fix the highlighted fields above first.") : null;
  const sig = draft ? signatureCount(draft) : 2;
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-fg-3" aria-live="polite">
          {reason ?? (zh ? "观察不执行交易，每个钱包每天最多 3 个观察任务。" : "Observation executes no trades; up to 3 observation tasks per wallet per day.")}
        </p>
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <Button type="button" variant="outline" disabled={blocked || pending !== null} onClick={() => setConfirm(true)}>{zh ? "直接真实运行" : "Run live now"}</Button>
          <AsyncButton type="button" disabled={blocked} pending={pending === "SIMULATION"} pendingLabel={zh ? "正在建观察任务" : "Creating observation"} onClick={() => void onCreate("SIMULATION")}>
            <FlaskConical aria-hidden="true" />{zh ? "先观察（模拟）" : "Observe first (simulation)"}
          </AsyncButton>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="default"
        title={zh ? "跳过观察，直接创建真实任务？" : "Skip observation and create a live task?"}
        consequence={zh
          ? `真实任务会使用你钱包里的资金。创建后要在任务页逐项签名授权，最多 ${sig} 次（买入 2 次${draft?.allowSell ? "，每只允许卖出的股票再加 2 次" : ""}），签名不是交易；签完 Agent 才会在范围内交易。`
          : `A live task uses funds in your wallet. After creating it, sign the authorization item by item on the task page: up to ${sig} signatures (2 for buying${draft?.allowSell ? ", plus 2 per stock it may sell" : ""}). Signatures are not transactions; the agent trades within scope only after you sign.`}
        confirmLabel={zh ? "创建真实任务" : "Create live task"}
        pending={pending === "LIVE"}
        onConfirm={() => { void onCreate("LIVE").then(() => setConfirm(false)); }}
      >
        <ul className="list-disc pl-4 text-sm text-fg-2">
          {draft?.allowSell ? <li>{zh ? "卖出范围包含钱包里这些股票的原有持仓，不限于本任务买入的部分。" : "Selling covers holdings of these stocks already in your wallet, not only what this task buys."}</li> : null}
          <li>{zh ? "任务结束不会自动撤销链上额度，需要时到「资金」里收回。" : "Ending the task does not revoke on-chain allowances; reclaim them under Funds when needed."}</li>
          <li>{zh ? "托管运行目前只对受邀钱包开放；不在名单内会被拒绝，可改用观察。" : "Hosted runs are invite-only for now; other wallets are refused and can observe instead."}</li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}
