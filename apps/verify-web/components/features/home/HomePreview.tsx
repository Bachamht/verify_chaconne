"use client";
import { useState } from "react";
import { ChevronDown, LayoutDashboard } from "lucide-react";
import { Amount } from "@/components/kit/Amount";
import { AgentSays, SourceChip } from "@/components/kit/AgentSays";
import { EvidencePanel } from "@/components/kit/EvidencePanel";
import { ModeTag, StatusBadge } from "@/components/kit/StatusBadge";
import { StepFlow } from "@/components/kit/StepFlow";
import type { Locale } from "@/lib/i18n";
import type { HomeCopy } from "./copy";
import { FIXTURE_TASK as T } from "./fixture";
import { SectionHeading } from "./SectionHeading";

/**
 * 一屏真实产品画面：用 kit 组件渲染一个 FIXTURE 任务控制台缩略（不是截图）。
 * 标题区、Agent 发言、步骤与证据每处都挂「示例数据」，不冒充实时状态。
 */
export function HomePreview({ c, locale }: { c: HomeCopy; locale: Locale }) {
  const zh = locale === "zh";
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  return (
    <section aria-labelledby="home-preview-title" className="ch-home-section ch-home-preview">
      <SectionHeading id="home-preview-title" title={c.previewTitle} eyebrow={c.previewEyebrow} />
      <div className="ch-preview-console">
        <div className="ch-preview-toolbar">
          <span className="ch-preview-toolbar-title"><LayoutDashboard className="size-4" aria-hidden="true" />{zh ? "任务控制台" : "Task console"}</span>
          <ModeTag mode={T.mode} />
        </div>
        <header className="ch-preview-header">
          <div>
            <p className="ch-preview-task-label">{zh ? "一项持续运行的目标" : "One goal. An ongoing task."}</p>
            <h3>{T.title[locale]}</h3>
          </div>
          <StatusBadge status={T.status} />
        </header>
        <dl className="ch-preview-kpis">
          {T.kpis.map((k) => (
            <div key={k.key} className="ch-preview-kpi">
              <dt>{k.label[locale]}</dt>
              <dd>{k.amount
                ? <Amount raw={k.amount.raw} decimals={k.amount.decimals} symbol={k.amount.symbol} maxFrac={2} />
                : <span>{k.count}<span className="ch-preview-kpi-unit">{k.unit?.[locale]}</span></span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className="ch-preview-body">
          <div className="ch-preview-decisions">
            <AgentSays
              className="ch-preview-agent"
              meta={<ModeTag mode={T.agentSays.mode} />}
              source={T.agentSays.sources.map((s) => <SourceChip key={s.en}>{s[locale]}</SourceChip>)}
            >
              {T.agentSays.text[locale]}
            </AgentSays>
            <div className="ch-preview-timeline">
              <h4 className="ch-preview-subheading">{zh ? "决策的来龙去脉" : "How the plan evolved"}</h4>
              <StepFlow aria-label={zh ? "示例任务的步骤" : "Example task steps"} className="ch-preview-steps">
                {T.steps.map((s, i) => (
                  <StepFlow.Step
                    key={s.title.en}
                    index={i + 1}
                    state={s.state}
                    locale={locale}
                    title={s.title[locale]}
                    meta={s.note?.[locale]}
                    last={i === T.steps.length - 1}
                  />
                ))}
              </StepFlow>
            </div>
          </div>
          <div className="ch-preview-evidence-wrap">
            <button type="button" className="ch-preview-evidence-toggle" aria-expanded={evidenceOpen} aria-controls="home-preview-evidence" onClick={() => setEvidenceOpen((open) => !open)}>
              <span>{zh ? `查看 ${T.evidence.length} 条示例证据` : `View ${T.evidence.length} example sources`}</span><ChevronDown className="size-4" aria-hidden="true" />
            </button>
            <div id="home-preview-evidence" className={evidenceOpen ? "" : "hidden md:block"}>
            <EvidencePanel className="ch-preview-evidence">
            <EvidencePanel.Header title={zh ? "证据" : "Evidence"} count={T.evidence.length} description={zh ? "每条都带来源、时间与数据模式" : "Each item shows its source, time and data mode"} />
            {T.evidence.map((e) => (
              <EvidencePanel.Item key={e.hash} source={e.source[locale]} at={e.at} mode={e.mode}>
                {e.price ? <Amount value={e.price} prefix="$" maxFrac={2} minFrac={2} /> : null}
              </EvidencePanel.Item>
            ))}
            </EvidencePanel>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
