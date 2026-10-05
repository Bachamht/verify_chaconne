"use client";
/**
 * /tasks/[id] 授权任务的数据与动作（从 TaskClient 搬来；钱包 / 授权 / 发送 / 撤销逻辑逐行一致）。
 * 唯一改动：取数改成 useResource（15 s 轮询、四态），动作成功后 reload 代替直接 setM。
 */
import { useState } from "react";
import type { Bill } from "@chaconne/core/verify";
import { mandates, type MandateView, type PreparedStep } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { apiError } from "@/lib/errors";
import { encodeExecuteStep } from "@/lib/mandate";
import { revokeOnChain } from "@/lib/revokeOnChain";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { useResource } from "@/lib/useResource";
import { walletErrorText } from "@/lib/i18n.execute";
import { toolsCopy } from "./copy";
import { taskNumbers } from "./taskModel";
import { allowance, approveExact, CHAIN_ID, connect, currentChainId, ensureChain, publicClient, sendGuardCall, waitReceipt } from "@/lib/wallet";

export type TaskPhase = "idle" | "preparing" | "approving" | "sending" | "pending" | "done" | "error";

export function useTaskMandate(id: string) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const res = useResource<MandateView>(`mandate:${id}`, () => mandates.get(id), { intervalMs: 15_000 });
  const bill = useResource<Bill | null>(`mandate-bill:${id}`, () => mandates.bill(id), { isEmpty: (d) => d === null });
  const m = res.data;
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [prep, setPrep] = useState<PreparedStep | null>(null);
  const [phase, setPhase] = useState<TaskPhase>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [acting, setActing] = useState<null | "pause" | "resume" | "cancel" | "revoke">(null);
  const load = async () => { res.reload(); bill.reload(); };

  async function wallet(): Promise<`0x${string}`> {
    const a = account ?? (await connect());
    setAccount(a);
    if ((await currentChainId()) !== CHAIN_ID) await ensureChain();
    return a;
  }
  /** 暂停 / 继续 / 取消：返回是否成功（调用方 toast） */
  async function action(kind: "pause" | "resume" | "cancel"): Promise<boolean> {
    setMsg(null);
    setActing(kind);
    try {
      const r = await mandates[kind](id);
      if (r.status === 200) { res.reload(); return true; }
      setMsg(apiError(r, locale));
      return false;
    } finally {
      setActing(null);
    }
  }
  async function revoke(): Promise<boolean> {
    if (!m) return false;
    setMsg(null);
    setActing("revoke");
    try {
      const r = await revokeOnChain(m.mandate, account ?? null, locale);
      if (!r.ok) { setMsg(r.message); return false; }
      // 链上撤销成功后服务端也取消；取消失败要说出来（链上已撤销，服务端状态未同步）
      const cancelled = await action("cancel");
      if (!cancelled) setMsg(zh ? "链上已撤销，但服务端取消没有成功，刷新后再点一次「取消」。" : "Revoked on-chain, but the service-side cancel failed; refresh and press Cancel again.");
      return true;
    } finally {
      setActing(null);
    }
  }
  async function executeStep() {
    if (!m) return;
    setMsg(null);
    setTxHash(null);
    try {
      // 步骤证书只有约 30 s（受报价时效约束）：授权必须在 prepare-step **之前**做完，否则证书在钱包弹窗里就过期了（I2 2026-09-21，服务器实测）
      const a = await wallet();
      if (a.toLowerCase() !== m.owner.toLowerCase()) {
        setPhase("error");
        return setMsg(zh ? "已连接的账户不是这个任务的所有者。在钱包里切到所有者账户后再试。" : "The connected account does not own this task. Switch to the owner account in your wallet and try again.");
      }
      const inputToken = m.mandate.inputToken as `0x${string}`;
      // 线上形状：预算在 budget.cap、单步上限在 mandate.perStepCap（taskModel 兜底），算法与 TaskClient 相同
      const n = taskNumbers(m);
      const remaining = BigInt(n.budgetCap ?? "0") - BigInt(n.spent ?? "0");
      const need = remaining < BigInt(n.perStepCap ?? "0") ? remaining : BigInt(n.perStepCap ?? "0");
      const planGuard = PLANGUARD_ADDRESS as `0x${string}`;
      const have = await allowance(inputToken, a, planGuard);
      if (need > 0n && have < need) {
        setPhase("approving");
        await approveExact(a, inputToken, planGuard, need);
      }
      setPhase("preparing");
      const r = await mandates.prepareStep(id);
      setPrep(r.data);
      if (r.status !== 200 || !r.data.step) {
        setPhase("idle");
        return;
      }
      const s = r.data.step;
      if (BigInt(s.approval.amount) > (await allowance(s.approval.token, a, s.approval.spender))) {
        setPhase("approving");
        await approveExact(a, s.approval.token, s.approval.spender, BigInt(s.approval.amount));
      }
      setPhase("sending");
      const data = encodeExecuteStep({ mandate: m.mandate, mandateSignature: m.signature, outputSet: s.outputSet, step: s.typedData.message, certificate: s.certificate, certificateSignature: s.certificateSignature, routerCalldata: s.routerCalldata });
      let gas = 900_000n;
      try {
        gas = ((await publicClient.estimateGas({ account: a, to: s.guardCall.to, data })) * 13n) / 10n;
      } catch {
        setPhase("error");
        return setMsg(toolsCopy(locale).stepWouldRevert);
      }
      const h = await sendGuardCall(a, s.guardCall.to, data, gas);
      setTxHash(h);
      setPhase("pending");
      const sub = await mandates.submit(id, s.stepIndex, h).catch(() => null);
      const rcpt = await waitReceipt(h);
      setPhase(rcpt.status === "success" ? "done" : "error");
      if (rcpt.status !== "success") setMsg(zh ? "交易在链上回滚，未成交。" : "The transaction reverted on-chain; nothing filled.");
      // 交易已发出但没登记到服务端：链上结果不受影响；明说，不让人重复发送
      else if (!sub || sub.status >= 300) setMsg(zh ? "交易已上链，但登记到服务端没有成功。成交以链上为准，可以在区块浏览器里核对；不要重复发送，稍后刷新页面再看记录。" : "The transaction is on-chain, but registering it with the service failed. The on-chain result stands; check it in the explorer. Do not send it again; refresh later to see the record.");
      await load();
    } catch (e) {
      setPhase("error");
      setMsg((e as { code?: number }).code === 4001 ? (zh ? "钱包里拒绝了，未发送任何交易。" : "Rejected in the wallet; nothing was sent.") : walletErrorText(e, locale));
    }
  }

  return { res, bill, m, account, prep, phase, txHash, msg, acting, action, revoke, executeStep };
}

export type TaskMandate = ReturnType<typeof useTaskMandate>;
