"use client";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { lab, type CompareView } from "@/components/agent/lab/api";
import { Panel } from "@/components/kit/Panel";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ErrorState } from "@/components/kit/FourStates";
import { actionErrorText, vixInvalid } from "./labText";
import { DEFAULT_A, DEFAULT_B, VariantEditor, variantItems, type VariantForm } from "./VariantEditor";
import { CompareResult } from "./CompareResult";

/**
 * 双策略对照（POST /v1/tasks/:id/compare-policies）：两套规则看同一份证据快照，并排给出放行 / 等待与逐项差异。
 * 观察模式试算：不改你的授权，也不改真实任务。
 */
export function CompareTab({ taskId, badge }: { taskId: string; badge?: ReactNode }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [a, setA] = useState<VariantForm>(DEFAULT_A);
  const [b, setB] = useState<VariantForm>(DEFAULT_B);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<{ status: number; data: unknown } | null>(null);
  const [d, setD] = useState<CompareView | null>(null);

  const vixBad = vixInvalid(a.maxVix) || vixInvalid(b.maxVix);

  async function run() {
    if (!taskId) return;
    setPending(true);
    setErr(null);
    const r = await lab.compare(taskId, [
      { label: a.label || "A", conditions: { items: variantItems(a) } },
      { label: b.label || "B", conditions: { items: variantItems(b) } },
    ]).catch(() => ({ status: 0, data: null }));
    setPending(false);
    if ((r.status === 200 || r.status === 201) && r.data && typeof r.data === "object") {
      setD(r.data as CompareView);
      toast.success(zh ? "对照完成" : "Comparison done");
    } else {
      setD(null);
      setErr({ status: r.status, data: r.data });
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel>
        <Panel.Header
          title={zh ? "换一种规则会怎样？" : "What if the rule were different?"}
          description={zh ? "两套规则看同一份证据快照（同资产、同资金基准、同费用假设、同事件版本）。两套都固定只在美股常规时段。" : "Both rule sets see one evidence snapshot (same asset, budget basis, fees and event versions). Both stay on US regular hours."}
          action={badge}
        />
        <Panel.Body className="flex flex-col gap-4">
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            <VariantEditor id="va" title={zh ? "策略 A" : "Policy A"} v={a} onChange={setA} />
            <VariantEditor id="vb" title={zh ? "策略 B" : "Policy B"} v={b} onChange={setB} />
          </div>
          <div>
            <AsyncButton pending={pending} pendingLabel={zh ? "正在对照…" : "Comparing…"} disabled={!taskId || vixBad} disabledReason={!taskId ? (zh ? "先在上方选一个任务。" : "Pick a task above first.") : (zh ? "VIX 上限要填大于 0 的数，或留空。" : "Max VIX must be above 0, or blank.")} onClick={() => void run()}>
              {zh ? "在同一快照上对照" : "Compare on the same snapshot"}
            </AsyncButton>
          </div>
        </Panel.Body>
      </Panel>
      {err ? (
        <Panel><ErrorState size="sm" status={err.status} title={zh ? "对照没有完成" : "The comparison did not finish"} description={actionErrorText(err, locale)} onRetry={() => void run()} /></Panel>
      ) : d ? (
        <CompareResult d={d} />
      ) : null}
    </div>
  );
}
