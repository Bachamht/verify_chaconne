/**
 * 任务详情顶部的一眼摘要（VERIFY-UX-REVIEW P2）：已完成什么 / 谁负责执行 / 还缺什么 / 下一步。
 * 全部由服务端返回的状态、模式、执行器状态与步数推导；不猜测服务没给的信息。纯函数，页面与测试共用。
 */
import type { Locale } from "@/lib/i18n";
import type { TaskCreated } from "@/lib/api-v2";
import { formatTime } from "@/lib/format";
import { blockerSentence, statusLabel } from "./taskTitle";

export interface TaskSummary {
  /** 进度：已确认几步 / 计划几步（或状态本身） */
  progress: string;
  /** 谁来执行 */
  executor: string;
  /** 还缺什么才能继续（null = 不缺） */
  missing: string | null;
  /** 下一步 */
  next: string;
}

export function taskSummary(view: Pick<TaskCreated, "task" | "mode" | "steps" | "mandateDraft">, locale: Locale): TaskSummary {
  const zh = locale === "zh";
  const { task } = view;
  const mode = view.mode ?? (view.mandateDraft || task.mandateIds.length ? "LIVE" : "SIMULATION");
  const sim = mode === "SIMULATION";
  const steps = view.steps;
  const terminal = ["COMPLETED", "REVOKED", "EXPIRED", "CANCELLED"].includes(task.status);
  const progress = steps
    ? (zh ? `已确认 ${steps.confirmed} / ${steps.planned} 步 · ${statusLabel(task.status, locale)}` : `${steps.confirmed} of ${steps.planned} steps confirmed · ${statusLabel(task.status, locale)}`)
    : statusLabel(task.status, locale);

  const executor = sim
    ? (zh ? "模拟任务不需要执行者：只判断条件，不签发证书、不交易。" : "A simulation needs no executor: it only evaluates conditions and never issues certificates or trades.")
    : task.executorPresence === "online"
      ? (zh ? "你的执行 Agent 在线，可以取走证书执行。" : "Your execution agent is online and can take certificates to execute.")
      : task.executorPresence === "awaiting_signature"
        ? (zh ? "等你在钱包里签名后，由浏览器钱包执行。" : "Executes from your browser wallet once you sign.")
        : (zh ? "目前没有执行者在线：证书仍会签发，但没人执行；连接钱包或启动你的执行 Agent。" : "No executor is online right now: certificates would still be issued, but nobody executes them. Connect a wallet or start your execution agent.");

  let missing: string | null = null;
  if (task.status === "AWAITING_AUTHORIZATION") missing = zh ? "缺一次授权签名（TradeMandate）。签名前会展示额度、每次上限与有效期。" : "One authorization signature (TradeMandate). Caps, per-step limit and expiry are shown before you sign.";
  else if (task.status === "PAUSED") missing = zh ? "任务已暂停，需要你点「继续」。" : "The task is paused; resume it to continue.";
  else if (!sim && !terminal && task.executorPresence === "offline") missing = zh ? "缺一个在线的执行者。" : "An online executor.";

  let next: string;
  if (terminal) next = zh ? "任务已结束，不会再签发新的步骤。" : "The task has ended; no further steps will be issued.";
  else if (task.status === "AWAITING_AUTHORIZATION") next = zh ? "在下方「动作」里签署授权。" : "Sign the authorization under Actions below.";
  else if (task.status === "PAUSED") next = zh ? "点「继续」后恢复按条件检查。" : "Resume to continue checking conditions.";
  else if (task.status === "STEP_PREPARED") next = zh ? "本步已就绪，等待执行者提交。" : "This step is ready and waits for the executor to submit it.";
  else if (task.blockers.length > 0) {
    const why = blockerSentence(task.blockers[0]!, locale);
    const more = task.blockers.length > 1 ? (zh ? `（还有 ${task.blockers.length - 1} 项）` : ` (+${task.blockers.length - 1} more)`) : "";
    next = task.nextCheckAt
      ? (zh ? `等待：${why}${more} 下次检查 ${formatTime(task.nextCheckAt, locale)}。` : `Waiting: ${why}${more} Next check ${formatTime(task.nextCheckAt, locale)}.`)
      : (zh ? `等待：${why}${more}` : `Waiting: ${why}${more}`);
  } else next = task.nextCheckAt
    ? (zh ? `没有阻塞项；下次检查 ${formatTime(task.nextCheckAt, locale)}。` : `No blockers; next check ${formatTime(task.nextCheckAt, locale)}.`)
    : (zh ? "没有阻塞项；服务未给出下次检查时间。" : "No blockers; the service has not given a next check time.");
  return { progress, executor, missing, next };
}
