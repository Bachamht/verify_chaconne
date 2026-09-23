/**
 * 组合视图（C4）：GET /v1/portfolio/:owner、POST /v1/portfolio/:owner/cost-overrides。
 *  - 余额与区块号：登记表全部资产一次快照（Q-01）→ `portfolio_snapshot` 证据；
 *  - 成本：只覆盖平台可追溯成交（v1 GuardedExecution / v2 MandateStep 事件值），coverage = traced / balance；
 *    外部转入 → unknownQtyRaw；外部转出 → externalOutflowRaw（Q-02）；
 *  - 发行商乘数调整：成交时证据里的 ratio（token_meta.multiplier / okx_rwa_token.ratio）vs 快照乘数 → 换算并标注（Q-04）；
 *  - 自报成本：source 固定 user_reported，与可追溯成本分开展示，绝不混进 coverage（Q-03）；
 *  - 各授权剩余额度（链上口径）、资金组占用（服务侧口径）、现金、执行器在线态（B-07 / Q-08）。
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyCostOverrides, verifyEvidence, verifyExecutionAttempts, verifyJobs, verifyMandateEvaluations, verifyMandateSteps, verifyMandates } from "@chaconne/db";
import { findEntry, hashCanonical, isEvmAddress, isRawAmount, type AssetRegistry, type EvidenceRecord, type EvmAddress, type MandateState, type NormalizedJob, type PortfolioSnapshotEvidence, type RegistryEntry } from "@chaconne/core/verify";
import { adjustForRatio, aggregateFills, costCoverage, type TracedFill } from "@chaconne/core/verify/budget/index";
import { HttpError } from "../jobs/service";
import { newId } from "../ids";
import { assertOwner } from "./ownerAuth";
import type { PortfolioReader } from "./chain";
import type { BudgetService } from "../budget/service";
import type { NotifyService } from "../notify/service";
import type { XLayerMarket } from "../market/xlayer";
import type { MandateJson } from "../mandates/service";

export interface PriceSource {
  readonly kind: "market" | "static" | "none";
  pricesUsd(entries: RegistryEntry[]): Promise<Map<string, string | null>>;
}
export const noPriceSource: PriceSource = { kind: "none", pricesUsd: async (entries) => new Map(entries.map((e) => [e.assetKey, null])) };
export function staticPriceSource(map: Record<string, string | null>): PriceSource {
  return { kind: "static", pricesUsd: async (entries) => new Map(entries.map((e) => [e.assetKey, map[e.assetKey] ?? map[e.assetKey.toLowerCase()] ?? null])) };
}
/** 公开行情快照（OKX 报价中间价）作为组合估值来源；拿不到 → null */
export function marketPriceSource(market: XLayerMarket): PriceSource {
  return {
    kind: "market",
    async pricesUsd(entries) {
      const snap = await market.snapshot().catch(() => null);
      const out = new Map<string, string | null>();
      for (const e of entries) {
        if (e.role === "stable_input") {
          out.set(e.assetKey, "1");
          continue;
        }
        const t = snap?.tokens.find((x) => x.address.toLowerCase() === e.tokenAddress.toLowerCase());
        out.set(e.assetKey, t && t.priceUsd !== null ? String(t.priceUsd) : null);
      }
      return out;
    },
  };
}

interface FillRecord extends TracedFill {
  assetKey: string;
  ref: { kind: "job" | "mandate"; id: string; stepIndex: number | null; txHash: string | null };
  ratioAtFill: string | null;
  inputAssetKey: string;
}

function ratioFromEvidence(evidence: EvidenceRecord[] | null | undefined, tokenAddress: string): string | null {
  if (!Array.isArray(evidence)) return null;
  for (const e of evidence) {
    const p = e.payload;
    if (p.kind === "token_meta" && p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() && p.multiplier) return p.multiplier;
  }
  for (const e of evidence) {
    const p = e.payload;
    if (p.kind === "okx_rwa_token" && p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase() && p.ratio) return p.ratio;
  }
  return null;
}

