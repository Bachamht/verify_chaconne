"use client";
import { useState } from "react";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ErrorState } from "@/components/kit/FourStates";
import { FormField } from "@/components/kit/FormField";
import { Panel } from "@/components/kit/Panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { refFromId } from "./bundleChecks";
import type { useBundleVerifier } from "./useBundleVerifier";

type V = ReturnType<typeof useBundleVerifier>;

/** 左栏：从服务加载（job_ / tsk_ / mnd_）· 上传文件 · 粘贴 JSON；加载失败给原因 + 重试 */
export function BundleInput({ v }: { v: V }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const [id, setId] = useState("");
  return (
    <Panel>
      <Panel.Header title={t("vb_paste")} />
      <Panel.Body className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
          <FormField label={zh ? "从服务加载（任务 / 单笔 / 授权编号）" : "Load from the service (task / job / mandate id)"} className="flex-1">
            <Input className="font-mono" placeholder="job_… / mnd_… / tsk_…" value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} />
          </FormField>
          <AsyncButton variant="outline" pending={v.busy} pendingLabel={zh ? "加载中" : "Loading"} disabled={!id.trim()} onClick={() => void v.load(refFromId(id))}>{t("vb_load")}</AsyncButton>
        </div>
        {v.loadErr ? (
          <ErrorState size="sm" status={v.loadErr.status} title={zh ? "没有从服务加载到证据包" : "Could not load the bundle from the service"} description={v.loadErr.message} onRetry={v.retryLoad} className="rounded-md border border-bad/35" />
        ) : null}
        <FormField label={zh ? "上传 JSON 文件" : "Upload a JSON file"} optional={zh ? "可选" : "optional"}>
          <Input type="file" accept="application/json" className="text-sm" onChange={(e) => void v.upload(e.target.files?.[0] ?? null)} />
        </FormField>
        <FormField label={zh ? "证据包 JSON" : "Bundle JSON"} hint={zh ? "改任意字段，0.4 秒后自动重跑，并标出被改动影响的检查。" : "Edit any field; checks re-run after 0.4 s and flag the ones your edit flipped."} error={v.parseErr ? (zh ? `JSON 解析失败：${v.parseErr}` : `JSON parse error: ${v.parseErr}`) : null}>
          <Textarea className="h-96 field-sizing-fixed resize-y font-mono text-xs leading-5" value={v.text} onChange={(e) => v.edit(e.target.value)} placeholder='{"schemaVersion":"1","kind":"job",…}' spellCheck={false} />
        </FormField>
        <div>
          <Button onClick={() => void v.run(v.text, true)} disabled={!v.text}>{t("vb_run")}</Button>
        </div>
      </Panel.Body>
    </Panel>
  );
}
