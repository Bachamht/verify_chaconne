"use client";
/** 后端错误码 → 人话（V-12）。未知码显示「请求失败（code）」，不把原始 JSON 甩给用户；工程细节留给控制台。 */
import type { Locale } from "./i18n";

const E: Record<string, { en: string; zh: string }> = {
  owner_required: { en: "A funding wallet address is required for this request.", zh: "这个请求需要一个资金钱包地址。" },
  missing_caller: { en: "A wallet address is required to identify your tasks.", zh: "需要钱包地址来识别你的任务。" },
  input_required: { en: "Some required fields are missing or invalid.", zh: "有必填项缺失或格式不对。" },
  invalid_request: { en: "The request has invalid fields.", zh: "请求里有不合法的字段。" },
  asset_unsupported: { en: "That asset is not in the verified registry.", zh: "这个资产不在已核验登记表里。" },
  job_not_found: { en: "Task not found, or it belongs to another wallet.", zh: "找不到任务，或它属于另一个钱包。" },
  mandate_not_found: { en: "Authorization not found, or it belongs to another wallet.", zh: "找不到授权计划，或它属于另一个钱包。" },
  plan_not_found: { en: "Plan not found.", zh: "找不到规划。" },
  entitlement_exhausted: { en: "Re-verification allowance used up or expired — create a new task.", zh: "再核验额度已用完或已过期，请新建任务。" },
  mandate_not_active: { en: "This authorization is not active (paused, cancelled or finished).", zh: "这个授权计划不是活动状态（已暂停、取消或完成）。" },
  planguard_not_configured: { en: "PlanGuard is not configured on the service yet.", zh: "服务端尚未配置 PlanGuard。" },
  mandate_signature_invalid: { en: "The authorization signature does not match the owner.", zh: "授权签名与 owner 不匹配。" },
  mandate_rejected: { en: "The authorization was rejected by the registry/policy check.", zh: "授权计划未通过登记表/策略校验。" },
  mandate_already_registered: { en: "This authorization is already registered.", zh: "这个授权计划已经登记过了。" },
  candidate_requires_relaxed_limit: { en: "That candidate is blocked by your own limit; it cannot be turned into a task as-is.", zh: "这个候选被你自己的上限挡住，不能原样转成任务。" },
  idempotency_conflict: { en: "The same request id was used with different content.", zh: "同一个请求 id 被用于不同内容。" },
  rate_limited: { en: "Too many requests — wait a minute and retry.", zh: "请求太频繁，稍等一分钟再试。" },
  payment_required: { en: "Payment is required for this report.", zh: "这份报告需要付款。" },
  settlement_failed: { en: "Payment settlement failed; nothing was charged.", zh: "付款结算失败，未扣款。" },
  payment_unknown: { en: "Payment result unknown — reconciliation is running; do not pay again.", zh: "付款结果未知，正在对账；请勿重复付款。" },
  service_unreachable: { en: "The verification service is unreachable right now.", zh: "核验服务暂时不可达。" },
  invalid_json: { en: "The service returned something that is not JSON.", zh: "服务返回的不是 JSON。" },
  step_expired: { en: "The step certificate expired — prepare the step again.", zh: "步骤证明已过期，请重新准备。" },
  attempt_rejected: { en: "This execution attempt was rejected.", zh: "这次执行尝试已被拒绝。" },
  tx_hash_conflict: { en: "This attempt is already bound to another transaction.", zh: "这次尝试已绑定另一笔交易。" },
  share_not_found: { en: "This report is private or does not exist.", zh: "这份战报是私密的或不存在。" },
};

/** 把 {status, data:{error,message,details}} 变成一句人话 */
export function apiError(r: { status: number; data: unknown }, locale: Locale): string {
  const d = (r.data ?? {}) as { error?: string; message?: string; details?: unknown };
  const code = d.error;
  if (code && E[code]) {
    const detail = Array.isArray(d.details) ? fieldsOf(d.details) : "";
    return E[code]![locale] + (detail ? ` (${detail})` : "");
  }
  if (r.status === 404) return E["job_not_found"]![locale];
  if (r.status === 429) return E["rate_limited"]![locale];
  if (r.status === 502 || r.status === 503) return E["service_unreachable"]![locale];
  const tail = code ? `${code}` : `HTTP ${r.status}`;
  return locale === "zh" ? `请求失败（${tail}）` : `Request failed (${tail})`;
}

export function errorText(code: string | undefined, locale: Locale, fallback?: string): string {
  if (code && E[code]) return E[code]![locale];
  if (fallback) return fallback;
  return locale === "zh" ? `请求失败（${code ?? "unknown"}）` : `Request failed (${code ?? "unknown"})`;
}

function fieldsOf(details: unknown[]): string {
  return details
    .map((x) => (x && typeof x === "object" && "field" in x ? String((x as { field: unknown }).field) : null))
    .filter((x): x is string => !!x)
    .slice(0, 4)
    .join(", ");
}