export class PortfolioService {
  private readonly now: () => Date;
  constructor(private readonly d: { db: Db; registry: AssetRegistry; reader: PortfolioReader; prices: PriceSource; budget?: BudgetService | null; notify?: NotifyService | null; evidenceMode: "LIVE" | "FIXTURE"; now?: () => Date }) {
    this.now = d.now ?? (() => new Date());
  }
  get priceSourceKind(): PriceSource["kind"] {
    return this.d.prices.kind;
  }

  /* ---------- 平台可追溯成交 ---------- */
  async tracedFills(owner: string): Promise<FillRecord[]> {
    const o = owner.toLowerCase();
    const out: FillRecord[] = [];
    const byToken = (addr: string) => this.d.registry.entries.find((e) => e.tokenAddress.toLowerCase() === addr.toLowerCase()) ?? null;

    // v1：单笔任务（GuardedExecution）
    const jobs = await this.d.db.select({ id: verifyJobs.id, jobJson: verifyJobs.jobJson }).from(verifyJobs).where(eq(verifyJobs.ownerAddress, o));
    if (jobs.length > 0) {
      const attempts = await this.d.db.select().from(verifyExecutionAttempts).where(and(inArray(verifyExecutionAttempts.jobId, jobs.map((j) => j.id)), eq(verifyExecutionAttempts.state, "CONFIRMED")));
      for (const a of attempts) {
        const job = jobs.find((j) => j.id === a.jobId)!.jobJson as NormalizedJob;
        const ev = (a.receiptJson as { event?: { spent?: string; received?: string } } | null)?.event;
        if (!ev || !isRawAmount(ev.spent) || !isRawAmount(ev.received)) continue;
        const side = job.side === "sell" ? "sell" : "buy";
        const stockKey = side === "buy" ? job.outputAssetKey : job.inputAssetKey;
        const stableKey = side === "buy" ? job.inputAssetKey : job.outputAssetKey;
        const stock = findEntry(this.d.registry, stockKey);
        const evidence = await this.d.db.select({ record: verifyEvidence.record }).from(verifyEvidence).where(and(eq(verifyEvidence.jobId, a.jobId), eq(verifyEvidence.reportVersion, a.reportVersion)));
        out.push({ assetKey: stockKey, side, qtyRaw: side === "buy" ? ev.received : ev.spent, inputRaw: side === "buy" ? ev.spent : ev.received, ref: { kind: "job", id: a.jobId, stepIndex: null, txHash: a.txHash }, ratioAtFill: stock ? ratioFromEvidence(evidence.map((x) => x.record as EvidenceRecord), stock.tokenAddress) : null, inputAssetKey: stableKey });
      }
    }
    // v2：授权计划步骤（MandateStep）
    const mandates = await this.d.db.select().from(verifyMandates).where(eq(verifyMandates.ownerAddress, o));
    if (mandates.length > 0) {
      const steps = await this.d.db.select().from(verifyMandateSteps).where(and(inArray(verifyMandateSteps.mandateId, mandates.map((m) => m.id)), eq(verifyMandateSteps.state, "CONFIRMED")));
      for (const s of steps) {
        const m = mandates.find((x) => x.id === s.mandateId)!;
        const mj = m.mandateJson as MandateJson;
        const ev = (s.receiptJson as { event?: { spent?: string; received?: string; outputToken?: string } } | null)?.event;
        if (!ev || !isRawAmount(ev.spent) || !isRawAmount(ev.received)) continue;
        const sj = s.stepJson as { step: { outputToken: string } };
        const side = mj.side;
        const stock = side === "buy" ? byToken(sj.step.outputToken) : findEntry(this.d.registry, mj.legs[0]?.outputAssetKey ?? "");
        if (!stock) continue;
        const evidence = s.evaluationId ? (await this.d.db.select({ evidenceJson: verifyMandateEvaluations.evidenceJson }).from(verifyMandateEvaluations).where(eq(verifyMandateEvaluations.id, s.evaluationId)).limit(1))[0]?.evidenceJson : null;
        out.push({ assetKey: stock.assetKey, side, qtyRaw: side === "buy" ? ev.received : ev.spent, inputRaw: side === "buy" ? ev.spent : ev.received, ref: { kind: "mandate", id: m.id, stepIndex: s.stepIndex, txHash: s.txHash }, ratioAtFill: ratioFromEvidence(evidence as EvidenceRecord[] | null, stock.tokenAddress), inputAssetKey: mj.inputAssetKey });
      }
    }
    return out;
  }

