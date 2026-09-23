/**
 * 链上撤销确认（D-088 的落地面，Lane I 2026-09-23 补接）。
 *
 * 缺口：任务 cancel 只把状态置为 REVOKE_PENDING，`confirmRevoked()` 定义了却没人调；回执核实器也不认
 * `MandateRevoked` 事件——于是「彻底停止以链上撤销确认为准」在服务端从未真正发生，C 的资金组也永远等不到
 * `verify_mandates.state = REVOKED` 去释放预留。
 *
 * 做法：每个 monitor tick，对所有 REVOKE_PENDING 任务，按其授权的 mandateDigest 到 PlanGuard 查
 * `MandateRevoked(owner, mandateDigest)` 日志；查到 → 把授权 state 写成 REVOKED（C 的 syncMandates 据此释放）
 * 并调 `tasks.confirmRevoked(taskId, txHash)`。**只认链上事实**，按钮响应从不算撤销完成。
 * 日志读取抽成接口，生产用 viem getLogs，测试注入假读取器。
 */
import { and, eq, inArray } from "drizzle-orm";
import { createPublicClient, http, parseAbiItem, type Hex } from "viem";
import { verifyMandates } from "@chaconne/db";
import type { Db } from "../db";
import { log } from "../log";
import type { TasksService } from "./service";

export interface RevokedLogReader {
  /** 给定一组 mandateDigest（小写 0x…），返回链上已撤销者的 digest → txHash */
  revoked(digests: readonly Hex[]): Promise<Map<Hex, Hex>>;
}

export const MANDATE_REVOKED_EVENT = parseAbiItem("event MandateRevoked(address indexed owner, bytes32 indexed mandateDigest)");

/** 生产读取器：直接问 PlanGuard 的事件日志（fromBlock 缺省从 PlanGuard 部署高度附近起，避免全链扫描） */
export function viemRevokedLogReader(opts: { rpcUrl: string; planGuard: Hex; fromBlock?: bigint }): RevokedLogReader {
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  return {
    async revoked(digests) {
      const out = new Map<Hex, Hex>();
      if (digests.length === 0) return out;
      const logs = await client.getLogs({ address: opts.planGuard, event: MANDATE_REVOKED_EVENT, args: { mandateDigest: [...digests] }, fromBlock: opts.fromBlock ?? 0n, toBlock: "latest" });
      for (const l of logs) {
        const d = (l.args.mandateDigest as Hex | undefined)?.toLowerCase() as Hex | undefined;
        if (d && l.transactionHash) out.set(d, l.transactionHash);
      }
      return out;
    },
  };
}

export async function confirmRevocationsOnce(tasks: TasksService, db: Db, reader: RevokedLogReader): Promise<{ pending: number; confirmed: number }> {
  const pending = await tasks.revokePendingTasks();
  if (pending.length === 0) return { pending: 0, confirmed: 0 };
  const ids = [...new Set(pending.flatMap((t) => t.mandateIds))];
  if (ids.length === 0) return { pending: pending.length, confirmed: 0 };
  const mandates = await db.select({ id: verifyMandates.id, digest: verifyMandates.mandateDigest, state: verifyMandates.state }).from(verifyMandates).where(inArray(verifyMandates.id, ids));
  const byDigest = new Map(mandates.map((m) => [m.digest.toLowerCase() as Hex, m]));
  let found: Map<Hex, Hex>;
  try {
    found = await reader.revoked([...byDigest.keys()]);
  } catch (err) {
    log.warn("撤销日志读取失败（下 tick 重试）", { error: err instanceof Error ? err.message : String(err) });
    return { pending: pending.length, confirmed: 0 };
  }
  let confirmed = 0;
  for (const row of pending) {
    // 一条任务可能有多份授权：**全部**都在链上撤销了才算任务撤销完成；否则继续 pending
    const digests = row.mandateIds.map((id) => mandates.find((m) => m.id === id)?.digest.toLowerCase() as Hex | undefined).filter((d): d is Hex => !!d);
    if (digests.length === 0 || !digests.every((d) => found.has(d))) continue;
    for (const d of digests) {
      const m = byDigest.get(d)!;
      if (m.state !== "REVOKED") await db.update(verifyMandates).set({ state: "REVOKED", updatedAt: new Date() }).where(and(eq(verifyMandates.id, m.id)));
    }
    const tx = found.get(digests[0]!)!;
    const r = await tasks.confirmRevoked(row.id, tx);
    if (r) confirmed += 1;
  }
  if (confirmed > 0) log.info("链上撤销已确认", { confirmed, pending: pending.length });
  return { pending: pending.length, confirmed };
}
