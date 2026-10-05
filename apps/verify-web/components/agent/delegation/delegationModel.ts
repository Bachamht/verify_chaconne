/**
 * 委托向导的纯逻辑（P2）：签名顺序、断点续签、计数器、钱包 typedData 转换、409 重取判定。页面与测试共用。
 * 顺序固定（开发计划 §2.2）：buy → 各 sell:<asset> → 各 permit:<token>。
 */
import type { DelegationChecklist, DelegationItem, Eip712TypedData } from "@chaconne/core/verify";

export type ItemGroup = 0 | 1 | 2;
export function itemGroup(item: Pick<DelegationItem, "id" | "kind">): ItemGroup {
  if (item.kind === "mandate_buy" || item.id === "buy") return 0;
  if (item.kind === "mandate_sell" || item.id.startsWith("sell:")) return 1;
  return 2;
}

/** 稳定排序：组内保持服务端给的顺序 */
export function orderItems<T extends Pick<DelegationItem, "id" | "kind">>(items: readonly T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => itemGroup(a.it) - itemGroup(b.it) || a.i - b.i).map((x) => x.it);
}

/** 还要用户签的项：todo（有 typedData），或 failed 但服务端又给了新的 typedData（可重签） */
export function needsSignature(item: DelegationItem): boolean {
  if (!item.typedData) return false;
  return item.status === "todo" || item.status === "failed";
}

/** 下一项要签的（按固定顺序）；null = 签名阶段结束 */
export function nextItem(list: Pick<DelegationChecklist, "items">): DelegationItem | null {
  return orderItems(list.items).find(needsSignature) ?? null;
}

/** 第几项（1 起，按固定顺序，含不需要签的项，与页面列表编号一致） */
export function itemPosition(list: Pick<DelegationChecklist, "items">, id: string): number {
  return orderItems(list.items).findIndex((x) => x.id === id) + 1;
}

export type WizardPhase = "empty" | "signing" | "onchain" | "done";
export function wizardPhase(list: Pick<DelegationChecklist, "items" | "complete">): WizardPhase {
  if (list.items.length === 0) return "empty";
  if (list.complete) return "done";
  if (nextItem(list)) return "signing";
  return "onchain";
}

export interface CounterView { done: number; needed: number; tx: number; gasZero: boolean }
/** 计数器只读服务端 counts（P-02：与 counts 一致） */
export function counterView(c: DelegationChecklist["counts"] | null | undefined): CounterView {
  const done = Math.max(0, Number(c?.signaturesDone ?? 0) || 0);
  const needed = Math.max(0, Number(c?.signaturesNeeded ?? 0) || 0);
  const tx = Math.max(0, Number(c?.userTransactions ?? 0) || 0);
  return { done, needed, tx, gasZero: tx === 0 };
}

/** 409 里哪些要自动重取清单（permit 的 nonce 过期 / 同代币有在途 permit） */
export function isRefetchConflict(r: { status: number; data: unknown }): boolean {
  if (r.status !== 409) return false;
  const e = (r.data as { error?: unknown; code?: unknown } | null) ?? null;
  const code = String(e?.error ?? e?.code ?? "");
  // 后两个是页面对「GET 发放的请求过了 deadline − 120 s」可能用到的码的兼容（契约只写了前两个）
  return code === "permit_nonce_stale" || code === "permit_pending" || code === "permit_request_expired" || code === "permit_expired";
}
/** permit_not_needed：链上额度已够，直接重取（这一项会变成 not_needed） */
export function isNotNeeded(r: { status: number; data: unknown }): boolean {
  return r.status === 409 && String((r.data as { error?: unknown } | null)?.error ?? "") === "permit_not_needed";
}

const INT_TYPE = /^u?int(\d{0,3})$/;
/**
 * 服务端 typedData 的整数是十进制字符串（canon-1）；钱包库要 bigint。按 types 递归转换；去掉 EIP712Domain（钱包库自己按 domain 生成）。
 */
export function typedDataForWallet(td: Eip712TypedData): { domain: Eip712TypedData["domain"]; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> } {
  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [k, v] of Object.entries(td.types)) if (k !== "EIP712Domain") types[k] = v;
  const conv = (type: string, value: unknown): unknown => {
    if (type.endsWith("[]")) return Array.isArray(value) ? value.map((x) => conv(type.slice(0, -2), x)) : value;
    if (INT_TYPE.test(type)) return typeof value === "bigint" ? value : value === null || value === undefined ? value : BigInt(value as string | number);
    const struct = types[type];
    if (struct && value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      return Object.fromEntries(struct.map((f) => [f.name, conv(f.type, o[f.name])]));
    }
    return value;
  };
  const message = conv(td.primaryType, td.message) as Record<string, unknown>;
  const domain = { ...td.domain };
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  return { domain, types, primaryType: td.primaryType, message };
}