  /* ---------- 快照 + 视图 ---------- */
  async snapshot(owner: string) {
    const o = owner.toLowerCase();
    const chain = await this.d.reader.snapshot(o, this.d.registry);
    const fills = await this.tracedFills(o);
    const prices = await this.d.prices.pricesUsd(this.d.registry.entries);
    const overrides = await this.d.db.select().from(verifyCostOverrides).where(eq(verifyCostOverrides.ownerAddress, o)).orderBy(desc(verifyCostOverrides.createdAt));

    const cash: Array<{ assetKey: string; symbol: string; balanceRaw: string; decimals: number; unavailable: boolean }> = [];
    const holdings: Array<Record<string, unknown> & { assetKey: string; balanceRaw: string; tracedQtyRaw: string | null }> = [];
    for (const e of this.d.registry.entries) {
      const b = chain.balances.find((x) => x.assetKey === e.assetKey);
      const balanceRaw = b?.balanceRaw ?? "0";
      const unavailable = b?.unavailable ?? true;
      if (e.role === "stable_input") {
        cash.push({ assetKey: e.assetKey, symbol: e.displaySymbol, balanceRaw, decimals: e.tokenDecimals, unavailable });
        continue;
      }
      const assetFills = fills.filter((f) => f.assetKey === e.assetKey);
      const ratioNow = b?.multiplier ?? null;
      let ratioNote: "not_rebasing" | "ratio_unknown" | "adjusted" | "unchanged" = e.tokenForm === "rebasing" ? "ratio_unknown" : "not_rebasing";
      const adjustedFills: TracedFill[] = assetFills.map((f) => {
        if (e.tokenForm !== "rebasing") return f;
        const adj = adjustForRatio(f.qtyRaw, f.ratioAtFill, ratioNow);
        if (!adj) return f;
        if (ratioNote !== "adjusted") ratioNote = adj.changed ? "adjusted" : "unchanged";
        return { ...f, qtyRaw: adj.adjustedQtyRaw };
      });
      const agg = aggregateFills(adjustedFills);
      const cov = costCoverage(balanceRaw, agg.tracedQtyRaw);
      const userReported = overrides.filter((x) => x.assetKey === e.assetKey);
      const urQty = userReported.reduce((s, x) => s + BigInt(x.qtyRaw), 0n);
      const urCost = userReported.reduce((s, x) => s + BigInt(x.costRaw), 0n);
      const price = prices.get(e.assetKey) ?? null;
      const zero = assetFills.length === 0 && BigInt(balanceRaw) === 0n && userReported.length === 0;
      if (zero) continue;
      holdings.push({
        assetKey: e.assetKey,
        symbol: e.displaySymbol,
        underlyingId: e.underlyingId,
        decimals: e.tokenDecimals,
        tokenForm: e.tokenForm,
        balanceRaw,
        unavailable,
        priceUsd: price,
        priceSource: this.d.prices.kind,
        traced: {
          qtyRaw: agg.tracedQtyRaw,
          costRaw: agg.costRaw,
          costAssetKey: assetFills[0]?.inputAssetKey ?? null,
          fills: assetFills.map((f) => ({ ref: f.ref, side: f.side, qtyRaw: f.qtyRaw, inputRaw: f.inputRaw, ratioAtFill: f.ratioAtFill })),
          ratio: { note: ratioNote, ratioNow, adjustedByFill: assetFills.map((f) => f.ratioAtFill) },
        },
        coverage: { coverageBps: cov.coverageBps, unknownQtyRaw: cov.unknownQtyRaw, externalOutflowRaw: cov.externalOutflowRaw, note: cov.coverageBps === null ? "no_balance" : cov.coverageBps < 10_000 ? "cost_unknown_for_part_of_balance" : "fully_traced" },
        userReported: userReported.length > 0 ? { source: "user_reported", qtyRaw: urQty.toString(), costRaw: urCost.toString(), entries: userReported.map((x) => ({ id: x.id, qtyRaw: x.qtyRaw, costRaw: x.costRaw, inputAssetKey: x.inputAssetKey, note: x.note, at: x.createdAt.toISOString() })), note: "Self-reported by the user; not verified on-chain and never merged into traced coverage." } : null,
        tracedQtyRaw: agg.tracedQtyRaw,
      });
    }
    const payload: PortfolioSnapshotEvidence = { kind: "portfolio_snapshot", owner: o as EvmAddress, chainId: chain.chainId, blockNumber: Number(chain.blockNumber), holdings: holdings.map((h) => ({ assetKey: h.assetKey, balanceRaw: h.balanceRaw, tracedQtyRaw: h.tracedQtyRaw })) };
    const evidence: EvidenceRecord = {
      evidenceId: newId("ev"),
      provider: this.d.evidenceMode === "LIVE" ? "xlayer-rpc" : "fixture",
      endpoint: `eth_call:erc20(balanceOf)x${this.d.registry.entries.length}+getCurrentMultiplier()@block`,
      requestFingerprint: `${chain.chainId}:${o}:${chain.blockNumber}`,
      time: { requestedAt: chain.requestedAt, receivedAt: chain.receivedAt, sourcePublishedAt: chain.blockTimestamp, sourceTimeKind: chain.blockTimestamp ? "block" : "not_provided" },
      block: { chainId: chain.chainId, blockNumber: chain.blockNumber, blockHash: (chain.blockHash as `0x${string}` | null) ?? null, blockTimestamp: chain.blockTimestamp },
      rawHash: hashCanonical({ balances: chain.balances, blockNumber: chain.blockNumber }),
      parserVersion: "portfolio-snapshot/1",
      mode: this.d.evidenceMode,
      payload,
    };
    return { chain, cash, holdings, evidence, prices };
  }

