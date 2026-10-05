/**
 * 写操作（POST / DELETE）失败 → 一句人话 + 「什么都没发生」的保证。
 * 已知错误码走 lib/errors 的映射；未知码不把 SNAKE_CASE 露给用户（E5），按 HTTP 状态给通用说法。
 */
import { errorText } from "@/lib/errors";

export function writeErrorText(res: { status: number; data: unknown }, zh: boolean, nothingHappened: string): string {
  const code = (res.data as { error?: unknown } | null)?.error;
  const UNKNOWN = "\u0000";
  const known = typeof code === "string" ? errorText(code, zh ? "zh" : "en", UNKNOWN) : UNKNOWN;
  if (known !== UNKNOWN) return known;
  const s = res.status;
  const what = s === 0
    ? (zh ? "服务 30 秒内没有回应" : "The service did not answer within 30 seconds")
    : s === 401 ? (zh ? "登录已过期，请重新用钱包登录" : "Your sign-in expired. Sign in with your wallet again")
    : s === 403 ? (zh ? "服务拒绝了这次写入（HTTP 403）" : "The service refused this write (HTTP 403)")
    : s === 429 ? (zh ? "请求太频繁，稍等一分钟再试" : "Too many requests. Wait a minute and retry")
    : s >= 500 ? (zh ? `服务暂时出错（HTTP ${s}），稍后重试` : `The service hit an error (HTTP ${s}). Retry shortly`)
    : (zh ? `请求没有被接受（HTTP ${s}）` : `The request was not accepted (HTTP ${s})`);
  return zh ? `${what}。${nothingHappened}` : `${what}. ${nothingHappened}`;
}
