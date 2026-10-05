"use client";
/**
 * /verify-bundle（v8，方案 §5.10）：纯浏览器验证器。检查项用 StepFlow 竖排（done / failed / 未校验 = skipped）；
 * 从服务加载失败给原因（ErrorState）；保留 ?task= / ?job= / ?mandate= 直达加载。
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { FormField } from "@/components/kit/FormField";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { StepFlow } from "@/components/kit/StepFlow";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { BundleChecklist } from "./BundleChecklist";
import { BundleInput } from "./BundleInput";
import { CheckDetail } from "./CheckDetail";
import { OnlineDetail } from "./OnlineDetail";
import { checkStepState, checkTitle, refFromParams } from "./bundleChecks";
import { useBundleVerifier } from "./useBundleVerifier";

function BundleOnline({ v }: { v: ReturnType<typeof useBundleVerifier> }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Panel>
      <Panel.Header title={t("vb_online")} description={zh ? "按包里的交易哈希读链上回执，核对 Guard / PlanGuard 事件的证据哈希属于包内报告。" : "Reads on-chain receipts for the bundle's transaction hashes and checks that Guard / PlanGuard events cite a bundled report."} />
      <Panel.Body className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
          <FormField label="RPC" className="flex-1">
            <Input className="font-mono text-xs" value={v.rpc} onChange={(e) => v.setRpc(e.target.value)} spellCheck={false} />
          </FormField>
          <AsyncButton variant="outline" pending={v.onlineBusy} pendingLabel={zh ? "正在读回执" : "Reading receipts"} disabled={!v.text} disabledReason={zh ? "先加载或粘贴证据包" : "Load or paste a bundle first"} onClick={() => void v.fetchOnline()}>{t("vb_fetch")}</AsyncButton>
        </div>
        {v.online ? (
          <StepFlow aria-label={t("vb_online")}>
            {v.online.map((c, i) => (
              <StepFlow.Step key={c.id} index={i + 1} locale={locale} last={i === v.online!.length - 1} state={checkStepState(c)} title={<span title={c.id}>{checkTitle(c.id, locale)}</span>} description={<CheckDetail id={c.id} detail={c.detail}><OnlineDetail info={c.info} /></CheckDetail>} />
            ))}
          </StepFlow>
        ) : null}
      </Panel.Body>
    </Panel>
  );
}

function VerifierBody() {
  const { t } = useI18n();
  const sp = useSearchParams();
  const v = useBundleVerifier();
  const { load } = v;
  // 由 ?job= / ?task= / ?mandate= 显式加载（URL 带参数 = 用户可见的动作等价物）；同一个参数只加载一次，不覆盖之后的编辑
  const key = sp?.toString() ?? "";
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    const ref = refFromParams(new URLSearchParams(key));
    if (ref) void load(ref);
  }, [key, load]);
  return (
    <>
      <PageHeader title={t("vb_h")} description={t("vb_p")} />
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <BundleInput v={v} />
          <BundleChecklist v={v} />
        </div>
        <BundleOnline v={v} />
      </div>
    </>
  );
}

export function BundleVerifierPage() {
  return (
    <Suspense fallback={null}>
      <VerifierBody />
    </Suspense>
  );
}
