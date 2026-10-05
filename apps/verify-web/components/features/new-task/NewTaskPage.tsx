"use client";
/**
 * /agent/new 新建 / 确认（方案 §5.4）：唯一的任务创建入口。
 * 职责：把一个目标 + 范围交给托管 Chaconne Agent；主动作「先观察（模拟）」，次动作「直接真实运行」（二次确认）。
 * 状态：资产登记表四态（AssetsGate）；字段错误在字段下（本地校验 + 服务端 400 details[].field）；托管准入 / 观察次数 / 不可达各有说明。
 * 不做：签名授权（在任务控制台完成）、自带 Agent 与执行器选择（开发者页）、模板条件规则。
 */
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ModeTag } from "@/components/kit/StatusBadge";
import { PageHeader } from "@/components/kit/PageHeader";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { useAccount } from "@/lib/useAccount";
import { v7FixtureRequested } from "@/lib/v7";
import { FX_OWNER } from "@/lib/v7fixtures";
import { AssetsGate } from "../task-form/AssetsGate";
import { CreateError } from "../task-form/CreateError";
import { peekText } from "../task-form/model";
import { ScopeSummary } from "../task-form/ScopeSummary";
import { SummaryLayout } from "../task-form/SummaryLayout";
import { TaskFormFields } from "../task-form/TaskFormFields";
import { useTradableAssets } from "../task-form/useTradableAssets";
import { NewTaskActionBar } from "./NewTaskActionBar";
import { useNewTask } from "./useNewTask";

export function NewTaskPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const fixture = v7FixtureRequested(sp.toString());
  const account = useAccount();
  const owner = fixture ? FX_OWNER : account;
  const assets = useTradableAssets(fixture);
  const f = useNewTask({ assets, owner, fixture });
  const sym = f.stable?.displaySymbol ?? "";
  return (
    <div className="min-w-0">
      <PageHeader
        title={zh ? "新建任务" : "New task"}
        description={zh ? "交代目标和范围。先让 Agent 观察给你看，满意了再交给它真实运行。" : "Set a goal and a scope. Let the agent observe first, then hand it over for real when you are satisfied."}
        badges={fixture ? <ModeTag mode="FIXTURE" /> : null}
      />
      {fixture ? <p className="mb-4 text-sm text-warn">{tv(locale, "fixture_note")}</p> : null}
      <AssetsGate assets={assets}>
        {f.draft ? (
          <>
            <SummaryLayout
              peek={peekText(f.draft, sym, locale)}
              summary={<ScopeSummary draft={f.draft} stable={f.stable} assets={assets.assets} />}
              main={<>
                {f.note ? <Alert><Info aria-hidden="true" /><AlertDescription className="text-fg-2">{f.note}</AlertDescription></Alert> : null}
                <TaskFormFields value={f.draft} template={f.template} onTemplate={f.pickTemplate} onChange={f.edit} assets={assets} errors={f.errors} disabled={f.pending !== null} />
                {f.failure ? (
                  <CreateError outcome={f.failure} action={
                    f.failure.kind === "hosted_closed" && f.lastMode === "LIVE" ? <Button size="sm" variant="outline" onClick={() => void f.create("SIMULATION")}>{zh ? "改用观察（模拟）" : "Observe instead"}</Button>
                    : f.failure.kind === "sim_limit" || f.failure.kind === "mismatch" ? <Button size="sm" variant="outline" asChild><Link href="/agent/tasks">{zh ? "查看任务列表" : "Open tasks"}</Link></Button>
                    : f.failure.kind === "unreachable" ? <Button size="sm" variant="outline" onClick={() => void f.retry()}>{zh ? "重试" : "Retry"}</Button>
                    : null
                  } />
                ) : null}
              </>}
            />
            <NewTaskActionBar draft={f.draft} valid={f.valid && !!owner} pending={f.pending} onCreate={f.create} />
          </>
        ) : null}
      </AssetsGate>
    </div>
  );
}
