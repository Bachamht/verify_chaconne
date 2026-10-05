"use client";
/** P7：建任务表单里的「谁来决策、谁来执行」+ 允许减仓 + 签名数预览（只在 NEXT_PUBLIC_V7_UI=1 时挂载）。 */
import type { AgentMode, ExecutorMode } from "@chaconne/core/verify";
import { signaturePreview } from "../../delegation/delegationModel";
import { useV7 } from "./useV7";
import "../../v7.css";

export interface ModeChoiceValue { agent: AgentMode; executor: ExecutorMode; allowSell: boolean }

export function ModeChoice({ value, onChange, live, assetCount, hostedClosed, onUseSimulation }: { value: ModeChoiceValue; onChange: (v: ModeChoiceValue) => void; live: boolean; assetCount: number; hostedClosed: boolean; onUseSimulation: () => void }) {
  const { s } = useV7();
  const n = signaturePreview(assetCount, value.allowSell);
  return (
    <section data-testid="v7-mode-choice">
      <h3 className="text-base font-semibold">{s("f_agent_h")} · {s("f_exec_h")}</h3>
      <fieldset className="mt-2 space-y-2">
        <legend className="text-sm">{s("f_agent_h")}</legend>
        <div className="v7-choices v7-two">
          {(["hosted", "byo"] as const).map((a) => <label key={a} className="v7-choice"><input type="radio" name="v7-agent" checked={value.agent === a} onChange={() => onChange({ ...value, agent: a })} /><span>{s(a === "hosted" ? "f_agent_hosted" : "f_agent_byo")}</span></label>)}
        </div>
        {value.agent === "byo" && <p className="ag-note">{s("f_byo_note")}</p>}
      </fieldset>
      {live && (
        <fieldset className="mt-3 space-y-2">
          <legend className="text-sm">{s("f_exec_h")}</legend>
          <div className="v7-choices">
            {(["hosted", "agent_wallet", "browser"] as const).map((e) => <label key={e} className="v7-choice"><input type="radio" name="v7-exec" checked={value.executor === e} onChange={() => onChange({ ...value, executor: e })} /><span>{s(`f_exec_${e}`)}</span></label>)}
          </div>
        </fieldset>
      )}
      <label className="ag-check mt-3"><input type="checkbox" checked={value.allowSell} onChange={(e) => onChange({ ...value, allowSell: e.target.checked })} /><span>{s("f_allow_sell")}</span></label>
      {(value.allowSell || (live && value.executor === "hosted")) && <p className="ag-note">{s("f_sell_recipient")}</p>}
      {live && (
        <div className="mt-2">
          <p className="v7-preview" data-testid="sig-preview">{s("f_sig_preview", { n })}</p>
          <p className="ag-note">{s("f_sig_preview_note")}</p>
        </div>
      )}
      {hostedClosed && (
        <p className="ag-warn mt-2" role="alert">{s("st_hosted_closed")} <button type="button" className="underline" onClick={onUseSimulation}>{s("f_use_sim")}</button></p>
      )}
    </section>
  );
}
