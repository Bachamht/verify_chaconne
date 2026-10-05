"use client";
/**
 * 「收回给 PlanGuard 的额度」的签名与提交逻辑（v7 AllowanceSection 与 v8 资金页共用，界面各自渲染结果）。
 *  - reclaimExcess：POST …/reclaim 拿 permit → 钱包签 typedData → POST …/submit（平台代付上链）
 *  - approveZero：自己发 approve(PlanGuard, 0) 交易（你付 gas）
 * 两者都先确认已连接钱包就是这个 owner。只改链上额度，不暂停、不取消任务，也不撤销已签的授权。
 */
import type { TypedDataDomain } from "viem";
import { v7, type OwnerAllowanceRow } from "@/lib/api-v2";
import { approveExact, classifyWalletError, connect, signTypedData } from "@/lib/wallet";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { typedDataForWallet } from "../delegation/delegationModel";

export type AllowanceActionOutcome =
  | { kind: "ok" }
  /** 服务端拒绝（发生在签名之前或提交时）；res 给 apiError 用 */
  | { kind: "api"; res: { status: number; data: unknown } }
  /** 提交时网络 / 超时（status 0） */
  | { kind: "unreachable" }
  /** 钱包里点了拒绝 */
  | { kind: "rejected" }
  | { kind: "error"; message: string };

async function ownerAccount(owner: string, zh: boolean): Promise<`0x${string}`> {
  const a = await connect();
  if (a.toLowerCase() !== owner.toLowerCase()) throw new Error(zh ? "已连接钱包不是这个 owner" : "Connected wallet is not this owner");
  return a;
}

function caught(e: unknown): AllowanceActionOutcome {
  if (classifyWalletError(e) === "rejected") return { kind: "rejected" };
  return { kind: "error", message: String((e as { message?: string })?.message ?? e).slice(0, 160) };
}

export async function reclaimExcess(owner: string, row: Pick<OwnerAllowanceRow, "token">, zh: boolean): Promise<AllowanceActionOutcome> {
  try {
    const issued = await v7.reclaim(owner, row.token);
    if (issued.status !== 200 && issued.status !== 201) return { kind: "api", res: issued };
    const a = await ownerAccount(owner, zh);
    const w = typedDataForWallet(issued.data.typedData);
    const sig = await signTypedData(a, w.domain as TypedDataDomain, w.types, w.primaryType, w.message);
    const sub = await v7.submitReclaim(owner, { permitRequestId: issued.data.permitRequestId, signature: sig });
    if (sub.status === 0) return { kind: "unreachable" };
    if (sub.status >= 300) return { kind: "api", res: sub };
    return { kind: "ok" };
  } catch (e) {
    return caught(e);
  }
}

export const approveZeroAvailable = (): boolean => Boolean(PLANGUARD_ADDRESS);

export async function approveZero(owner: string, row: Pick<OwnerAllowanceRow, "token">, zh: boolean): Promise<AllowanceActionOutcome> {
  if (!PLANGUARD_ADDRESS) return { kind: "error", message: zh ? "这个部署没有配置 PlanGuard 地址" : "PlanGuard address is not configured on this deployment" };
  try {
    const a = await ownerAccount(owner, zh);
    await approveExact(a, row.token, PLANGUARD_ADDRESS as `0x${string}`, 0n);
    return { kind: "ok" };
  } catch (e) {
    return caught(e);
  }
}
