"use client";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { CreateError } from "../task-form/CreateError";
import { fieldErrorCopy } from "../task-form/copy";
import { displayErrors } from "../task-form/model";
import { TaskFormFields } from "../task-form/TaskFormFields";
import type { TradableAssets } from "../task-form/useTradableAssets";
import type { StartJourneyState } from "./useStartJourney";

/** 第 1 步「交代任务」：共用的任务表单 + 主按钮「先跑给我看」（建观察任务，不执行交易） */
export function DescribeStage({ j, assets }: { j: StartJourneyState; assets: TradableAssets }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (!j.draft) return null;
  const errors = displayErrors(j.local, j.err?.kind === "fields" ? j.err.fields : {}, (c) => fieldErrorCopy(c, locale));
  const blocked = Object.keys(j.local).length > 0;
  const observed = !!j.journey.observation;
  return (
    <form className="flex min-w-0 flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void j.create("SIMULATION"); }}>
      <TaskFormFields value={j.draft} template={j.journey.template} onTemplate={j.pickTemplate} onChange={j.set} assets={assets} errors={errors} disabled={!!j.busy} />
      {j.err ? (
        <CreateError outcome={j.err} action={j.err.kind === "unreachable" ? <Button type="submit" size="sm" variant="outline">{zh ? "重试" : "Retry"}</Button> : null} />
      ) : null}
      <Panel>
        <Panel.Body className="flex flex-col gap-3 pt-5">
          <AsyncButton type="submit" size="lg" className="self-start" pending={j.busy === "sim"} pendingLabel={tv(locale, "st_watch_creating")} disabled={blocked} disabledReason={blocked ? (zh ? "先修改上面标红的字段。" : "Fix the highlighted fields above first.") : null}>
            {observed ? (zh ? "继续查看这次观察" : "Continue this observation") : tv(locale, "st_watch_cta")}<ArrowRight aria-hidden="true" />
          </AsyncButton>
          <p className="text-xs text-fg-3">{zh ? "这是观察模式，不执行链上交易；每个钱包每天最多 3 个观察任务。首次读写记录时可能要签一条登录消息，这不是交易，不产生费用。" : "Observation mode executes no on-chain trades; up to 3 observation tasks per wallet per day. The first access to records may ask you to sign a sign-in message. It is not a transaction and costs nothing."}</p>
        </Panel.Body>
      </Panel>
    </form>
  );
}
