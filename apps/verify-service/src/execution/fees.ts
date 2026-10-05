/**
 * 执行身份费用预算（D-089 修订，运营者确认 2026-10-02 14:00：主要保护是费用而不是笔数）。verify-service 是权威方。
 *
 *   预留   发送提交点（CLAIMED → SENDING）同一事务里：解析签名交易 → gasLimit × maxFeePerGas（解析不了按 FEE_MAX_PER_TX_WEI）；
 *          超 FEE_MAX_PER_TX_WEI → fee_cap_exceeded；按 owner/日、任务累计、平台/日三个预算核对 → 超限 fee_budget_exhausted；通过则写 RESERVED。
 *          三个预算的核对与写入在 pg_advisory_xact_lock 之下串行（并发提交不会一起越过上限）。
 *   结算   作业从 SENDING / SENT 到 CONFIRMED / REVERTED → 读回执：gasUsed × effectiveGasPrice + l1Fee → SETTLED；回执暂不可读 → 保持 RESERVED，清扫器重试。
 *   占用   广播后结果不明（SENDING / SENT 转 EXPIRED / FAILED）→ HELD，继续按预留额计入（交易仍可能上链扣费）；之后读到回执再按实际结算。
 *   释放   只有从未广播的情况才不计费：预留只发生在发送提交点，提交点之前的过期 / 取消本来就没有记录；HELD / RESERVED 不会自动释放。
 * 计入口径：RESERVED / HELD 按 reserved_wei，SETTLED 按 actual_wei，RELEASED 为 0。成功、链上失败、permit 代付全部计入。
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Hex } from "viem";
import type { Db } from "@chaconne/db";
import { verifyExecutionJobs, verifyFeeLedger } from "@chaconne/db";
import { maxFeeOfRawTx } from "@chaconne/verify-exec";
import type { VerifyConfig } from "../config";
import { log } from "../log";
import type { ServiceChain } from "./chain";

type JobRow = typeof verifyExecutionJobs.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type FeeRow = typeof verifyFeeLedger.$inferSelect;

/** 费用预算与限频共用的事务级咨询锁键（全平台一把：执行量很小，串行足够） */
export const FEE_BUDGET_LOCK_KEY = 726_100_089;
/** 运营者侧代码（作业以它们终止时：不开 Agent 轮次、不让 owner 去签名，报 needsOperator） */
export const FEE_OPERATOR_CODES: ReadonlySet<string> = new Set(["fee_budget_exhausted", "fee_cap_exceeded"]);

export type FeeScope = "owner_day" | "task_total" | "platform_day";
export interface FeeLimits {
  perOwnerDayWei: bigint;
  perTaskWei: bigint;
  platformDayWei: bigint;
  maxPerTxWei: bigint;
}
export type ReserveResult =
  | { ok: true; row: FeeRow; reservedWei: bigint }
  | { ok: false; code: "fee_budget_exhausted" | "fee_cap_exceeded"; scope: FeeScope | "per_tx"; usedWei: string; limitWei: string; needWei: string; message: string };

const COUNTED = sql`COALESCE(SUM(CASE WHEN ${verifyFeeLedger.state} IN ('RESERVED','HELD') THEN ${verifyFeeLedger.reservedWei} WHEN ${verifyFeeLedger.state} = 'SETTLED' THEN ${verifyFeeLedger.actualWei} ELSE 0 END), 0)::text`;

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const okb = (wei: bigint): string => {
  const s = wei.toString().padStart(19, "0");
  const f = s.slice(-18).replace(/0+$/, "");
  return `${s.slice(0, -18)}${f ? `.${f}` : ""}`;
};

export class FeeBudget {
  private readonly now: () => Date;
  private readonly heldTriedAt = new Map<string, number>();
  constructor(private readonly d: { db: Db; cfg: VerifyConfig; chain: ServiceChain | null; now?: () => Date; operatorAlert?: ((code: string, text: string) => Promise<unknown>) | null }) {
    this.now = d.now ?? (() => new Date());
  }
  limits(): FeeLimits {
    return this.d.cfg.feeBudget;
  }