  async view(callerId: string, owner: string) {
    const o = await assertOwner(this.d.db, callerId, owner);
    const snap = await this.snapshot(o);
    const mandates = await this.d.db.select().from(verifyMandates).where(eq(verifyMandates.ownerAddress, o)).orderBy(desc(verifyMandates.createdAt));
    const allocations = this.d.budget ? await this.d.budget.coordinator.allocationsFor(mandates.map((m) => m.id)) : [];
    const presence = this.d.notify ? await this.d.notify.presenceMany(mandates.map((m) => m.id)) : new Map();
    const groups = this.d.budget ? await this.d.budget.groupsForOwner(o) : [];
    return {
      owner: o,
      chainId: snap.chain.chainId,
      block: { number: snap.chain.blockNumber, hash: snap.chain.blockHash, timestamp: snap.chain.blockTimestamp },
      evidence: snap.evidence,
      cash: snap.cash,
      holdings: snap.holdings.map(({ tracedQtyRaw: _t, ...h }) => h),
      authorizations: mandates.map((m) => {
        const mj = m.mandateJson as MandateJson;
        const alloc = allocations.find((a) => a.mandateId === m.id) ?? null;
        return {
          mandateId: m.id,
          state: m.state as MandateState,
          side: mj.side,
          inputAssetKey: mj.inputAssetKey,
          legs: mj.legs,
          /** 链上口径：授权本身的额度（PlanGuard 按 budgetCap 限制，spent 来自已确认回执） */
          onchain: { budgetCapRaw: m.budgetCap, spentRaw: m.spent, remainingRaw: (BigInt(m.budgetCap) - BigInt(m.spent)).toString(), stepsDone: m.stepsDone, maxSteps: m.maxSteps, validFrom: m.validFrom.toISOString(), deadline: m.deadline.toISOString() },
          /** 服务侧口径：资金组内的预留/在途/支出（不是链上冻结） */
          service: alloc ? { groupId: alloc.groupId, state: alloc.state, reservedRaw: alloc.reservedRaw, pendingRaw: alloc.pendingRaw, spentRaw: alloc.spentRaw, requestedRaw: alloc.requestedRaw } : null,
          executor: presence.get(m.id) ?? null,
        };
      }),
      budgetGroups: groups.map((g) => ({ groupId: g.group.id, name: g.group.name, inputAssetKey: g.group.inputAssetKey, period: { start: g.group.periodStart, end: g.group.periodEnd }, capRaw: g.group.capRaw, cashFloorRaw: g.group.cashFloorRaw, summary: g.summary, allocations: g.allocations.map((a) => ({ mandateId: a.mandateId, taskId: a.taskId, state: a.state, reservedRaw: a.reservedRaw, pendingRaw: a.pendingRaw, spentRaw: a.spentRaw, priority: a.priority })) })),
      notes: {
        cost: "Cost covers only fills executed through this service (GuardedExecution / MandateStep events). Balance not traced to a fill has unknown cost; platform cost is never spread over the whole wallet.",
        budget: "Budget-group figures are service-side coordination (D-086), not on-chain freezes; the real balance is re-checked before each step.",
        executor: "online = heartbeat within 3 minutes; awaiting_signature = browser-wallet path; offline = neither. Informational only.",
      },
    };
  }

