"use client";
/**
 * /verify-bundle（v8）的状态与动作：与 v7 BundleVerifier 同一套行为（粘贴 / 上传 / 从服务加载 / 改字段即重跑并标出翻转项 / 联网比对回执），
 * 区别只在拆包：core 验证器、viem、lib/api（会话签名）都在动作里按需 import，首屏不带钱包代码。
 *
 * run / load 是稳定引用（签名者、语言走 ref）：改「期望签名者」不会让页面按 URL 参数重新加载、覆盖你编辑过的 JSON。
 * 每次 run / load 带序号，只有最后一次的结果落地，慢的旧请求不会串数据。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleCheck, EvidenceBundle } from "@chaconne/core/verify";
import { apiError } from "@/lib/errors";
import { RPC_URL_PUBLIC } from "@/lib/explorer";
import { useI18n } from "@/lib/i18n";
import { tx } from "@/lib/i18n.execute";
import { publicGet } from "@/lib/publicApi";
import { loadFailureKey, type BundleRef } from "./bundleChecks";
import { onlineChecks, type OnlineCheck } from "./onlineChecks";

export type LoadFailure = { status: number; message: string } | null;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function useBundleVerifier() {
  const { locale } = useI18n();
  const [text, setText] = useState("");
  const [checks, setChecks] = useState<BundleCheck[] | null>(null);
  const [baseline, setBaseline] = useState<Record<string, boolean> | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<LoadFailure>(null);
  const [lastRef, setLastRef] = useState<BundleRef | null>(null);
  const [rpc, setRpc] = useState(RPC_URL_PUBLIC);
  const [online, setOnline] = useState<OnlineCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSeq = useRef(0);
  const loadSeq = useRef(0);
  const localeRef = useRef(locale);
  const textRef = useRef(text);
  const baselineRef = useRef(baseline);
  useEffect(() => { localeRef.current = locale; textRef.current = text; baselineRef.current = baseline; });
  /** 期望的证明签名者（V-07）：默认取 /healthz 的 attestation.signer，可手填；包内若带 attestationSigner 则以包为准 */
  const [expectedSigner, setSignerState] = useState("");
  const signerRef = useRef("");

  const run = useCallback(async (src: string, asBaseline: boolean) => {
    const seq = ++runSeq.current;
    setParseErr(null);
    let bundle: EvidenceBundle;
    try {
      bundle = JSON.parse(src) as EvidenceBundle;
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e));
      return;
    }
    const signer = signerRef.current;
    const [{ verifyEvidenceBundle }, { verifyMessage, verifyTypedData }] = await Promise.all([import("@chaconne/core/verify"), import("viem")]);
    const res = await verifyEvidenceBundle(bundle, {
      ...(!bundle.attestationSigner && ADDR.test(signer) ? { expectedSigner: signer as `0x${string}` } : {}),
      verifyTypedData: async ({ address, typedData, signature }) => verifyTypedData({ address, domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message, signature }),
      verifyMessage: async ({ address, raw, signature }) => verifyMessage({ address, message: { raw }, signature }),
    });
    if (seq !== runSeq.current) return; // 已有更新的一次运行
    setChecks(res);
    if (asBaseline) setBaseline(Object.fromEntries(res.map((c) => [c.id, c.ok])));
  }, []);

  /** 改签名者：只用当前文本重跑检查（不重新加载、不改基线，翻转项照常标出） */
  const setExpectedSigner = useCallback((v: string) => {
    signerRef.current = v;
    setSignerState(v);
    if (timer.current) clearTimeout(timer.current);
    if (textRef.current) timer.current = setTimeout(() => void run(textRef.current, baselineRef.current === null), 400);
  }, [run]);

  useEffect(() => {
    let alive = true;
    void publicGet<{ attestation?: { signer?: string } | null }>("healthz").then((r) => {
      const s = r.status === 200 ? r.data?.attestation?.signer : undefined;
      if (alive && s && ADDR.test(s) && !signerRef.current) { signerRef.current = s; setSignerState(s); }
    });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (ref: BundleRef) => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setLoadErr(null);
    setLastRef(ref);
    const loc = localeRef.current;
    try {
      const { api } = await import("@/lib/api");
      const path = ref.job ? `v1/jobs/${ref.job}/bundle` : ref.task ? `v1/tasks/${ref.task}/bundle` : `v1/mandates/${ref.mandate}/bundle`;
      const r = await api<EvidenceBundle>("GET", path);
      if (seq !== loadSeq.current) return;
      if (r.status === 200 && r.data && typeof r.data === "object") {
        const s = JSON.stringify(r.data, null, 2);
        setText(s);
        await run(s, true);
      } else {
        const key = loadFailureKey(r.status);
        setLoadErr({ status: r.status, message: key === "bundle_load_failed" ? tx(loc, key, { detail: apiError(r, loc) }) : tx(loc, key) });
      }
    } catch (e) {
      if (seq === loadSeq.current) setLoadErr({ status: 0, message: tx(loc, "bundle_load_failed", { detail: e instanceof Error ? e.message : String(e) }) });
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [run]);

  function edit(v: string) {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(v, baseline === null), 400);
  }
  async function upload(f: File | null) {
    if (!f) return;
    const s = await f.text();
    setText(s);
    await run(s, true);
  }
  async function fetchOnline() {
    setOnline(null);
    setOnlineBusy(true);
    try {
      setOnline(await onlineChecks(text, rpc));
    } finally {
      setOnlineBusy(false);
    }
  }
  const retryLoad = () => { if (lastRef) void load(lastRef); };
  return { text, checks, baseline, parseErr, loadErr, busy, onlineBusy, rpc, online, expectedSigner, setRpc, setExpectedSigner, run, load, edit, upload, fetchOnline, retryLoad };
}
