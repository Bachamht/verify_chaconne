/**
 * 委托清单（v7 §2.2）：由（任务草案、已登记授权、permit 记录、链上额度）纯函数生成 DelegationChecklist。
 *
 * - 顺序固定：buy → 各 sell:<asset> → 各 permit:<token>（向导按这个顺序连续签）。
 * - permit 项：本任务该代币最近一条 permit 记录 CONFIRMED → confirmed；SUBMITTED → submitted；
 *   链上额度 ≥ 需要量 → not_needed（省一次签名）；域未核实 → 回退为一笔用户 approve（userTransactions +1，如实计数）；
 *   否则 todo（typedData = GET 时登记的 ISSUED 请求）。
 * - latched：permit 项一旦 confirmed / not_needed 即由服务端记进 delegation_json，此后不随别的任务登记而翻转
 *   （buyReady / sellReady 是本任务事实，不是额度保证；每一步另做实时额度检查）。
 */
import type { DelegationChecklist, DelegationItem, DelegationItemStatus, Eip712TypedData, EvmAddress, Hex, PermitState, RawAmount } from "../contracts";
import { permitNeeded } from "./ledger";

export interface ChecklistText {
  title: { zh: string; en: string };
  explain: { zh: string; en: string };
}
export interface ChecklistMandateInput extends ChecklistText {
  side: "buy" | "sell";
  /** buy = 资金币种；sell = 股票 */
  assetKey: string;
  /** PlanGuard 实际拉取的代币（buy = 资金币种；sell = 股票） */
  token: EvmAddress;
  /** 建任务时的草案；草案生成失败（如 price_unavailable）为 null */
  typedData: Eip712TypedData | null;
  registered: { mandateId: string; state: string } | null;
  error?: { code: string; message: string } | null;
}
export interface ChecklistPermitInput extends ChecklistText {
  token: EvmAddress;
  assetKey: string;
  onchainRaw: RawAmount;
  requiredRaw: RawAmount;
  /** 该代币的 permit 域已核实（配置重算 = 链上 DOMAIN_SEPARATOR） */
  supported: boolean;
  /** 本次 GET 登记的 ISSUED 请求 */
  issued: { permitRequestId: string; typedData: Eip712TypedData } | null;
  /** 本任务该代币最近一条已提交的 permit 记录（ISSUED 之外） */
  latest: { permitId: string; state: PermitState | string; txHash: Hex | null; error?: { code: string; message: string } | null } | null;
  /** (owner, token) 有在途 permit 作业 */
  pendingPermit: boolean;
}
export interface ChecklistInput {
  taskId: string;
  mandates: ChecklistMandateInput[];
  permits: ChecklistPermitInput[];
  /** itemId → 已锁定的 permit 结论 */
  latched?: Record<string, "confirmed" | "not_needed">;
}

export const permitItemId = (token: string) => `permit:${token.toLowerCase()}`;
export const mandateItemId = (side: "buy" | "sell", assetKey: string) => (side === "buy" ? "buy" : `sell:${assetKey.toLowerCase()}`);

function mandateStatus(m: ChecklistMandateInput): DelegationItemStatus {
  if (m.registered) return m.registered.state === "DRAFT" ? "submitted" : "confirmed";
  if (m.error) return "failed";
  return "todo";
}

