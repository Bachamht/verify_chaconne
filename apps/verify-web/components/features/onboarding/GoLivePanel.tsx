"use client";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { CreateError } from "../task-form/CreateError";
import type { StartJourneyState } from "./useStartJourney";

/** 第 2 步下半：看过判断再决定真实运行。同一份目标与范围建 LIVE；先勾选「已核对」才可点；签名次数写对 */
export function GoLivePanel({ j }: { j: StartJourneyState }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const observed = j.journey.observation;
  if (!observed) return null;
  return (
    <Panel>
      <Panel.Header title={zh ? "看过它的判断，再决定真实运行" : "Review its decisions before going live"} description={zh ? "下一步会创建一份目标、股票、预算与截止时间都相同的真实任务。每项授权都要你签名后，才会执行。" : "Next, create a live task with the same goal, assets, budget, and deadline. You sign each authorization before anything can execute."} />
      <Panel.Body className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">
          {zh ? `买入最多要签 2 次${observed.draft.allowSell ? "，Agent 可以卖出的每只股票再加 2 次" : ""}。已有额度会减少签名次数。有些代币可能还需要一笔链上授权交易。` : `A buy may require up to 2 signatures${observed.draft.allowSell ? ", plus 2 per asset the agent may sell" : ""}. Existing allowances reduce the count. Some tokens may also require one on-chain approval transaction.`}
        </p>
        {j.err ? <CreateError outcome={j.err} /> : null}
        {j.journey.liveId ? (
          <Button asChild size="lg" className="self-start"><Link href={j.startHref("live")}>{zh ? "继续已创建任务的授权" : "Continue this task's authorization"}<ArrowRight aria-hidden="true" /></Link></Button>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <Checkbox id="start-reviewed" checked={j.reviewed} onCheckedChange={(c) => j.setReviewed(c === true)} className="mt-0.5" />
              <Label htmlFor="start-reviewed" className="text-sm font-normal text-fg-1">{zh ? "我已核对委托范围，理解真实运行会使用钱包里的资金。" : "I reviewed the scope and understand live execution uses wallet funds."}</Label>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <AsyncButton size="lg" pending={j.busy === "live"} pendingLabel={tv(locale, "st_live_creating")} disabled={!j.reviewed} onClick={() => void j.create("LIVE")}>
                {zh ? "创建真实任务，核对授权" : "Create live task & review authorization"}<ArrowRight aria-hidden="true" />
              </AsyncButton>
              <Button type="button" variant="outline" size="lg" disabled={!!j.busy} onClick={() => { j.edit(observed.draft); j.router.push(j.startHref("describe")); }}>{zh ? "修改目标，重新观察" : "Edit goal & observe again"}</Button>
            </div>
          </>
        )}
      </Panel.Body>
    </Panel>
  );
}
