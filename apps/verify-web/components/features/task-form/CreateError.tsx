"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { tf } from "./copy";
import type { CreateOutcome } from "./model";

type Failure = Exclude<CreateOutcome, { kind: "ok" }>;

/** 建任务失败的说明（发生了什么 + 怎么办）。托管准入被拒、观察次数用完各有自己的话；action 由页面给（如「改用观察」） */
export function CreateError({ outcome, action }: { outcome: Failure; action?: ReactNode }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const { title, body } = describe(outcome, locale, zh);
  const box = useRef<HTMLDivElement>(null);
  // 出错时把说明滚进视野（它在长表单底部，容易被底部操作条挡住）
  useEffect(() => { box.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [outcome]);
  return (
    <div ref={box} className="scroll-mb-24">
    <Alert variant="destructive" aria-live="polite">
      <CircleAlert aria-hidden="true" />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      <AlertDescription className="text-fg-2">
        {body}
        {outcome.kind === "fields" && outcome.rest.length ? <ul className="list-disc pl-4">{outcome.rest.map((r) => <li key={r}>{r}</li>)}</ul> : null}
        {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
      </AlertDescription>
    </Alert>
    </div>
  );
}

function describe(o: Failure, locale: "zh" | "en", zh: boolean): { title: string; body: string } {
  switch (o.kind) {
    case "hosted_closed":
      return { title: zh ? "这个钱包暂未开放托管服务" : "Hosted service is not open to this wallet", body: zh ? "托管运行目前只对受邀钱包开放。观察模式所有钱包都能用；也可以在开发者页接入你自己的 Agent。" : "Hosted runs are invite-only for now. Observation works for every wallet, or connect your own agent from the developer page." };
    case "sim_limit":
      return { title: zh ? "今天的观察次数用完了" : "Today's observations are used up", body: tv(locale, "st_sim_limit") };
    case "unreachable":
      return { title: zh ? "服务没有回应" : "The service did not answer", body: zh ? "请求编号已保存，重试会用同一个编号，不会重复创建任务。" : "The request ID is saved; retrying reuses it and will not create a duplicate task." };
    case "mismatch":
      return { title: zh ? "返回的任务与请求不一致" : "The returned task does not match", body: zh ? "已停止后续操作。请到任务列表检查记录。" : "Nothing else was done. Check the task list before continuing." };
    case "fields":
      return { title: tf(locale, "fix_fields"), body: "" };
    default:
      return { title: zh ? "任务没有创建" : "The task was not created", body: o.message };
  }
}
