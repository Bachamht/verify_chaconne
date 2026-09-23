/**
 * 资金组 HTTP 层（C8）：POST /v1/budget-groups、GET …/:id、POST …/:id/allocations。
 * 分配走 DbBudgetCoordinator；服务额度（本组预留/占用/支出）与链上额度（授权 budgetCap − spent）分别展示（B-07）。
 * 授权状态同步：COMPLETED → 结清；EXPIRED（链上 deadline 已过）/ REVOKED（链上撤销已确认）→ 释放；
 * CANCELLED（只是服务侧停止签发，D-088）**不释放**——链上仍可能执行已取走的证书。
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyBudgetGroups, verifyBudgetLedger, verifyMandates } from "@chaconne/db";
import { isEvmAddress, isRawAmount, normalizeAddress, type AssetRegistry, type MandateState } from "@chaconne/core/verify";
import { findEntry } from "@chaconne/core/verify";
import { HttpError } from "../jobs/service";
import { newId } from "../ids";
import { assertOwner } from "../portfolio/ownerAuth";
import { DbBudgetCoordinator, groupView, type AllocationView, type ReserveResult } from "./coordinator";
import type { NotifyService } from "../notify/service";

export interface CreateBudgetGroupBody {
  ownerAddress: string;
  name: string;
  inputAssetKey: string;
  periodStart: string;
  periodEnd: string;
  capRaw: string;
  cashFloorRaw?: string;
}
export interface AllocateBody {
  taskId: string;
  mandateId: string;
  priority?: number;
  /** 缺省 = 授权剩余额度（budgetCap − spent） */
  amountRaw?: string;
  attributedPeriod?: { periodStart: string; periodEnd: string };
}

export class BudgetService {
  private readonly now: () => Date;
  constructor(private readonly d: { db: Db; registry: AssetRegistry; coordinator: DbBudgetCoordinator; notify?: NotifyService | null; publicBaseUrl?: string; now?: () => Date }) {
    this.now = d.now ?? (() => new Date());
  }
  get coordinator(): DbBudgetCoordinator {
    return this.d.coordinator;
  }