  /** 三个口径的已用（在锁内调用才是一致读） */
  async usage(q: Db | Tx, a: { owner: string; taskId: string | null; day: string }): Promise<Record<FeeScope, bigint>> {
    const one = async (where: ReturnType<typeof and>) => BigInt(((await q.select({ v: COUNTED }).from(verifyFeeLedger).where(where))[0]?.v as string | undefined) ?? "0");
    // 顺序执行（同一事务连接）
    const ownerDay = await one(and(eq(verifyFeeLedger.ownerAddress, a.owner.toLowerCase()), eq(verifyFeeLedger.day, a.day)));
    const platformDay = await one(and(eq(verifyFeeLedger.day, a.day)));
    const taskTotal = a.taskId ? await one(and(eq(verifyFeeLedger.taskId, a.taskId))) : 0n;
    return { owner_day: ownerDay, task_total: taskTotal, platform_day: platformDay };
  }

  /** 第一个会被 need 撑破的预算；都够 → null */
  private overBudget(used: Record<FeeScope, bigint>, need: bigint, hasTask: boolean): { scope: FeeScope; used: bigint; limit: bigint } | null {
    const L = this.limits();
    const checks: Array<[FeeScope, bigint]> = [["owner_day", L.perOwnerDayWei], ...(hasTask ? ([["task_total", L.perTaskWei]] as Array<[FeeScope, bigint]>) : []), ["platform_day", L.platformDayWei]];
    for (const [scope, limit] of checks) if (used[scope] + need > limit) return { scope, used: used[scope], limit };
    return null;
  }

