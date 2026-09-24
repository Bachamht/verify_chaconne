"use client";
/**
 * 建任务表单（V-24）：首页「帮我安排买入」与「第一分钟」第 4 步共用这一份。
 * 字段：资产 / 模板 / 步数 / 支付币种（默认 USDG）/ 每步金额（人类单位 → 按精度换 raw）/ 模式 / owner。
 * 提交前做与服务端同名的参数校验；400 invalid_playbook_params 映射成字段级提示，绝不显示「尚未就绪」。
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlaybookId } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { agentTasks, notReady, type TaskCreated } from "@/lib/api-v2";
import { apiError, fieldErrors, fieldErrorText } from "@/lib/errors";
import { formatAmount, humanToRaw } from "@/lib/format";
import { remember } from "@/lib/history";
import { balanceOf } from "@/lib/wallet";
import { assetByKey, defaultStable, stablesOf, stocksOf, type AssetEntry } from "@/lib/assets";
import { conditionText } from "@/lib/conditions";
import { Json, Pill } from "@/components/ui";
import { ModeTag, NotReady, OwnerField, useOwnerInput } from "../shared";
import { SAMPLES } from "../home/entries";
import { amountParamOf, buildTaskBody, defaultPerStep, validateDraft, type DraftField, type TaskDraft } from "./taskDraft";

const PLACEHOLDER_OWNER = "0x0000000000000000000000000000000000000001";

export function TaskForm({ assets, assetsSource, onRetryAssets, preset, allowPlaceholderOwner = false, onCreated }: {
  assets: AssetEntry[];
  assetsSource?: "live" | "cache" | "none";
  onRetryAssets?: () => void;
  preset?: Partial<TaskDraft>;
  /** 第一分钟：没连钱包也能建模拟任务（占位 owner，页面明示） */
  allowPlaceholderOwner?: boolean;
  /** 给了就不跳转（第一分钟在原地显示结果） */
  onCreated?: (v: TaskCreated) => void;
}) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const stocks = stocksOf(assets);
  const stables = stablesOf(assets);
  const [playbookId, setPlaybookId] = useState<PlaybookId>(preset?.playbookId && SAMPLES.some((s) => s.playbookId === preset.playbookId) ? preset.playbookId : SAMPLES[0]!.playbookId);
  const [outputKey, setOutputKey] = useState(preset?.outputAssetKey ?? "");
  const [inputKey, setInputKey] = useState(preset?.inputAssetKey ?? "");
  const [steps, setSteps] = useState(String(preset?.steps ?? SAMPLES.find((s) => s.playbookId === playbookId)?.steps ?? 3));
  const [amount, setAmount] = useState(preset?.perStepHuman ?? "1");
  const [amountTouched, setAmountTouched] = useState(!!preset?.perStepHuman);
  const [mode, setMode] = useState<"SIMULATION" | "LIVE">(preset?.mode ?? "SIMULATION");
  const [custom, setCustom] = useState(preset?.conditions ?? null);
  const [balance, setBalance] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "ok"; raw: string } | { kind: "unknown" }>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [errs, setErrs] = useState<Partial<Record<string, string>>>({});
  const [nr, setNr] = useState<number | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // 预填变化（一句话编译 / 草案）→ 覆盖表单。按内容比较（不按对象身份）：父组件每次渲染新建 preset 对象时不能把用户已改的字段冲掉
  const presetKey = JSON.stringify(preset ?? null);
  useEffect(() => {
    if (!preset) return;
    if (preset.playbookId && SAMPLES.some((s) => s.playbookId === preset.playbookId)) setPlaybookId(preset.playbookId);
    if (preset.outputAssetKey) setOutputKey(preset.outputAssetKey);
    if (preset.inputAssetKey) setInputKey(preset.inputAssetKey);
    if (preset.steps) setSteps(String(preset.steps));
    if (preset.perStepHuman) { setAmount(preset.perStepHuman); setAmountTouched(true); }
    if (preset.mode) setMode(preset.mode);
    if (preset.conditions) setCustom(preset.conditions);
    if (preset.ownerAddress && !connected && /^0x[0-9a-fA-F]{40}$/.test(preset.ownerAddress)) setOwner(preset.ownerAddress);
  }, [presetKey]); // 依赖只有内容键：preset 对象本身每次渲染可能是新的

  const sample = SAMPLES.find((s) => s.playbookId === playbookId) ?? SAMPLES[0]!;
  const stock = assetByKey(stocks, outputKey) ?? stocks[0] ?? null;
  const stable = assetByKey(stables, inputKey) ?? defaultStable(assets);
  const conditions = custom ?? sample.conditions;
  const stepsN = Number(steps) || 0;
  const perStep = amountParamOf(playbookId) === "perStepAmountRaw";
  const effectiveOwner = valid ? owner : allowPlaceholderOwner && mode === "SIMULATION" ? PLACEHOLDER_OWNER : "";
  const decimals = stable?.tokenDecimals ?? null;

  // 余额（只读 RPC，不弹窗）：用于默认金额与提示；读不到写「未知」，不当作 0
  useEffect(() => {
    if (!valid || !stable) { setBalance({ kind: "idle" }); return; }
    let alive = true;
    setBalance({ kind: "busy" });
    balanceOf(stable.tokenAddress as `0x${string}`, owner as `0x${string}`)
      .then((b) => alive && setBalance({ kind: "ok", raw: b.toString() }))
      .catch(() => alive && setBalance({ kind: "unknown" }));
    return () => { alive = false; };
  }, [valid, owner, stable]);
  useEffect(() => {
    if (amountTouched || !stable) return;
    if (balance.kind === "ok") setAmount(defaultPerStep(balance.raw, stable.tokenDecimals, perStep ? stepsN : 1));
    else if (balance.kind === "unknown" || balance.kind === "idle") setAmount("1");
  }, [balance, stable, stepsN, perStep, amountTouched]);

  const rawAmount = decimals !== null ? humanToRaw(amount, decimals) : null;
  const total = useMemo(() => (rawAmount && decimals !== null ? formatAmount(perStep ? (BigInt(rawAmount) * BigInt(Math.max(1, stepsN))).toString() : rawAmount, decimals, stable?.displaySymbol) : "—"), [rawAmount, decimals, perStep, stepsN, stable]);
  const draft: TaskDraft = { playbookId, outputAssetKey: stock?.assetKey ?? "", inputAssetKey: stable?.assetKey ?? "", steps: stepsN, perStepHuman: amount, mode, conditions, maxPremiumBps: 30 };

  async function submit() {
    setMsg(null);
    const pre = validateDraft(draft, effectiveOwner, decimals);
    if (Object.keys(pre).length) return setErrs(Object.fromEntries(Object.entries(pre).map(([k, v]) => [k, fieldErrorText(v!, locale)])));
    setErrs({});
    setBusy(true);
    const r = await agentTasks.create(buildTaskBody(draft, effectiveOwner, decimals!, `web-${Date.now()}`)).catch(() => null);
    setBusy(false);
    if (!r) return setMsg(t("ag_service_unreachable"));
    if (r.status === 400) {
      const fe = fieldErrors(r.data.details, locale);
      if (Object.keys(fe).length) { setErrs(fe); return setMsg(t("ag_fix_fields")); }
      return setMsg(apiError(r, locale));
    }
    if (notReady(r)) return setNr(r.status);
    if (r.status !== 201 && r.status !== 200) return setMsg(apiError(r, locale));
    remember({ kind: "mandate", id: r.data.task.id, title: `${sample.title[locale]} ${stock?.displaySymbol ?? ""} (${mode})`, owner: effectiveOwner.toLowerCase() });
    if (onCreated) onCreated(r.data);
    else router.push(`/agent/tasks/${r.data.task.id}`);
  }

  const err = (f: DraftField) => (errs[f] ? <span className="ag-field-err" role="alert">{errs[f]}</span> : null);
  if (nr !== null) return <NotReady what="POST /v1/tasks" status={nr} />;
  const registryNote = assetsSource === "cache" ? t("ag_registry_cached") : assetsSource === "none" ? t("ag_registry_none") : null;
  return (
    <div className="space-y-3">
      {registryNote && <p className="ag-warn">{registryNote}{onRetryAssets && <> · <button type="button" className="underline" onClick={onRetryAssets}>{t("ag_retry")}</button></>}</p>}
      <div className="ag-form">
        <label>{t("ag_f_asset")}<select className="field" value={stock?.assetKey ?? ""} onChange={(e) => setOutputKey(e.target.value)} aria-invalid={!!errs["outputAssetKey"]}>{stocks.length === 0 && <option value="">—</option>}{stocks.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol} · {a.underlyingId.split(":")[1]}</option>)}</select>{err("outputAssetKey")}</label>
        <label>{t("ag_f_playbook")}<select className="field" value={playbookId} onChange={(e) => { setPlaybookId(e.target.value as PlaybookId); setCustom(null); const s = SAMPLES.find((x) => x.playbookId === e.target.value); if (s) setSteps(String(s.steps)); }}>{SAMPLES.map((s) => <option key={s.playbookId} value={s.playbookId}>{s.title[locale]}</option>)}</select></label>
        <label>{t("ag_f_steps")}<input className="field" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} aria-invalid={!!errs["steps"]} />{err("steps")}</label>
        <label>{t("ag_f_pay_with")}<select className="field" value={stable?.assetKey ?? ""} onChange={(e) => { setInputKey(e.target.value); setAmountTouched(false); }} aria-invalid={!!errs["inputAssetKey"]}>{stables.length === 0 && <option value="">—</option>}{stables.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol}</option>)}</select>{err("inputAssetKey")}</label>
        <label>{perStep ? t("ag_f_per_step") : t("ag_f_amount_total")}{stable ? ` (${stable.displaySymbol})` : ""}<input className="field" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setAmountTouched(true); }} aria-invalid={!!errs["perStepAmountRaw"]} />{err("perStepAmountRaw")}
          <span className="ag-note">{balance.kind === "busy" ? t("ag_balance_loading") : balance.kind === "ok" && stable ? `${t("ag_balance")} ${formatAmount(balance.raw, stable.tokenDecimals, stable.displaySymbol)}` : balance.kind === "unknown" ? t("ag_balance_unknown") : ""}{perStep && stepsN > 0 ? ` · ${t("ag_total_line", { n: stepsN, total })}` : ""}</span>
        </label>
        <label>{t("ag_f_mode")}<select className="field" value={mode} onChange={(e) => setMode(e.target.value as "SIMULATION" | "LIVE")}><option value="SIMULATION">{t("ag_mode_sim_opt")}</option><option value="LIVE">{t("ag_mode_live_opt")}</option></select></label>
        <OwnerField owner={owner} setOwner={setOwner} connected={connected} />
        {err("ownerAddress")}
      </div>
      <p className="ag-note">{sample.what[locale]}</p>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{t("ag_conditions")} · {conditions.length}</p>
        <ul className="ag-list text-xs">{conditions.map((c, i) => <li key={i}>{conditionText(c, locale)}</li>)}</ul>
        <button type="button" className="ag-note underline" onClick={() => setShowRaw((v) => !v)}>{t("ag_dev_view")}</button>
        {showRaw && <Json value={{ playbookId, params: { inputAssetKey: stable?.assetKey, outputAssetKey: stock?.assetKey, steps: stepsN, [amountParamOf(playbookId)]: rawAmount }, conditions }} />}
      </div>
      <div className="ag-actions">
        <button className="btn" disabled={busy || !stock || !stable || (!valid && !(allowPlaceholderOwner && mode === "SIMULATION"))} onClick={submit}>{busy ? t("ag_creating") : mode === "SIMULATION" ? t("ag_create_sim") : t("ag_create_live")}</button>
        <ModeTag mode={mode} />
        {!valid && (allowPlaceholderOwner ? <span className="ag-note">{t("ag_placeholder_owner")}</span> : <span className="ag-note">{t("ag_owner_hint")}</span>)}
        {mode === "LIVE" && !connected && <Pill tone="warn">{zh ? "真实任务需要 owner 钱包签授权" : "A live task needs the owner wallet to sign"}</Pill>}
      </div>
      {msg && <p className="text-sm text-bad" role="alert">{msg}</p>}
      {stocks.length === 0 && assetsSource !== "none" && <p className="ag-note"><Link className="underline" href="/developers">{zh ? "登记表里没有可执行的股票资产" : "No executable stock asset in the registry"}</Link></p>}
    </div>
  );
}