  async create(callerId: string, raw: unknown) {
    const b = (raw ?? {}) as Partial<CreateBudgetGroupBody>;
    const errors: Array<{ field: string; code: string }> = [];
    if (!isEvmAddress(b.ownerAddress)) errors.push({ field: "ownerAddress", code: "invalid_address" });
    if (typeof b.name !== "string" || b.name.trim().length === 0 || b.name.length > 80) errors.push({ field: "name", code: "required" });
    if (typeof b.inputAssetKey !== "string" || !findEntry(this.d.registry, b.inputAssetKey.toLowerCase())) errors.push({ field: "inputAssetKey", code: "asset_unsupported" });
    else if (findEntry(this.d.registry, b.inputAssetKey.toLowerCase())!.role !== "stable_input") errors.push({ field: "inputAssetKey", code: "must_be_stable_input" });
    const start = typeof b.periodStart === "string" ? Date.parse(b.periodStart) : NaN;
    const end = typeof b.periodEnd === "string" ? Date.parse(b.periodEnd) : NaN;
    if (!Number.isFinite(start)) errors.push({ field: "periodStart", code: "invalid_iso" });
    if (!Number.isFinite(end)) errors.push({ field: "periodEnd", code: "invalid_iso" });
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) errors.push({ field: "periodEnd", code: "must_be_after_start" });
    if (!isRawAmount(b.capRaw) || BigInt(b.capRaw!) <= 0n) errors.push({ field: "capRaw", code: "must_be_positive_raw" });
    if (b.cashFloorRaw !== undefined && !isRawAmount(b.cashFloorRaw)) errors.push({ field: "cashFloorRaw", code: "invalid_raw" });
    if (errors.length > 0) throw new HttpError(400, "invalid_request", "资金组参数校验失败", errors);
    const owner = normalizeAddress(b.ownerAddress!);
    await assertOwner(this.d.db, callerId, owner);
    const now = this.now();
    const [row] = await this.d.db
      .insert(verifyBudgetGroups)
      .values({ id: newId("bgp"), callerId, ownerAddress: owner, name: b.name!.trim(), inputAssetKey: b.inputAssetKey!.toLowerCase(), periodStart: new Date(start), periodEnd: new Date(end), capRaw: b.capRaw!, cashFloorRaw: b.cashFloorRaw ?? "0", priorityRule: "priority_then_created", version: 0, createdAt: now, updatedAt: now })
      .returning();
    return this.view(callerId, row!.id);
  }

  async requireGroup(callerId: string, id: string) {
    const row = (await this.d.db.select().from(verifyBudgetGroups).where(eq(verifyBudgetGroups.id, id)).limit(1))[0];
    if (!row) throw new HttpError(404, "budget_group_not_found");
    await assertOwner(this.d.db, callerId, row.ownerAddress);
    return row;
  }

  async view(callerId: string, id: string) {
    const row = await this.requireGroup(callerId, id);
    await this.syncMandates(id);
    const g = await this.d.coordinator.group(id);
    if (!g) throw new HttpError(404, "budget_group_not_found");
    const mandateIds = g.allocations.map((a) => a.mandateId);
    const mandates = mandateIds.length > 0 ? await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, mandateIds)) : [];
    const ledger = await this.d.db.select().from(verifyBudgetLedger).where(eq(verifyBudgetLedger.groupId, id)).orderBy(desc(verifyBudgetLedger.createdAt)).limit(100);
    return {
      group: groupView(row),
      /** 服务侧账目（不是链上冻结） */
      summary: g.summary,
      invariant: g.invariant,
      allocations: g.allocations.map((a) => {
        const m = mandates.find((x) => x.id === a.mandateId);
        return {
          ...a,
          reasonCode: a.state === "waiting" ? "BUDGET_GROUP_CONFLICT" : null,
          /** 链上额度：授权 budgetCap − 已确认 spent；与服务侧 reserved 分别展示（B-07） */
          onchain: m ? { state: m.state as MandateState, budgetCapRaw: m.budgetCap, spentRaw: m.spent, remainingRaw: (BigInt(m.budgetCap) - BigInt(m.spent)).toString(), stepsDone: m.stepsDone, maxSteps: m.maxSteps, deadline: m.deadline.toISOString() } : null,
        };
      }),
      ledger: ledger.map((l) => ({ id: l.id, kind: l.kind, allocationId: l.allocationId, amountRaw: l.amountRaw, spentAfterRaw: l.spentAfterRaw, reservedAfterRaw: l.reservedAfterRaw, invariantOk: l.invariantOk, detail: l.detail, at: l.createdAt.toISOString() })),
      coordinationScope: "Service-side coordination only (D-086): reservations are not on-chain freezes, do not cover wallet activity outside this service or mandates not registered here, and the real balance is re-checked before every step.",
    };
  }

  /** POST /v1/budget-groups/:id/allocations：注册授权到组，返回 reserved / waiting（waiting → 409） */
  async allocate(callerId: string, id: string, raw: unknown): Promise<{ status: 201 | 409; body: ReserveResult & { onchain: { budgetCapRaw: string; spentRaw: string; remainingRaw: string } } }> {
    const row = await this.requireGroup(callerId, id);
    const b = (raw ?? {}) as Partial<AllocateBody>;
    if (typeof b.taskId !== "string" || !b.taskId) throw new HttpError(400, "invalid_request", "taskId 必填");
    if (typeof b.mandateId !== "string" || !b.mandateId) throw new HttpError(400, "invalid_request", "mandateId 必填");
    const m = (await this.d.db.select().from(verifyMandates).where(eq(verifyMandates.id, b.mandateId)).limit(1))[0];
    if (!m) throw new HttpError(404, "mandate_not_found");
    if (m.ownerAddress.toLowerCase() !== row.ownerAddress.toLowerCase()) throw new HttpError(403, "owner_mismatch", "授权 owner 与资金组 owner 不一致");
    const mj = m.mandateJson as { inputAssetKey: string; side: "buy" | "sell" };
    if (mj.side !== "buy") throw new HttpError(400, "sell_mandate_not_budgeted", "资金组只统计买入支出；卖出授权不占预算，卖出收入也不恢复额度");
    if (mj.inputAssetKey.toLowerCase() !== row.inputAssetKey.toLowerCase()) throw new HttpError(400, "input_asset_mismatch", "授权资金币种与资金组不一致");
    if (!["ACTIVE", "PAUSED", "DRAFT"].includes(m.state)) throw new HttpError(409, "mandate_not_active", `授权状态 ${m.state} 不能再占用预算`);
    const remaining = (BigInt(m.budgetCap) - BigInt(m.spent)).toString();
    const amountRaw = b.amountRaw ?? remaining;
    if (!isRawAmount(amountRaw) || BigInt(amountRaw) > BigInt(remaining)) throw new HttpError(400, "invalid_request", "amountRaw 不能超过授权剩余额度", { remainingRaw: remaining });
    const r = await this.d.coordinator.reserve({ groupId: id, taskId: b.taskId, mandateId: b.mandateId, amountRaw, priority: b.priority ?? 100, mandateDeadline: m.deadline.toISOString(), mandateValidFrom: m.validFrom.toISOString(), attributedPeriod: b.attributedPeriod });
    if (r.state === "waiting" && this.d.notify) {
      await this.d.notify.notify("budget.conflict", b.taskId, r.groupVersion, `Budget group ${row.name}: mandate ${b.mandateId} is waiting for ${amountRaw} (schedulable ${r.schedulableRaw}).`, `${this.d.publicBaseUrl ?? ""}/v1/budget-groups/${id}`, row.ownerAddress);
    }
    return { status: r.state === "reserved" ? 201 : 409, body: { ...r, onchain: { budgetCapRaw: m.budgetCap, spentRaw: m.spent, remainingRaw: remaining } } };
  }

  /**
   * 授权状态 → 账目（每次读组时跑一次；monitor 也可调用）。
   * 只认链上事实：EXPIRED（deadline 已过）、REVOKED（链上撤销已确认）、COMPLETED（步骤全部确认）。
   */
  async syncMandates(groupId: string): Promise<{ released: string[]; promoted: string[] }> {
    const g = await this.d.coordinator.group(groupId);
    if (!g) return { released: [], promoted: [] };
    const open = g.allocations.filter((a) => a.state === "reserved" || a.state === "waiting");
    if (open.length === 0) return { released: [], promoted: [] };
    const mandates = await this.d.db.select().from(verifyMandates).where(and(inArray(verifyMandates.id, open.map((a) => a.mandateId)), inArray(verifyMandates.state, ["EXPIRED", "REVOKED", "COMPLETED"])));
    const released: string[] = [];
    const promoted: string[] = [];
    for (const m of mandates) {
      const alloc = open.find((a) => a.mandateId === m.id)!;
      const reason = m.state === "REVOKED" ? "revoked" : m.state === "EXPIRED" ? "expired" : "completed";
      if (alloc.state === "waiting") {
        // waiting 没占任何额度：直接标记释放
        const r = await this.d.coordinator.release(m.id, reason, { force: true });
        if (r.released) released.push(m.id);
        continue;
      }
      const r = await this.d.coordinator.release(m.id, reason);
      if (r.released) {
        released.push(m.id);
        promoted.push(...r.promoted);
        if (this.d.notify) {
          const after = await this.d.coordinator.group(groupId);
          await this.d.notify.notify("budget.released", alloc.taskId, after?.group.version ?? 0, `Budget group ${g.group.name}: reservation of mandate ${m.id} released (${reason}).`, `${this.d.publicBaseUrl ?? ""}/v1/budget-groups/${groupId}`, g.group.owner);
        }
      }
    }
    return { released, promoted };
  }

  /** 组合视图：某 owner 的全部组 */
  async groupsForOwner(owner: string) {
    const rows = await this.d.db.select().from(verifyBudgetGroups).where(eq(verifyBudgetGroups.ownerAddress, owner.toLowerCase())).orderBy(desc(verifyBudgetGroups.createdAt));
    const out: Array<{ group: ReturnType<typeof groupView>; summary: Awaited<ReturnType<DbBudgetCoordinator["group"]>> extends infer R ? (R extends { summary: infer S } ? S : never) : never; allocations: AllocationView[] }> = [];
    for (const r of rows) {
      await this.syncMandates(r.id);
      const g = await this.d.coordinator.group(r.id);
      if (g) out.push({ group: groupView(r), summary: g.summary, allocations: g.allocations });
    }
    return out;
  }
}
