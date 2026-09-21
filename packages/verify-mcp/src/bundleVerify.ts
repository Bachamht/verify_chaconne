/**
 * 证据包验证（W3 客户端/CLI 版）：离线检查全部委托给 `@chaconne/core/verify` 的 `verifyBundleOffline`
 * （签名恢复由本模块注入 viem 的 verifyTypedData / verifyMessage），再可选做联网回执比对。
 * 任一字段被改动都会让对应检查项失败并指出层级（id 前缀：bundle_ / evidence_ / registry_ / policy_ / report_ / plan_ / cert_ / intent_ / mandate_ / receipt_）。
 */
import { createPublicClient, decodeEventLog, http, verifyMessage, verifyTypedData, type Hex } from "viem";
import { verifyBundleOffline, type BundleCheck, type EvidenceBundle, type VerifyBundleOptions } from "@chaconne/core/verify";
import { GUARD_ABI } from "./guardAbi";
import { PLAN_GUARD_ABI } from "./planGuardAbi";

export type { BundleCheck };
export interface BundleVerifyResult {
  ok: boolean;
  checks: BundleCheck[];
  summary: { total: number; passed: number; failed: number };
  failedLayers: string[];
}
export interface BundleVerifyOptions {
  expectedSigner?: Hex;
  /** 联网：RPC 拉回执并比对事件 */
  rpcUrl?: string;
}

const lower = (s: unknown) => String(s ?? "").toLowerCase();

/** viem 注入：EIP-712 与 EIP-191 验签 */
export const viemVerifiers: Pick<VerifyBundleOptions, "verifyTypedData" | "verifyMessage"> = {
  verifyTypedData: ({ address, typedData, signature }) => verifyTypedData({ address, domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message, signature } as never),
  verifyMessage: ({ address, raw, signature }) => verifyMessage({ address, message: { raw }, signature }),
};

export async function verifyReceiptsOnline(bundle: EvidenceBundle, rpcUrl: string): Promise<BundleCheck[]> {
  const checks: BundleCheck[] = [];
  const rpc = createPublicClient({ transport: http(rpcUrl) });
  for (const x of bundle.executions ?? []) {
    if (!x.txHash) continue;
    try {
      const rcpt = await rpc.getTransactionReceipt({ hash: x.txHash });
      let ev: Record<string, unknown> | null = null;
      for (const l of rcpt.logs) {
        for (const abi of [GUARD_ABI, PLAN_GUARD_ABI] as const) {
          try {
            const d = decodeEventLog({ abi, data: l.data, topics: l.topics });
            if (d.eventName === "GuardedExecution" || d.eventName === "MandateStep") ev = { name: d.eventName, ...Object.fromEntries(Object.entries(d.args as Record<string, unknown>).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) };
          } catch {
            /* not this abi */
          }
        }
      }
      const rs = (x.receiptSummary ?? {}) as Record<string, unknown>;
      const rsEvent = (rs["event"] ?? rs) as Record<string, unknown>;
      const fields = ["intentDigest", "evidenceHash", "spent", "received", "refunded", "mandateDigest"] as const;
      const diffs = ev ? fields.filter((f) => rsEvent[f] !== undefined && ev![f] !== undefined && lower(rsEvent[f]) !== lower(ev![f])) : [];
      const ok = rcpt.status === "success" && !!ev && diffs.length === 0;
      checks.push({ id: `receipt_${x.attemptId}`, ok, detail: !ev ? `receipt ${rcpt.status}, no Guard/PlanGuard event` : diffs.length ? `event fields differ from bundle summary: ${diffs.join(", ")}` : `receipt success, ${String(ev["name"])} event matches summary (block ${rcpt.blockNumber})` });
    } catch (e) {
      checks.push({ id: `receipt_${x.attemptId}`, ok: false, detail: `receipt fetch failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return checks;
}

export async function verifyBundle(bundle: EvidenceBundle, opts: BundleVerifyOptions = {}): Promise<BundleVerifyResult> {
  const checks = await verifyBundleOffline(bundle, { ...viemVerifiers, ...(opts.expectedSigner ? { expectedSigner: opts.expectedSigner } : {}) });
  if (opts.rpcUrl) checks.push(...(await verifyReceiptsOnline(bundle, opts.rpcUrl)));
  const passed = checks.filter((c) => c.ok).length;
  const failedLayers = [...new Set(checks.filter((c) => !c.ok).map((c) => c.id.split("_")[0]!))];
  return { ok: checks.every((c) => c.ok), checks, summary: { total: checks.length, passed, failed: checks.length - passed }, failedLayers };
}
