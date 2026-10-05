/**
 * 托管 Agent 运行态里的服务端短句（packages/core/src/verify/agent/presence.ts：currentActivity / waitingFor）→ 本地化。
 * 服务端只给英文；中文页不原样显示英文（线上验收 10/3 发现 "reading the task context" 直出）。
 * 认不出的英文在中文页返回 null，由调用方退回到状态标签（「正在工作」「在等待」）。
 */
import type { Locale } from "./i18n";
import { formatAbs, toDate } from "./numbers";
import { hasReasonText, reasonText } from "./reasons";

const PHRASES: Record<string, string> = {
  "reading the task context": "读取任务上下文",
  "checking executable quotes": "查询可成交报价",
  "reading market context": "读取市场上下文",
  "checking the event calendar": "查看事件日历",
  "reviewing blockers": "检查阻塞项",
  "reviewing positions": "查看持仓",
  "reviewing recent activity": "回看最近的活动",
  "adding a thesis review item": "添加一条理由复核项",
  "submitting a trade intent": "提交交易意图",
  "withdrawing a trade intent": "撤回交易意图",
  "reporting a decision": "报告决定",
  "writing a note to task memory": "写入任务笔记",
  "reading an official source": "阅读官方来源",
  "thinking": "思考中",
  "event scheduled time passed; waiting for the actual value": "事件预定时间已过，在等实际值公布",
  "a certificate is in flight; waiting for it to settle or expire": "有一张证书正在执行，等它完成或过期",
  "waiting for the US regular session": "等美股常规时段",
  "the platform executor is sending the certified step": "平台执行身份正在发送已核验的这一步",
};

export function presenceText(text: string | null | undefined, locale: Locale): string | null {
  if (!text) return null;
  const t = text.trim();
  if (/[一-鿿]/.test(t)) return t; // 已经是中文（如示例数据）
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^waiting on: (.+)$/))) {
    const codes = m[1]!.split(/,\s*/);
    if (locale === "en") return codes.map((c) => (hasReasonText(c) ? reasonText(c, "en") : "another condition")).join("; ");
    return `在等：${codes.map((c) => (hasReasonText(c) ? reasonText(c, "zh") : "另一项条件")).join("；")}`;
  }
  if ((m = t.match(/^next check at (.+)$/))) {
    const d = toDate(m[1]!);
    if (!d) return null;
    return locale === "zh" ? `下次检查 ${formatAbs(d, "zh")}` : `Next check ${formatAbs(d, "en")}`;
  }
  if (locale === "en") return t;
  return PHRASES[t] ?? null;
}