export function buildDelegationChecklist(input: ChecklistInput): DelegationChecklist {
  const latched = input.latched ?? {};
  const buys = input.mandates.filter((m) => m.side === "buy");
  const sells = input.mandates.filter((m) => m.side === "sell");
  const items: DelegationItem[] = [];
  let userTransactions = 0;
  let signaturesNeeded = 0;
  let signaturesDone = 0;

  for (const m of [...buys, ...sells]) {
    const status = mandateStatus(m);
    items.push({ id: mandateItemId(m.side, m.assetKey), kind: m.side === "buy" ? "mandate_buy" : "mandate_sell", assetKey: m.assetKey.toLowerCase(), title: m.title, explain: m.explain, typedData: status === "failed" ? null : m.typedData, status, ref: m.registered?.mandateId ?? null, ...(m.error && !m.registered ? { error: m.error } : {}) });
    signaturesNeeded += 1;
    if (status === "confirmed" || status === "submitted") signaturesDone += 1;
  }

  // permit 项：按 mandates 的顺序去重（buy 的资金币种在前）
  const order: string[] = [];
  for (const m of [...buys, ...sells]) if (!order.includes(m.token.toLowerCase())) order.push(m.token.toLowerCase());
  const permits = [...input.permits].sort((a, b) => {
    const ia = order.indexOf(a.token.toLowerCase());
    const ib = order.indexOf(b.token.toLowerCase());
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  const permitStatus = new Map<string, DelegationItemStatus>();
  for (const p of permits) {
    const id = permitItemId(p.token);
    let status: DelegationItemStatus;
    let typedData: Eip712TypedData | null = null;
    let error: { code: string; message: string } | undefined;
    let fallback = false;
    if (p.latest?.state === "CONFIRMED") status = "confirmed";
    else if (p.latest?.state === "SUBMITTED") status = "submitted";
    else if (latched[id]) status = latched[id]!;
    else if (!permitNeeded(p.onchainRaw, p.requiredRaw)) status = "not_needed";
    else if (!p.supported) {
      status = "todo";
      fallback = true;
      error = { code: "permit_domain_unverified", message: "permit domain not verified for this token: one approve transaction from your wallet is needed instead" };
    } else if (p.latest?.state === "FAILED") {
      status = p.issued ? "todo" : "failed";
      typedData = p.issued?.typedData ?? null;
      error = p.latest.error ?? { code: "permit_failed", message: "the previous permit did not land on-chain" };
    } else {
      status = "todo";
      typedData = p.issued?.typedData ?? null;
    }
    permitStatus.set(p.token.toLowerCase(), status);
    items.push({ id, kind: "permit", assetKey: p.assetKey.toLowerCase(), title: p.title, explain: p.explain, typedData, ...(typedData && p.issued ? { permitRequestId: p.issued.permitRequestId } : {}), status, ref: p.latest?.permitId ?? null, txHash: p.latest?.txHash ?? null, ...(error ? { error } : {}) });
    if (fallback) userTransactions += 1;
    else if (status !== "not_needed") {
      signaturesNeeded += 1;
      if (status === "confirmed" || status === "submitted") signaturesDone += 1;
    }
  }

  const permitOk = (token: string) => {
    const s = permitStatus.get(token.toLowerCase());
    return s === "confirmed" || s === "not_needed";
  };
  const buy = buys[0];
  const buyReady = !!buy && buy.registered?.state === "ACTIVE" && permitOk(buy.token);
  const sellReady: Record<string, boolean> = {};
  for (const s of sells) sellReady[s.assetKey.toLowerCase()] = s.registered?.state === "ACTIVE" && permitOk(s.token);
  const complete = items.length > 0 && items.every((i) => i.status === "confirmed" || i.status === "not_needed");
  return {
    taskId: input.taskId,
    items,
    counts: { signaturesNeeded, signaturesDone, userTransactions },
    allowances: permits.map((p) => ({ token: p.token.toLowerCase() as EvmAddress, assetKey: p.assetKey.toLowerCase(), onchainRaw: p.onchainRaw, requiredRaw: p.requiredRaw, pendingPermit: p.pendingPermit })),
    buyReady,
    sellReady,
    complete,
  };
}

/** 本次清单里应锁定的 permit 结论（服务端合并进 delegation_json.latched） */
export function checklistLatches(c: DelegationChecklist): Record<string, "confirmed" | "not_needed"> {
  const out: Record<string, "confirmed" | "not_needed"> = {};
  for (const i of c.items) if (i.kind === "permit" && (i.status === "confirmed" || i.status === "not_needed")) out[i.id] = i.status;
  return out;
}
