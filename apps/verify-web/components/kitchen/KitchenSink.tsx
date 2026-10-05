"use client";
import { useI18n } from "@/lib/i18n";
import { PageHeader } from "@/components/kit/PageHeader";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { ButtonsSection, BadgesSection, TokensSection } from "./sectionsBasics";
import { DataSection, KpiSection, AgentSection } from "./sectionsData";
import { FlowSection, StatesSection, EvidenceSection } from "./sectionsFlow";
import { FormSection, OverlaySection } from "./sectionsForms";

export function KitchenSink() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={zh ? "组件验收页" : "Component kitchen sink"}
        description={zh ? "v8 kit 的全部组件与四态。只在 NEXT_PUBLIC_V8_UI=1 的构建里存在。" : "Every v8 kit component in all four states. Exists only in NEXT_PUBLIC_V8_UI=1 builds."}
        badges={<StatusBadge status="simulation" />}
      />
      <TokensSection />
      <ButtonsSection />
      <BadgesSection />
      <KpiSection />
      <AgentSection />
      <FlowSection />
      <DataSection />
      <StatesSection />
      <EvidenceSection />
      <FormSection />
      <OverlaySection />
    </div>
  );
}
