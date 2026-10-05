"use client";
/**
 * 委托向导的 v8 外观：StepFlow 竖排 + AsyncButton + 钱包状态。
 * 签名、提交、重取、上链轮询全部在 useDelegationWizard（与 v7 外观共用同一份代码，这里一行不改）。
 */
import Link from "next/link";
import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { StepFlow } from "@/components/kit/StepFlow";
import { ToneTag } from "@/components/kit/StatusBadge";
import { assetByKey } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { counterView, itemPosition, nextItem, orderItems } from "@/components/agent/delegation/delegationModel";
import { useDelegationWizard } from "@/components/agent/delegation/useDelegationWizard";
import { DelegationItemStep } from "./DelegationItemStep";
import { WalletStatus } from "./WalletStatus";

export function DelegationSteps({ taskId, owner, fixture = false, onComplete, taskHref }: { taskId: string; owner: string; fixture?: boolean; onComplete?: () => void; taskHref: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const w = useDelegationWizard({ taskId, owner, fixture, onComplete });
  const { list, load, step, msg, phase } = w;
  if (load.kind === "busy") return <LoadingBlock rows={4} onRetry={() => void w.fetchList()} />;
  if (load.kind === "nr") return <ErrorState size="sm" status={load.http} title={zh ? "暂时拿不到授权清单" : "The authorization checklist is unavailable"} onRetry={() => void w.fetchList()} />;
  if (load.kind === "err") return <ErrorState size="sm" title={zh ? "授权清单出错" : "The checklist returned an error"} description={load.msg} onRetry={() => void w.fetchList()} />;
  if (!list) return <ErrorState size="sm" title={zh ? "授权清单没有返回内容" : "The checklist came back empty"} description={zh ? "重新读取一次；仍然没有就到任务页查看授权进度。" : "Load it again. If it is still missing, check authorization progress on the task page."} onRetry={() => void w.fetchList()} />;

  const items = orderItems(list.items);
  const c = counterView(list.counts);
  const next = nextItem(list);
  const nextK = next ? itemPosition(list, next.id) : 0;
  const busy = step.kind !== "idle";
  const gas = c.gasZero ? tv(locale, "d_gas_zero") : tv(locale, "d_gas_user");
  const sym = (k: string) => assetByKey(w.assets, k)?.displaySymbol ?? (zh ? "未登记资产" : "Unregistered asset");
  const phaseText = step.kind === "signing" ? tv(locale, "d_signing", { k: step.k }) : step.kind === "submitting" ? tv(locale, "d_submitting", { k: step.k }) : null;
  const wrongWallet = !fixture && !!w.account && w.account.toLowerCase() !== owner.toLowerCase();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <WalletStatus account={fixture ? owner : w.account} owner={owner} />
      <p className="text-sm font-medium text-fg-1 tabular-nums" role="status" aria-live="polite" data-testid="delegation-counter">{tv(locale, "d_counter", { done: c.done, needed: c.needed, tx: c.tx, gas })}</p>
      {c.tx > 0 ? <Alert><TriangleAlert aria-hidden="true" className="text-warn" /><AlertDescription className="text-fg-2">{tv(locale, "d_fallback_tx", { n: c.tx })}</AlertDescription></Alert> : null}
      {phase === "signing" ? (
        <Alert>
          <AlertTitle>{tv(locale, "d_prewarn_h")}</AlertTitle>
          <AlertDescription className="text-fg-2"><ul className="list-disc pl-4"><li>{tv(locale, "d_prewarn_1")}</li><li>{tv(locale, "d_prewarn_2")}</li>{c.tx === 0 ? <li>{tv(locale, "d_prewarn_3")}</li> : null}</ul></AlertDescription>
        </Alert>
      ) : null}
      {phase === "empty" ? <EmptyState size="sm" title={tv(locale, "d_empty")} /> : (
        <StepFlow aria-label={zh ? "授权清单" : "Authorization checklist"}>
          {items.map((it, i) => {
            const k = itemPosition(list, it.id);
            const current = (step.kind === "signing" || step.kind === "submitting") && k === step.k;
            return <DelegationItemStep key={it.id} item={it} index={k} current={current} phaseText={phaseText} symbol={sym(it.assetKey)} last={i === items.length - 1} onRefreshSell={() => void w.refreshSell()} fixture={fixture} />;
          })}
        </StepFlow>
      )}
      {step.kind === "refetch" ? <p className="text-sm text-fg-2" role="status">{tv(locale, "d_refetching")}</p> : null}
      {msg ? <Alert variant={msg.tone === "bad" ? "destructive" : "default"}><AlertDescription className={msg.tone === "bad" ? "text-bad" : "text-warn"}>{msg.text}</AlertDescription></Alert> : null}
      {phase === "signing" ? (
        <AsyncButton
          className="self-start"
          pending={busy}
          pendingLabel={phaseText ?? tv(locale, "loading")}
          disabled={fixture || wrongWallet}
          disabledReason={fixture ? (zh ? "示例数据不能签名。" : "Sample data cannot be signed.") : wrongWallet ? (zh ? "先在钱包里切换到任务的 owner 地址。" : "Switch your wallet to the task owner first.") : null}
          onClick={() => void w.run()}
        >
          {c.done > 0 || msg ? tv(locale, "d_resume", { k: nextK }) : tv(locale, "d_start")}
        </AsyncButton>
      ) : null}
      {phase === "onchain" ? (
        <Alert aria-live="polite">
          <LoaderCircle aria-hidden="true" className="animate-spin" />
          <AlertTitle>{tv(locale, "d_onchain_h")}</AlertTitle>
          <AlertDescription className="text-fg-2">
            {tv(locale, "d_onchain_wait")}
            <span className="flex flex-wrap gap-1.5">
              {list.buyReady ? <ToneTag tone="ok">{tv(locale, "d_buy_ready")}</ToneTag> : null}
              {Object.entries(list.sellReady).filter(([, v]) => v).map(([k]) => <ToneTag key={k} tone="ok">{tv(locale, "d_sell_ready", { asset: sym(k) })}</ToneTag>)}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {phase === "done" ? (
        <Alert>
          <CircleCheck aria-hidden="true" className="text-ok" />
          <AlertTitle>{tv(locale, "d_done_h")}</AlertTitle>
          <AlertDescription className="text-fg-2">
            {tv(locale, "d_done_p", { tx: c.tx, gas })}
            <Button size="sm" asChild className="mt-1"><Link href={taskHref}>{tv(locale, "d_open_task")}</Link></Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs text-fg-3">{tv(locale, "proof_scope")}</p>
    </div>
  );
}
