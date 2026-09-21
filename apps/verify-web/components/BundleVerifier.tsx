"use client";
/**
 * /verify-bundle：纯客户端验证器（V-06）。core 的 verifyBundleOffline 在浏览器运行，注入 viem 的 verifyTypedData / verifyMessage。
 * 不登录、不调 API 也能跑；只有点"从服务加载"才发请求。内嵌 JSON 编辑框：改任一字段立即重跑并高亮翻转的检查项（篡改实验）。
 */
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, decodeEventLog, http, verifyMessage, verifyTypedData } from "viem";
import { verifyBundleOffline, type BundleCheck, type EvidenceBundle } from "@chaconne/core/verify";
import { GUARD_ABI } from "@/lib/guardAbi";
import { PLAN_GUARD_ABI } from "@/lib/planGuardAbi";
import { jobsV2, mandates } from "@/lib/api-v2";
import { CheckCircle2, Circle, XCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Card, Pill } from "@/components/ui";
import { RPC_URL } from "@/lib/wallet";
import { api } from "@/lib/api";

interface OnlineCheck { id: string; ok: boolean; detail: string }

export function BundleVerifier() {
  const { t, locale } = useI18n();
  const sp = useSearchParams();
  const zh = locale === "zh";
  const [text, setText] = useState("");
  const [checks, setChecks] = useState<BundleCheck[] | null>(null);
  const [baseline, setBaseline] = useState<Record<string, boolean> | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [rpc, setRpc] = useState(RPC_URL);
  const [online, setOnline] = useState<OnlineCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 期望的证明签名者（V-07）：默认取 /healthz 的 attestation.signer，可手填；包内若带 attestationSigner 则以包为准 */
  const [expectedSigner, setExpectedSigner] = useState<string>("");
  useEffect(() => {
    api<{ attestation?: { signer?: string } | null }>("GET", "healthz").then((r) => {
      const s = r.status === 200 ? r.data.attestation?.signer : undefined;
      if (s && /^0x[0-9a-fA-F]{40}$/.test(s)) setExpectedSigner((cur) => cur || s);
    }).catch(() => undefined);
  }, []);

  const run = useCallback(async (src: string, asBaseline: boolean) => {
    setParseErr(null);
    let bundle: EvidenceBundle;
    try {
      bundle = JSON.parse(src) as EvidenceBundle;
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e));
      return;
    }
    const res = await verifyBundleOffline(bundle, {
      ...(!bundle.attestationSigner && /^0x[0-9a-fA-F]{40}$/.test(expectedSigner) ? { expectedSigner: expectedSigner as `0x${string}` } : {}),
      verifyTypedData: async ({ address, typedData, signature }) => verifyTypedData({ address, domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message, signature }),
      verifyMessage: async ({ address, raw, signature }) => verifyMessage({ address, message: { raw }, signature }),
    });
    setChecks(res);
    if (asBaseline) setBaseline(Object.fromEntries(res.map((c) => [c.id, c.ok])));
  }, [expectedSigner]);

  const load = useCallback(
    async (ref: { job?: string; mandate?: string }) => {
      setBusy(true);
      try {
        const r = ref.job ? await jobsV2.bundle(ref.job) : await mandates.bundle(ref.mandate!);
        if (r.status === 200) {
          const s = JSON.stringify(r.data, null, 2);
          setText(s);
          await run(s, true);
        } else setParseErr(`load failed: ${r.status}`);
      } finally {
        setBusy(false);
      }
    },
    [run],
  );

  // 由 ?job= / ?mandate= 显式加载（用户可见的动作等价物：URL 带参数）
  useEffect(() => {
    const job = sp.get("job");
    const man = sp.get("mandate");
    if (job) void load({ job });
    else if (man) void load({ mandate: man });
  }, [sp, load]);
  function onEdit(v: string) {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(v, baseline === null), 400);
  }
  async function onFile(f: File | null) {
    if (!f) return;
    const s = await f.text();
    setText(s);
    await run(s, true);
  }

  async function fetchOnline() {
    setOnline(null);
    let bundle: EvidenceBundle;
    try {
      bundle = JSON.parse(text) as EvidenceBundle;
    } catch {
      return;
    }
    const client = createPublicClient({ transport: http(rpc) });
    const out: OnlineCheck[] = [];
    const hashes = new Set<string>();
    for (const e of bundle.executions) if (e.txHash) hashes.add(e.txHash);
    for (const s of bundle.mandate?.steps ?? []) if (s.txHash) hashes.add(s.txHash);
    for (const h of hashes) {
      try {
        const rcpt = await client.getTransactionReceipt({ hash: h as `0x${string}` });
        out.push({ id: `receipt_${h.slice(0, 10)}_status`, ok: rcpt.status === "success", detail: `block ${rcpt.blockNumber} status ${rcpt.status}` });
        let matched = 0;
        for (const l of rcpt.logs) {
          for (const abi of [GUARD_ABI, PLAN_GUARD_ABI] as const) {
            try {
              const d = decodeEventLog({ abi, data: l.data, topics: l.topics });
              if (d.eventName === "GuardedExecution" || d.eventName === "MandateStep") {
                const args = d.args as Record<string, unknown>;
                const ev = String(args["evidenceHash"] ?? "").toLowerCase();
                const known = bundle.reports.some((r) => r.evidenceHash.toLowerCase() === ev);
                out.push({ id: `event_${h.slice(0, 10)}_${d.eventName}`, ok: known, detail: known ? `${d.eventName} evidenceHash ∈ bundle reports · spent ${String(args["spent"])} received ${String(args["received"])}` : `${d.eventName} evidenceHash ${ev.slice(0, 12)}… not in bundle` });
                matched += 1;
              }
            } catch {
              /* not ours */
            }
          }
        }
        if (matched === 0) out.push({ id: `event_${h.slice(0, 10)}_missing`, ok: false, detail: "no Guard/PlanGuard event in receipt" });
      } catch (e) {
        out.push({ id: `receipt_${h.slice(0, 10)}`, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
    if (hashes.size === 0) out.push({ id: "no_executions", ok: true, detail: "bundle has no on-chain executions" });
    setOnline(out);
  }

  const failed = useMemo(() => checks?.filter((c) => !c.ok).length ?? 0, [checks]);
  const flipped = (c: BundleCheck) => baseline !== null && baseline[c.id] !== undefined && baseline[c.id] !== c.ok;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">{t("vb_h")}</h1>
      <p className="text-sm text-neutral-300">{t("vb_p")}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("vb_paste")}>
          <div className="mb-2 flex flex-wrap gap-2 text-sm">
            <input type="file" accept="application/json" className="text-xs" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
            <LoadBox busy={busy} onLoad={load} />
          </div>
          <textarea className="field mono h-[28rem] w-full text-xs" value={text} onChange={(e) => onEdit(e.target.value)} placeholder='{"schemaVersion":"1","kind":"job",…}' spellCheck={false} />
          {parseErr && <p className="mt-2 text-xs text-bad">{parseErr}</p>}
          <button className="btn mt-2" onClick={() => run(text, true)} disabled={!text}>{t("vb_run")}</button>
        </Card>
        <Card title={zh ? "检查清单" : "Checklist"} right={checks ? failed === 0 ? <Pill tone="ok">{t("vb_all_ok")}</Pill> : <Pill tone="bad">{failed} {t("vb_failed")}</Pill> : null}>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-fg-2">
            <span>{zh ? "期望的证明签名者" : "Expected attestation signer"}</span>
            <input className="field mono max-w-sm py-1 text-xs" value={expectedSigner} onChange={(e) => setExpectedSigner(e.target.value.trim())} placeholder="0x…" />
            <span>{zh ? "（默认读自服务 healthz；包内自带 attestationSigner 时以包为准；○ = 未校验）" : "(defaults to the service healthz; a bundle's own attestationSigner wins; ○ = not verified)"}</span>
          </div>
          {!checks ? (
            <p className="text-sm text-fg-2">—</p>
          ) : (
            <ul className="max-h-[28rem] space-y-1 overflow-auto text-sm">
              {checks.map((c) => (
                <li key={c.id} className={`flex gap-2 rounded px-1 ${flipped(c) ? "bg-warn/15" : ""}`}>
                  <span className={c.skipped ? "text-fg-3" : c.ok ? "text-ok" : "text-bad"} title={c.skipped ? (zh ? "未校验" : "not verified") : undefined}>{c.skipped ? <Circle size={16} /> : c.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}</span>
                  <span className="mono text-xs text-neutral-300">{c.id}</span>
                  <span className="text-xs text-fg-3">{c.detail}</span>
                  {flipped(c) && <Pill tone="warn">{zh ? "被篡改影响" : "flipped by edit"}</Pill>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title={t("vb_online")}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input className="field mono max-w-md" value={rpc} onChange={(e) => setRpc(e.target.value)} />
          <button className="btn-ghost" disabled={!text} onClick={fetchOnline}>{t("vb_fetch")}</button>
        </div>
        {online && (
          <ul className="mt-3 space-y-1 text-sm">
            {online.map((c) => (
              <li key={c.id} className="flex gap-2"><span className={c.ok ? "text-ok" : "text-bad"}>{c.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}</span><span className="mono text-xs">{c.id}</span><span className="text-xs text-fg-3">{c.detail}</span></li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function LoadBox({ busy, onLoad }: { busy: boolean; onLoad: (ref: { job?: string; mandate?: string }) => Promise<void> }) {
  const { t } = useI18n();
  const [v, setV] = useState("");
  return (
    <span className="flex gap-2">
      <input className="field mono max-w-xs" placeholder="job_… / man_…" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn-ghost" disabled={busy || !v} onClick={() => onLoad(v.startsWith("job_") ? { job: v } : { mandate: v })}>{t("vb_load")}</button>
    </span>
  );
}
