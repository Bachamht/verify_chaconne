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
  timeout: { en: "The service did not answer within 30 s.", zh: "服务 30 秒内没有回应。" },
  invalid_playbook_params: { en: "Some task fields need attention.", zh: "任务里有几个字段需要修正。" },
  task_not_found: { en: "Task not found, or it belongs to another wallet.", zh: "找不到任务，或它属于另一个钱包。" },
  invalid_transition: { en: "The task cannot move to that state from where it is now.", zh: "任务当前状态不允许这个操作。" },
};

/** 字段级校验码 → 人话（V-24：400 invalid_playbook_params 的 details[].code） */
const F: Record<string, { en: string; zh: string }> = {
  required: { en: "Required", zh: "必填" },
  unknown_param: { en: "Not accepted by this playbook", zh: "这个模板不接受此参数" },
  expected_integer_in_range: { en: "Must be a whole number within the allowed range", zh: "需为允许范围内的整数" },
  expected_number_in_range: { en: "Must be a number within the allowed range", zh: "需为允许范围内的数字" },
  expected_positive_raw_amount: { en: "Must be a positive amount", zh: "需为正数金额" },
  expected_positive_decimal_string: { en: "Must be a positive number", zh: "需为正数" },
  expected_asset_key: { en: "Pick an asset from the registry", zh: "请从登记表里选一个资产" },
  not_stable_input: { en: "Must be a funding currency from the registry", zh: "必须是登记表里的资金币种" },
  must_be_future: { en: "Must be in the future", zh: "必须是未来的时间" },
  expected_boolean: { en: "Must be yes or no", zh: "需为是/否" },
  expected_iso: { en: "Must be a valid date/time", zh: "需为有效的日期时间" },
  unknown_policy: { en: "Unknown policy", zh: "未知策略" },
  unknown_version: { en: "Unknown policy version", zh: "未知策略版本" },
  require_one_of: { en: "One of these is required", zh: "其中至少填一项" },
};
export function fieldErrorText(code: string, locale: Locale): string {
  return F[code]?.[locale] ?? (locale === "zh" ? `不合法（${code}）` : `Invalid (${code})`);
}
/** details[] → { field → 人话 }；字段名去掉 params. 前缀 */
export function fieldErrors(details: unknown, locale: Locale): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(details)) return out;
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    const f = (d as { field?: unknown }).field;
    const c = (d as { code?: unknown }).code;
    if (typeof f !== "string") continue;
    const key = f.replace(/^params\./, "");
    if (!(key in out)) out[key] = fieldErrorText(typeof c === "string" ? c : "invalid", locale);
  }
  return out;
}

/** 把 {status, data:{error,message,details}} 变成一句人话 */
export function apiError(r: { status: number; data: unknown }, locale: Locale): string {
  const d = (r.data ?? {}) as { error?: string; message?: string; details?: unknown };
  const code = d.error;
  if (code && E[code]) {
    const detail = Array.isArray(d.details) ? fieldsOf(d.details) : "";
    return E[code]![locale] + (detail ? ` (${detail})` : "");
  }
  if (r.status === 0) return E["timeout"]![locale];
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
