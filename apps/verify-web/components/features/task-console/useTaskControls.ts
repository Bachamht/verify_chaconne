"use client";
/**
 * 任务控制（从 TaskDetail 搬来，接口与行为不变）：暂停 / 继续 / 取消 / 删除 / 链上撤销 / 旧部署单签授权。
 * 四种「停」各是各的：暂停与取消只影响服务端签发；收回额度在资金页；链上撤销是一笔你签的交易。
 * 结果一律 sonner toast；确认由调用方的 ConfirmDialog 负责（这里不用 window.confirm）。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { TradeMandate } from "@chaconne/core/verify";
import { agentTasks, type MandateDraftView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";
import { revokeOnChain } from "@/lib/revokeOnChain";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { CHAIN_ID, connect, currentChainId, ensureChain, signTypedData } from "@/lib/wallet";

export type ControlKind = "pause" | "resume" | "cancel" | "delete" | "revoke" | "authorize";

export function useTaskControls(id: string, account: string | null, reload: () => void) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const [pending, setPending] = useState<ControlKind | null>(null);

  async function wallet(): Promise<`0x${string}`> {
    const a = (account ?? (await connect())) as `0x${string}`;
    if ((await currentChainId()) !== CHAIN_ID) await ensureChain();
    return a;
  }

  async function stop(kind: "pause" | "resume" | "cancel"): Promise<boolean> {
    setPending(kind);
    const r = await agentTasks[kind](id).catch(() => null);
    setPending(null);
    if (!r || r.status === 0) { toast.error(t("ag_service_unreachable")); return false; }
    if (r.status !== 200) { toast.error(apiError(r, locale)); return false; }
    toast.success(kind === "pause" ? t("ag_paused_ok") : kind === "resume" ? t("ag_resumed_ok") : t("ag_cancelled_ok"));
    reload();
    return true;
  }

  async function remove(): Promise<boolean> {
    setPending("delete");
    const r = await agentTasks.archive(id).catch(() => null);
    setPending(null);
    if (!r || r.status !== 200) { toast.error(r ? apiError(r, locale) : t("ag_service_unreachable")); return false; }
    router.push("/agent/tasks");
    return true;
  }

  async function revoke(mandate: TradeMandate): Promise<boolean> {
    setPending("revoke");
    const r = await revokeOnChain(mandate, account, locale);
    setPending(null);
    if (!r.ok) { toast.error(r.message); return false; }
    toast.success(zh ? `链上已撤销 ${r.hash.slice(0, 10)}…` : `Revoked on-chain ${r.hash.slice(0, 10)}…`);
    reload();
    return true;
  }

  /** 旧部署（没有委托清单）的单签授权；新部署走 DelegationWizard */
  async function authorize(draft: MandateDraftView): Promise<boolean> {
    setPending("authorize");
    try {
      const a = await wallet();
      if (a.toLowerCase() !== draft.typedData.message.owner.toLowerCase()) { toast.warning(zh ? "已连接钱包不是这份授权的 owner" : "Connected wallet is not this mandate's owner"); return false; }
      const m = draft.typedData.message;
      const big = { ...m, budgetCap: BigInt(m.budgetCap), perStepCap: BigInt(m.perStepCap), maxSteps: Number(m.maxSteps), validFrom: BigInt(m.validFrom), deadline: BigInt(m.deadline), nonce: BigInt(m.nonce) };
      const sig = await signTypedData(a, draft.typedData.domain, draft.typedData.types, "TradeMandate", big as unknown as Record<string, unknown>);
      const r = await agentTasks.authorize(id, { typedData: draft.typedData, signature: sig, outputSet: draft.outputSet, clientRequestId: `web-auth-${id}` });
      if (r.status !== 201 && r.status !== 200) { toast.error(apiError(r, locale)); return false; }
      toast.success(zh ? "授权已登记；执行由你的钱包或 Agent 完成。" : "Authorization registered; execution is done by your wallet or agent.");
      reload();
      return true;
    } catch (e) {
      toast.error(String((e as { message?: string })?.message ?? e));
      return false;
    } finally {
      setPending(null);
    }
  }

  return { pending, pause: () => stop("pause"), resume: () => stop("resume"), cancel: () => stop("cancel"), remove, revoke, authorize, canRevoke: Boolean(PLANGUARD_ADDRESS) };
}