  /* ---------- 自报成本（Q-03） ---------- */
  async addCostOverride(callerId: string, owner: string, raw: unknown) {
    const o = await assertOwner(this.d.db, callerId, owner);
    const b = (raw ?? {}) as { assetKey?: string; qtyRaw?: string; costRaw?: string; inputAssetKey?: string; note?: string };
    const errors: Array<{ field: string; code: string }> = [];
    const asset = typeof b.assetKey === "string" ? findEntry(this.d.registry, b.assetKey.toLowerCase()) : null;
    if (!asset || asset.role !== "stock_output") errors.push({ field: "assetKey", code: "asset_unsupported" });
    const input = typeof b.inputAssetKey === "string" ? findEntry(this.d.registry, b.inputAssetKey.toLowerCase()) : null;
    if (!input || input.role !== "stable_input") errors.push({ field: "inputAssetKey", code: "must_be_stable_input" });
    if (!isRawAmount(b.qtyRaw) || BigInt(b.qtyRaw!) <= 0n) errors.push({ field: "qtyRaw", code: "must_be_positive_raw" });
    if (!isRawAmount(b.costRaw)) errors.push({ field: "costRaw", code: "invalid_raw" });
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 200)) errors.push({ field: "note", code: "too_long" });
    if (errors.length > 0) throw new HttpError(400, "invalid_request", "自报成本参数校验失败", errors);
    if (!isEvmAddress(o)) throw new HttpError(400, "invalid_owner");
    const now = this.now();
    const [row] = await this.d.db.insert(verifyCostOverrides).values({ id: newId("ovr"), callerId, ownerAddress: o, assetKey: asset!.assetKey, qtyRaw: b.qtyRaw!, costRaw: b.costRaw!, inputAssetKey: input!.assetKey, source: "user_reported", note: b.note ?? null, createdAt: now }).returning();
    return { override: { id: row!.id, owner: o, assetKey: row!.assetKey, qtyRaw: row!.qtyRaw, costRaw: row!.costRaw, inputAssetKey: row!.inputAssetKey, source: "user_reported" as const, note: row!.note, createdAt: row!.createdAt.toISOString() }, note: "Marked user_reported: not verified on-chain, shown separately from traced cost and never counted in coverage." };
  }
}
