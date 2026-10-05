"use client";
/**
 * /agent/new 的状态：预填（只做一次）→ 受控草稿 → 本地 / 服务端字段错误 → 建任务（幂等：同一份草稿重试用同一个请求编号与请求体）。
 * 编辑任何字段都会作废旧编号；成功后跳任务控制台。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { takeDraft, takeGoalDraft } from "@/components/agent/tasks/taskDraft";
import { buildStartRequest, type V7CreateBody } from "@/components/onboarding/modelV7";
import { fieldErrorCopy } from "../task-form/copy";
import { displayErrors, draftFromTemplate, localFieldErrors, stableOf, type CreateOutcome, type FieldErrors, type FormDraft } from "../task-form/model";
import { submitTask, taskConsoleHref } from "../task-form/submit";
import type { TradableAssets } from "../task-form/useTradableAssets";
import { fromSourceOf, prefilledDraft, prefillNote, resolvePrefill } from "./prefill";

type Mode = "SIMULATION" | "LIVE";
type Failure = Exclude<CreateOutcome, { kind: "ok" }>;

export function useNewTask({ assets, owner, fixture }: { assets: TradableAssets; owner: string | null; fixture: boolean }) {
  const { locale } = useI18n();
  const router = useRouter();
  const sp = useSearchParams();
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [template, setTemplate] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [server, setServer] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<Mode | null>(null);
  const requests = useRef<Partial<Record<Mode, V7CreateBody>>>({});
  const inited = useRef(false);
  const lock = useRef(false);
  const last = useRef<Mode>("SIMULATION");
  const [lastMode, setLastMode] = useState<Mode>("SIMULATION");

  // 预填只做一次（草稿交接读后即删，不能在重渲染里再读）
  useEffect(() => {
    if (inited.current || assets.state !== "ok") return;
    inited.current = true;
    const from = fromSourceOf(sp.get("from"));
    const stockKeys = assets.stocks.map((a) => a.assetKey);
    if (!from) { setDraft(draftFromTemplate(0, stockKeys, locale)); return; }
    const pre = resolvePrefill({ query: new URLSearchParams(sp.toString()), handoff: from === "draft" ? takeDraft() : null, goal: from === "draft" ? takeGoalDraft() : null }, { stocks: assets.stocks, stables: assets.stables });
    const start = prefilledDraft(pre.patch, stockKeys, locale);
    setDraft(start.draft);
    setTemplate(start.template);
    setNote(prefillNote(from, locale, { dropped: pre.dropped, eventName: sp.get("eventName") }));
  }, [assets.state, assets.stocks, assets.stables, sp, locale]);

  const stable = stableOf(draft, assets.assets);
  const local = useMemo(() => (draft ? localFieldErrors(draft, assets.assets, assets.stocks.map((a) => a.assetKey)) : {}), [draft, assets.assets, assets.stocks]);
  const errors = displayErrors(local, server, (c) => fieldErrorCopy(c, locale));
  const valid = Object.keys(local).length === 0;

  function invalidate() { requests.current = {}; setServer({}); setFailure(null); }
  function edit(patch: Partial<FormDraft>) { setDraft((d) => (d ? { ...d, ...patch } : d)); invalidate(); }
  function pickTemplate(i: number) {
    setTemplate(i);
    setDraft((d) => draftFromTemplate(i, assets.stocks.map((a) => a.assetKey), locale, { inputAssetKey: d?.inputAssetKey }));
    invalidate();
  }

  async function create(mode: Mode) {
    if (lock.current || !draft || !stable || !owner || !valid) return;
    const body = requests.current[mode] ?? buildStartRequest(draft, stable, owner, mode, `web-new8-${mode === "LIVE" ? "live" : "sim"}-${crypto.randomUUID()}`, new Date(Date.now() + draft.days * 86_400_000).toISOString());
    if (!body) return;
    requests.current[mode] = body; // 先存再发：重试沿用同一个请求编号
    last.current = mode;
    setLastMode(mode);
    lock.current = true;
    setPending(mode);
    setFailure(null);
    const out = await submitTask(body, { mode, owner, fixture, locale });
    lock.current = false;
    setPending(null);
    if (out.kind === "ok") {
      toast.success(locale === "zh" ? (mode === "LIVE" ? "真实任务已创建，去完成授权" : "观察任务已创建") : mode === "LIVE" ? "Live task created. Finish authorization next." : "Observation task created");
      router.push(taskConsoleHref(out.id, fixture));
      return;
    }
    if (out.kind === "fields") setServer(out.fields);
    setFailure(out);
  }

  const retry = () => create(last.current);
  return { draft, template, note, stable, errors, valid, failure, pending, edit, pickTemplate, create, retry, lastMode };
}
