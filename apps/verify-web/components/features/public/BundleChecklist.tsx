"use client";
import { EmptyState } from "@/components/kit/FourStates";
import { FormField } from "@/components/kit/FormField";
import { Panel } from "@/components/kit/Panel";
import { ToneTag } from "@/components/kit/StatusBadge";
import { StepFlow } from "@/components/kit/StepFlow";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { checkDetailText, checkStepState, checkTitle, summarizeChecks, v3Groups } from "./bundleChecks";
import { CheckDetail } from "./CheckDetail";
import type { useBundleVerifier } from "./useBundleVerifier";

type V = ReturnType<typeof useBundleVerifier>;

/** 右栏：检查清单（StepFlow 竖排，done / failed / skipped）+ 期望签名者 + 任务记录 v3 分组 */
export function BundleChecklist({ v }: { v: V }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const sum = v.checks ? summarizeChecks(v.checks) : null;
  const groups = v.checks ? v3Groups(v.checks) : null;
  const flipped = (id: string, ok: boolean) => v.baseline !== null && v.baseline[id] !== undefined && v.baseline[id] !== ok;
  return (
    <Panel>
      <Panel.Header
        title={zh ? "检查清单" : "Checklist"}
        description={sum ? (zh ? `${sum.total} 项：通过 ${sum.passed} · 失败 ${sum.failed} · 未校验 ${sum.skipped}` : `${sum.total} checks: ${sum.passed} passed · ${sum.failed} failed · ${sum.skipped} not verified`) : undefined}
        action={sum ? (sum.failed === 0 ? <ToneTag tone="ok">{t("vb_all_ok")}</ToneTag> : <ToneTag tone="bad">{sum.failed} {t("vb_failed")}</ToneTag>) : null}
      />
      <Panel.Body className="flex flex-col gap-4">
        <FormField label={zh ? "期望的证明签名者" : "Expected attestation signer"} hint={zh ? "默认读自服务 healthz；包内自带 attestationSigner 时以包为准。" : "Defaults to the service healthz; a bundle's own attestationSigner wins."}>
          <Input className="font-mono text-xs" value={v.expectedSigner} onChange={(e) => v.setExpectedSigner(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
        </FormField>
        {groups ? (
          <div aria-label={zh ? "任务记录 v3 检查" : "Task record v3 checks"}>
            <p className="mb-2 text-xs text-fg-2">{zh ? "任务记录 v3：全部授权、步骤与证书、成交归因、额度签名、轮次哈希链、时间线摘要" : "Task record v3: every authorization, step and certificate, fill attribution, allowance signature, run hash chain, timeline digest"}</p>
            <ul className="flex flex-wrap gap-2">
              {groups.map((g) => <li key={g.key}><ToneTag tone={g.failed ? "bad" : "ok"}>{zh ? g.zh : g.en} <span className="tabular-nums">{g.total - g.failed}/{g.total}</span></ToneTag></li>)}
            </ul>
          </div>
        ) : null}
        {!v.checks ? (
          <EmptyState size="sm" title={zh ? "还没有运行检查" : "No checks run yet"} description={zh ? "在左边加载、上传或粘贴一个证据包，检查会在浏览器里自动运行。" : "Load, upload or paste a bundle on the left; checks run in your browser automatically."} />
        ) : (
          <div className="max-h-[36rem] overflow-y-auto pr-1">
            <StepFlow aria-label={zh ? "证据包检查" : "Bundle checks"}>
              {v.checks.map((c, i) => (
                <StepFlow.Step
                  key={`${c.id}-${i}`}
                  index={i + 1}
                  locale={locale}
                  last={i === v.checks!.length - 1}
                  state={checkStepState(c)}
                  title={<span title={c.id}>{checkTitle(c.id, locale)}</span>}
                  meta={flipped(c.id, c.ok) ? <ToneTag tone="warn">{zh ? "被改动影响" : "Flipped by edit"}</ToneTag> : undefined}
                  description={<CheckDetail id={c.id} detail={c.detail}>{checkDetailText(c, locale)}</CheckDetail>}
                />
              ))}
            </StepFlow>
          </div>
        )}
      </Panel.Body>
    </Panel>
  );
}
