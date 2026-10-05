"use client";
/** 动作结果（抽屉正文顶部）：服务端一句话 + 预览差异（条件翻成人话，不露条件串）+ 需要你选择时的「整日等待」。 */
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AgentSays } from "@/components/kit/AgentSays";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { eventDesk } from "@/components/agent/events/api";
import { useI18n } from "@/lib/i18n";
import { writeErrorText } from "@/components/features/common/writeError";
import { ACTION_LABEL, copy } from "./copy";
import type { ActionRun } from "./EventActions";
import { diffSentence } from "./impact";

export function ActionOutcome({ run, owner, eventId }: { run: ActionRun; owner: string; eventId: string }) {
  const { locale } = useI18n();
  const c = copy(locale);
  const r = run.result;
  const [pending, setPending] = useState(false);
  async function wholeDay() {
    setPending(true);
    const res = await eventDesk.action({ owner, eventId, action: "wait_by_rule", taskId: run.taskId, wholeDayIfDayPrecision: true });
    setPending(false);
    if (res.status < 300 && res.data) toast.success(res.data.message?.[locale] ?? c("whole_day"));
    else toast.error(`${c("whole_day")}：${c("action_failed")}`, { description: res.error === "relay_read_only" ? c("action_blocked_local") : writeErrorText(res, locale === "zh", c("nothing_changed")) });
  }
  const diff = r.preview?.diff ?? [];
  return (
    <AgentSays who={ACTION_LABEL[run.action][locale]} meta={r.mode === "SIMULATION" ? <StatusBadge status="simulation" /> : undefined}>
      <span className="block">{r.message?.[locale]}</span>
      {r.effect === "preview" ? (
        <span className="mt-2 block text-sm text-fg-2">
          {diff.length ? diff.map((d, i) => <span key={i} className="block">{diffSentence(d, locale)}</span>) : c("preview_same")}
          <span className="mt-1 block text-xs text-fg-3">{c("preview_no_auth")}</span>
        </span>
      ) : null}
      {r.effect === "evidence" ? <span className="mt-2 block text-sm text-fg-2">{r.evidence?.length ? `${r.evidence.length} ${c("evidence_n")}` : c("evidence_none")}</span> : null}
      {r.effect === "needs_choice" ? (
        <span className="mt-2 block"><AsyncButton size="sm" variant="outline" pending={pending} onClick={() => void wholeDay()}>{c("whole_day")}</AsyncButton></span>
      ) : null}
      {r.taskId && (r.effect === "created" || r.effect === "attached" || r.effect === "draft") ? (
        <Link href={`/agent/tasks/${r.taskId}`} className="mt-2 block text-sm text-brand-400 hover:text-brand-300">{c("open_task")}</Link>
      ) : null}
    </AgentSays>
  );
}