/** 签名人必须是任务 owner：mandate 看 message.owner，permit 也看 message.owner */
export function typedDataOwner(td: Eip712TypedData | null | undefined): string | null {
  const o = td?.message?.["owner"];
  return typeof o === "string" ? o.toLowerCase() : null;
}

/** 卖出项的股票 assetKey（"sell:<assetKey>"） */
export function sellAssetOf(id: string): string | null {
  return id.startsWith("sell:") ? id.slice(5) : null;
}

/** P7 预览：买入 = 授权 + 额度；每只可减仓股票 = 授权 + 额度。链上额度已够时实际更少（上界）。 */
export function signaturePreview(sellAssets: number, allowSell: boolean): number {
  return 2 + (allowSell ? 2 * Math.max(0, Math.floor(sellAssets)) : 0);
}

/* ---------- 签名循环（纯编排；钱包与网络由调用方注入，便于测试 P-02） ---------- */
export type LoopStep = { kind: "signing"; k: number; id: string } | { kind: "submitting"; k: number; id: string } | { kind: "refetch" };
export type LoopEnd =
  | { kind: "finished" }
  | { kind: "rejected"; k: number; id: string }
  | { kind: "wallet_error"; k: number; error: unknown }
  | { kind: "wrong_wallet"; expected: string }
  | { kind: "submit_error"; k: number; response: { status: number; data: unknown } }
  | { kind: "unreachable"; k: number }
  | { kind: "too_many_refetches"; response: { status: number; data: unknown } | null };
export interface LoopDeps {
  me: string;
  fetch: () => Promise<DelegationChecklist | null>;
  sign: (item: DelegationItem) => Promise<`0x${string}`>;
  submit: (item: DelegationItem, signature: `0x${string}`) => Promise<{ status: number; data: unknown } | null>;
  /** 钱包错误是否是用户拒签（拒签 → 从断点继续；其它错误照样停） */
  isRejection: (e: unknown) => boolean;
  onStep?: (s: LoopStep) => void;
  maxRefetches?: number;
}
export async function signLoop(start: DelegationChecklist, d: LoopDeps): Promise<{ end: LoopEnd; list: DelegationChecklist }> {
  let cur = start;
  let refetches = 0;
  const max = d.maxRefetches ?? 3;
  const me = d.me.toLowerCase();
  for (let guard = 0; guard < 32; guard++) {
    const item = nextItem(cur);
    if (!item || !item.typedData) return { end: { kind: "finished" }, list: cur };
    const k = itemPosition(cur, item.id);
    const tdOwner = typedDataOwner(item.typedData);
    if (tdOwner && tdOwner !== me) return { end: { kind: "wrong_wallet", expected: tdOwner }, list: cur };
    if (item.kind === "permit" && !item.permitRequestId) {
      if (++refetches > max) return { end: { kind: "too_many_refetches", response: null }, list: cur };
      d.onStep?.({ kind: "refetch" });
      cur = (await d.fetch()) ?? cur;
      continue;
    }
    d.onStep?.({ kind: "signing", k, id: item.id });
    let sig: `0x${string}`;
    try {
      sig = await d.sign(item);
    } catch (e) {
      return { end: d.isRejection(e) ? { kind: "rejected", k, id: item.id } : { kind: "wallet_error", k, error: e }, list: cur };
    }
    d.onStep?.({ kind: "submitting", k, id: item.id });
    const r = await d.submit(item, sig);
    if (!r || r.status === 0) return { end: { kind: "unreachable", k }, list: cur };
    if (isRefetchConflict(r) || isNotNeeded(r)) {
      if (++refetches > max) return { end: { kind: "too_many_refetches", response: r }, list: cur };
      d.onStep?.({ kind: "refetch" });
      cur = (await d.fetch()) ?? cur;
      continue;
    }
    if (r.status >= 300) {
      cur = (await d.fetch()) ?? cur;
      return { end: { kind: "submit_error", k, response: r }, list: cur };
    }
    cur = (await d.fetch()) ?? cur;
  }
  return { end: { kind: "finished" }, list: cur };
}
