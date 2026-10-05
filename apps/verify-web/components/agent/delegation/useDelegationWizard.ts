"use client";
/**
 * P2 委托向导的状态与签名编排（从 DelegationWizard.tsx 原样搬出，v7 与 v8 两个外观共用同一份逻辑，签名代码只有这一处）：
 * 拉 GET /delegation → 按固定顺序（buy → sell:* → permit:*）逐项 signTypedData → 提交（/authorize itemId 或 /allowances）。
 * 计数器只读服务端 counts；拒签保留已签项、从断点继续；409 permit_nonce_stale / permit_pending 自动重取；
 * 全部签完后轮询 permit 上链（平台执行身份代付 gas）。服务端永不代签：签名只在你的钱包里发生；本模块不发任何交易。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TypedDataDomain } from "viem";
import type { DelegationChecklist, DelegationItem } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { notReady, v7 } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import { CHAIN_ID, classifyWalletError, connect, currentChainId, ensureChain, short, signTypedData } from "@/lib/wallet";
import { useAccount } from "@/lib/useAccount";
import { signLoop, typedDataForWallet, wizardPhase } from "./delegationModel";
import { fxChecklist } from "@/lib/v7fixtures";

export type WizardStep = { kind: "idle" } | { kind: "signing"; k: number } | { kind: "submitting"; k: number } | { kind: "refetch" };
export type WizardMsg = { tone: "warn" | "bad" | "ok"; text: string } | null;
export type WizardLoad = { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok" };

export function useDelegationWizard({ taskId, owner, fixture = false, onComplete }: { taskId: string; owner?: string | null; fixture?: boolean; onComplete?: () => void }) {
  const { locale } = useI18n();
  const account = useAccount();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [list, setList] = useState<DelegationChecklist | null>(fixture ? fxChecklist("partial") : null);
  const [load, setLoad] = useState<WizardLoad>(fixture ? { kind: "ok" } : { kind: "busy" });
  const [step, setStep] = useState<WizardStep>({ kind: "idle" });
  const [msg, setMsg] = useState<WizardMsg>(null);
  const alive = useRef(true);
  const completed = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { void loadAssets().then((r) => alive.current && setAssets(r.assets)); }, []);

  const fetchList = useCallback(async (): Promise<DelegationChecklist | null> => {
    if (fixture) return list;
    const r = await v7.delegation(taskId).catch(() => null);
    if (!alive.current) return null;
    if (!r || r.status === 0 || notReady(r)) { setLoad((s) => (s.kind === "ok" ? s : { kind: "nr", http: r?.status ?? 0 })); return null; }
    if (r.status !== 200) { setLoad({ kind: "err", msg: apiError(r, locale) }); return null; }
    setList(r.data);
    setLoad({ kind: "ok" });
    return r.data;
  }, [fixture, list, taskId, locale]);
  // 只在挂载 / 换任务时拉一次（fetchList 依赖 list，放进依赖会每次刷新都重拉）
  const fetchRef = useRef(fetchList);
  fetchRef.current = fetchList;
  useEffect(() => { if (!fixture) void fetchRef.current(); }, [fixture, taskId]);

  const phase = list ? wizardPhase(list) : null;
  // 签完后：轮询 permit 上链进度（3 s）；完成即停
  useEffect(() => {
    if (fixture || phase !== "onchain" || step.kind !== "idle") return;
    const id = setInterval(() => { void fetchList(); }, 3000);
    return () => clearInterval(id);
  }, [fixture, phase, step.kind, fetchList]);
  useEffect(() => {
    if (phase === "done" && !completed.current) { completed.current = true; onComplete?.(); }
  }, [phase, onComplete]);

  async function wallet(): Promise<`0x${string}`> {
    const a = (account ?? (await connect())) as `0x${string}`;
    if ((await currentChainId()) !== CHAIN_ID) await ensureChain();
    return a;
  }

  async function run() {
    if (fixture || !list || step.kind !== "idle") return;
    setMsg(null);
    let me: `0x${string}`;
    try { me = await wallet(); } catch (e) { setMsg({ tone: "bad", text: walletErrText(e) }); return; }
    const want = (owner ?? "").toLowerCase();
    if (want && me.toLowerCase() !== want) { setMsg({ tone: "warn", text: tv(locale, "d_wrong_wallet", { owner: short(want) }) }); return; }
    const { end } = await signLoop(list, {
      me,
      fetch: fetchList,
      isRejection: (e) => { const k = classifyWalletError(e); return k === "rejected" || k === "cancelled"; },
      onStep: (s) => { if (alive.current) setStep(s.kind === "refetch" ? { kind: "refetch" } : { kind: s.kind, k: s.k }); },
      sign: async (item) => {
        const w = typedDataForWallet(item.typedData!);
        return signTypedData(me, w.domain as TypedDataDomain, w.types, w.primaryType, w.message);
      },
      submit: async (item, sig) => {
        const extra = item as DelegationItem & { outputSet?: `0x${string}`[] };
        return item.kind === "permit"
          ? v7.submitAllowance(taskId, { permitRequestId: item.permitRequestId!, signature: sig }).catch(() => null)
          : v7.authorizeItem(taskId, { itemId: item.id, typedData: item.typedData, signature: sig, ...(Array.isArray(extra.outputSet) ? { outputSet: extra.outputSet } : {}) }).catch(() => null);
      },
    });
    if (!alive.current) return;
    if (end.kind === "rejected") setMsg({ tone: "warn", text: tv(locale, "d_rejected", { k: end.k }) });
    else if (end.kind === "wallet_error") setMsg({ tone: "bad", text: walletErrText(end.error) });
    else if (end.kind === "wrong_wallet") setMsg({ tone: "warn", text: tv(locale, "d_wrong_wallet", { owner: short(end.expected) }) });
    else if (end.kind === "unreachable") setMsg({ tone: "bad", text: tv(locale, "unreachable") });
    else if (end.kind === "submit_error") setMsg({ tone: "bad", text: apiError(end.response, locale) });
    else if (end.kind === "too_many_refetches") setMsg({ tone: "bad", text: end.response ? apiError(end.response, locale) : tv(locale, "d_refetching") });
    if (alive.current) setStep({ kind: "idle" });
  }

  async function refreshSell() {
    if (fixture) return;
    const r = await v7.refreshDelegation(taskId).catch(() => null);
    if (r && r.status === 200) setList(r.data);
    else if (r) setMsg({ tone: "bad", text: apiError(r, locale) });
  }

  function walletErrText(e: unknown): string {
    const kind = classifyWalletError(e);
    const msgText = String((e as { message?: string } | null)?.message ?? e);
    return kind === "unknown" ? msgText.slice(0, 200) : `${msgText.slice(0, 120)}`;
  }

  return { account, assets, list, load, step, msg, phase, fetchList, run, refreshSell };
}
