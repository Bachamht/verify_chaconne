"use client";
/**
 * /start 引导的流程状态（行为与 v7 OnboardingV7 一致，只换外观）：
 *  - 按钱包分区的 sessionStorage 草稿（journeyV7：只存我们自己的完整请求，不存签名或密钥）；FIXTURE 与真实进度分开存
 *  - 请求前先存幂等编号，刷新 / 重试用同一个请求；编辑目标或范围会作废旧编号与旧流程引用（已建的服务端任务仍在）
 *  - LIVE 从已观察的请求快照生成（目标、策略、资产、预算、截止时间不变）；过期须重新观察
 *  - 创建结果必须与请求的模式和 owner 一致
 */
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { buildStartRequest } from "@/components/onboarding/modelV7";
import { editJourney, emptyJourney, journeyKey, liveFromObservation, parseJourney, type StartAttempt, type StartJourney } from "@/components/onboarding/journeyV7";
import { draftFromTemplate, localFieldErrors, stableOf, type CreateOutcome, type FormDraft } from "../task-form/model";
import { submitTask } from "../task-form/submit";
import type { TradableAssets } from "../task-form/useTradableAssets";

export type Stage = "describe" | "watch" | "live";
export const STAGES: Stage[] = ["describe", "watch", "live"];
type Failure = Exclude<CreateOutcome, { kind: "ok" }>;

export function useStartJourney({ owner: rawOwner, fixture, assets }: { owner: string; fixture: boolean; assets: TradableAssets }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const sp = useSearchParams();
  const stage: Stage = sp.get("step") === "watch" ? "watch" : sp.get("step") === "live" ? "live" : "describe";
  const owner = rawOwner.toLowerCase();
  const storageKey = journeyKey(owner) + (fixture ? ":fixture" : "");
  const [journey, setJourney] = useState<StartJourney>(() => emptyJourney(owner));
  const current = useRef(journey);
  const [restored, setRestored] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [busy, setBusy] = useState<"sim" | "live" | null>(null);
  const [err, setErr] = useState<Failure | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const draft = journey.draft as FormDraft | null;
  const stable = journey.observation?.stable ?? journey.attempt?.stable ?? stableOf(draft, assets.assets);
  const local = draft ? localFieldErrors(draft, assets.assets, assets.stocks.map((a) => a.assetKey)) : {};
  const startHref = (step: Stage) => "/start?step=" + step + (fixture ? "&v7fixture=1" : "");

  function save(next: StartJourney) {
    current.current = next;
    setJourney(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let j = emptyJourney(owner);
    try { j = parseJourney(sessionStorage.getItem(storageKey), owner) ?? j; } catch { setSaveFailed(true); }
    current.current = j;
    setJourney(j);
    setRestored(true);
  }, [owner, storageKey]);
  useEffect(() => {
    if (restored && !journey.draft && assets.stocks.length) {
      const next = { ...current.current, draft: draftFromTemplate(0, assets.stocks.map((x) => x.assetKey), locale) };
      current.current = next;
      setJourney(next);
    }
  }, [restored, journey.draft, assets.stocks, locale]);

  function edit(next: FormDraft, template = journey.template) {
    save(editJourney(current.current, next, template));
    setErr(null);
    setReviewed(false);
  }
  const set = (patch: Partial<FormDraft>) => { if (draft) edit({ ...draft, ...patch }); };
  const pickTemplate = (i: number) => edit(draftFromTemplate(i, assets.stocks.map((a) => a.assetKey), locale, { inputAssetKey: draft?.inputAssetKey }), i);

  async function create(mode: "SIMULATION" | "LIVE") {
    if (locked.current || !restored) return;
    setErr(null);
    let j = current.current;
    let attempt: StartAttempt;
    if (mode === "SIMULATION") {
      if (!draft || !stable || Object.keys(local).length) return;
      if (j.observation) { router.push(startHref("watch")); return; }
      const body = j.attempt?.body ?? buildStartRequest(draft, stable, owner, "SIMULATION", "web-start7-sim-" + crypto.randomUUID(), new Date(Date.now() + draft.days * 86_400_000).toISOString());
      if (!body) return;
      if (Date.parse(body.scope!.deadline!) <= Date.now()) { save({ ...j, attempt: null }); setErr({ kind: "other", message: zh ? "上次请求已过期，请再次开始观察。" : "The previous request expired. Start observation again." }); return; }
      attempt = j.attempt ?? { draft, stable, body };
      j = { ...j, attempt };
    } else {
      if (j.liveId) { router.push(startHref("live")); return; }
      if (!j.observation || !reviewed) return;
      attempt = j.observation;
      j = { ...j, liveRequestId: j.liveRequestId ?? "web-start7-live-" + crypto.randomUUID() };
    }
    const body = mode === "SIMULATION" ? attempt.body : liveFromObservation(attempt.body, j.liveRequestId!);
    if (!body) { setErr({ kind: "other", message: zh ? "观察任务的有效期已结束，请返回修改目标并重新观察。" : "This observation's scope has expired. Edit the goal and observe again." }); return; }
    save(j); // 先存再发：刷新 / 重试沿用同一个幂等编号
    locked.current = true;
    setBusy(mode === "SIMULATION" ? "sim" : "live");
    const out = await submitTask(body, { mode, owner, fixture, locale });
    if (!mounted.current) return;
    locked.current = false;
    setBusy(null);
    if (out.kind !== "ok") { setErr(out); return; }
    if (mode === "SIMULATION") save({ ...j, observation: { ...attempt, id: out.id }, attempt: null });
    else save({ ...j, liveId: out.id });
    router.push(startHref(mode === "SIMULATION" ? "watch" : "live"));
  }

  const missing = restored && ((stage === "watch" && !journey.observation) || (stage === "live" && !journey.liveId));
  return { stage, journey, draft, stable, local, restored, saveFailed, busy, err, reviewed, setReviewed, missing, set, edit, pickTemplate, create, startHref, router };
}
export type StartJourneyState = ReturnType<typeof useStartJourney>;