  async lock(tx: Tx): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${FEE_BUDGET_LOCK_KEY})`);
  }

  /** 预留（发送提交点；调用方在同一事务里把作业转 SENDING）。不通过 → 不写任何东西 */
  async reserveInTx(tx: Tx, j: JobRow, rawTx: string | null): Promise<ReserveResult> {
    const L = this.limits();
    const parsed = rawTx ? maxFeeOfRawTx(rawTx as Hex) : null;
    const need = parsed ? parsed.maxFeeWei : L.maxPerTxWei;
    if (parsed && parsed.maxFeeWei > L.maxPerTxWei) return { ok: false, code: "fee_cap_exceeded", scope: "per_tx", usedWei: "0", limitWei: L.maxPerTxWei.toString(), needWei: need.toString(), message: `signed transaction may cost up to ${parsed.maxFeeWei} wei (gas ${parsed.gas} × maxFeePerGas ${parsed.maxFeePerGas}), above FEE_MAX_PER_TX_WEI ${L.maxPerTxWei}` };
    await this.lock(tx);
    const nowDate = this.now();
    const day = utcDay(nowDate);
    const existing = (await tx.select().from(verifyFeeLedger).where(eq(verifyFeeLedger.jobId, j.id)).limit(1))[0];
    if (existing) return { ok: true, row: existing, reservedWei: BigInt(existing.reservedWei) };
    const used = await this.usage(tx, { owner: j.ownerAddress, taskId: j.taskId, day });
    const over = this.overBudget(used, need, !!j.taskId);
    if (over) return { ok: false, code: "fee_budget_exhausted", scope: over.scope, usedWei: over.used.toString(), limitWei: over.limit.toString(), needWei: need.toString(), message: `transaction-fee budget ${over.scope} would be exceeded: used ${over.used} + this transaction up to ${need} > ${over.limit} wei` };
    const [row] = await tx
      .insert(verifyFeeLedger)
      .values({ id: `fee_${randomBytes(12).toString("hex")}`, jobId: j.id, kind: j.kind, taskId: j.taskId, ownerAddress: j.ownerAddress.toLowerCase(), mandateId: j.mandateId, stepIndex: j.stepIndex, executor: j.claimedBy, day, state: "RESERVED", reservedWei: need.toString(), actualWei: null, reserveBasis: parsed ? "raw_tx" : "per_tx_cap", gasLimit: parsed?.gas.toString() ?? null, maxFeePerGas: parsed?.maxFeePerGas.toString() ?? null, rawTxHash: j.rawTxHash, txHash: null, createdAt: nowDate, updatedAt: nowDate })
      .returning();
    return { ok: true, row: row!, reservedWei: need };
  }

  /** 预检（permit 代付受理时，与限频同一事务）：按每笔上限看三个预算是否还有余量；不写入 */
  async precheckInTx(tx: Tx, a: { owner: string; taskId: string | null }): Promise<Extract<ReserveResult, { ok: false }> | null> {
    await this.lock(tx);
    const need = this.limits().maxPerTxWei;
    const used = await this.usage(tx, { owner: a.owner, taskId: a.taskId, day: utcDay(this.now()) });
    const over = this.overBudget(used, need, !!a.taskId);
    return over ? { ok: false, code: "fee_budget_exhausted", scope: over.scope, usedWei: over.used.toString(), limitWei: over.limit.toString(), needWei: need.toString(), message: `transaction-fee budget ${over.scope} has no room for another relayed transaction` } : null;
  }

  /** 作业从 SENDING / SENT 进入终态（ExecutionJobs.move 调） */
  async onJobTerminal(j: JobRow, to: string): Promise<void> {
    const row = (await this.d.db.select().from(verifyFeeLedger).where(eq(verifyFeeLedger.jobId, j.id)).limit(1))[0];
    if (!row || row.state === "SETTLED" || row.state === "RELEASED") return;
    const nowDate = this.now();
    const hash = j.txHash ?? j.rawTxHash ?? row.rawTxHash;
    if (to === "CONFIRMED" || to === "REVERTED") {
      await this.d.db.update(verifyFeeLedger).set({ outcome: to.toLowerCase(), txHash: hash, updatedAt: nowDate }).where(eq(verifyFeeLedger.id, row.id));
      await this.trySettle({ ...row, outcome: to.toLowerCase(), txHash: hash });
      return;
    }
    if (to === "CANCELLED") {
      // 不可达（SENDING 之后不能取消）；保险起见：仍按预留占用，不释放
      log.warn("费用账本：已广播作业被取消？保持占用", { jobId: j.id });
    }
    await this.d.db.update(verifyFeeLedger).set({ state: "HELD", outcome: "unknown_after_send", txHash: hash, updatedAt: nowDate }).where(and(eq(verifyFeeLedger.id, row.id), eq(verifyFeeLedger.state, "RESERVED")));
  }

  /** 读回执结算；回执不可读 → 保持原状态，返回 false */
  private async trySettle(row: FeeRow): Promise<boolean> {
    if (!this.d.chain || !row.txHash) return false;
    const r = await this.d.chain.getReceipt(row.txHash as Hex).catch(() => null);
    if (!r) return false;
    const egp = r.effectiveGasPrice;
    const l1 = r.l1Fee ?? 0n;
    // 回执缺少 effectiveGasPrice（非标准 RPC）→ 按预留额结算（保守，宁多计不少计）
    const actual = egp !== undefined ? r.gasUsed * egp + l1 : BigInt(row.reservedWei);
    const nowDate = this.now();
    await this.d.db
      .update(verifyFeeLedger)
      .set({ state: "SETTLED", actualWei: actual.toString(), gasUsed: r.gasUsed.toString(), effectiveGasPrice: egp?.toString() ?? null, l1Fee: r.l1Fee?.toString() ?? null, outcome: row.outcome ?? (r.status === "success" ? "confirmed" : "reverted"), settledAt: nowDate, updatedAt: nowDate })
      .where(and(eq(verifyFeeLedger.id, row.id), inArray(verifyFeeLedger.state, ["RESERVED", "HELD"])));
    return true;
  }

  /** 清扫器：已终结作业的 RESERVED 行与 48 h 内的 HELD 行重试结算 */
  async settlePending(): Promise<number> {
    const since = new Date(this.now().getTime() - 48 * 3600_000);
    const rows = await this.d.db.select().from(verifyFeeLedger).where(and(inArray(verifyFeeLedger.state, ["RESERVED", "HELD"]), gte(verifyFeeLedger.createdAt, since)));
    let n = 0;
    const nowMs = this.now().getTime();
    for (const row of rows) {
      // HELD（结果不明）每行最多 30 s 查一次回执，避免每 2 s 打一遍 RPC
      if (row.state === "HELD") {
        const last = this.heldTriedAt.get(row.id);
        if (last !== undefined && nowMs - last < 30_000) continue;
        this.heldTriedAt.set(row.id, nowMs);
      }
      const job =(await this.d.db.select({ state: verifyExecutionJobs.state, txHash: verifyExecutionJobs.txHash, rawTxHash: verifyExecutionJobs.rawTxHash }).from(verifyExecutionJobs).where(eq(verifyExecutionJobs.id, row.jobId)).limit(1))[0];
      if (row.state === "RESERVED" && job && ["SENDING", "SENT"].includes(job.state)) continue; // 结果未定：继续占用
      const hash = row.txHash ?? job?.txHash ?? job?.rawTxHash ?? row.rawTxHash;
      if (await this.trySettle({ ...row, txHash: hash })) n += 1;
    }
    return n;
  }

  /** 超限 / 超上限：运营者告警（owner 侧的人话由任务时间线负责） */
  async alertOperator(code: string, detail: string): Promise<void> {
    await this.d.operatorAlert?.(code, detail).catch(() => undefined);
  }

  /** /v1/ops/status：今日与在途 */
  async status(): Promise<Record<string, unknown>> {
    const L = this.limits();
    const day = utcDay(this.now());
    const platform = BigInt(((await this.d.db.select({ v: COUNTED }).from(verifyFeeLedger).where(eq(verifyFeeLedger.day, day)))[0]?.v as string | undefined) ?? "0");
    const byState = await this.d.db.select({ state: verifyFeeLedger.state, n: sql<number>`count(*)::int`, wei: sql<string>`COALESCE(SUM(${verifyFeeLedger.reservedWei}), 0)::text`, actual: sql<string>`COALESCE(SUM(${verifyFeeLedger.actualWei}), 0)::text` }).from(verifyFeeLedger).where(eq(verifyFeeLedger.day, day)).groupBy(verifyFeeLedger.state);
    const owners = await this.d.db.select({ owner: verifyFeeLedger.ownerAddress, v: COUNTED }).from(verifyFeeLedger).where(eq(verifyFeeLedger.day, day)).groupBy(verifyFeeLedger.ownerAddress);
    const top = owners.map((o) => ({ owner: o.owner, usedWei: String(o.v), limitWei: L.perOwnerDayWei.toString() })).sort((a, b) => (BigInt(b.usedWei) > BigInt(a.usedWei) ? 1 : -1)).slice(0, 20);
    return {
      day,
      unit: "wei (OKB)",
      limits: { perOwnerDayWei: L.perOwnerDayWei.toString(), perTaskWei: L.perTaskWei.toString(), platformDayWei: L.platformDayWei.toString(), maxPerTxWei: L.maxPerTxWei.toString() },
      platformToday: { usedWei: platform.toString(), usedOkb: okb(platform), limitWei: L.platformDayWei.toString(), remainingWei: (L.platformDayWei > platform ? L.platformDayWei - platform : 0n).toString() },
      todayByState: Object.fromEntries(byState.map((r) => [r.state, { count: r.n, reservedWei: r.wei, actualWei: r.actual }])),
      ownersToday: top,
      pauseAfterPaidFailures: this.d.cfg.EXECUTION_PAID_FAILURE_PAUSE_N,
    };
  }
}
