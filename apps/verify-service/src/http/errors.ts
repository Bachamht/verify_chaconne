/**
 * 错误正文英文优先（V-41 / V-28）：`message` 固定英文，原中文放 `messageZh`（不丢），`error`（code）与 `details` 结构不变。
 * 服务内部抛错处仍可写中文（日志与运营者看），对外一律经 errorBody() 出。
 */
import { HttpError } from "../jobs/service";

/** 精确中文 → 英文（按原文匹配；未列出的按 code 兜底） */
const ZH_EN: Record<string, string> = {
  "该股票代币未放行执行": "This stock token is not enabled for execution",
  "资产不在登记表内（见 GET /v1/assets）": "Asset is not in the registry (see GET /v1/assets)",
  "inputAssetKey 必须是登记表内的资金币种": "inputAssetKey must be a funding stablecoin from the registry",
  "outputAssetKey 必须是登记表内的股票代币": "outputAssetKey must be a stock token from the registry",
  "该候选需要用户显式放宽限制，不可直接转任务": "This candidate requires the user to explicitly relax a limit; it cannot be turned into a job directly",
  "再核验额度已用尽或已过期；需要新建任务": "Re-verification entitlement is used up or expired; create a new job",
  "需要 eventId": "eventId is required",
  "只有任务 owner 可读取等待诊断与对照": "Only the task owner can read the wait diagnosis and comparisons",
  "同一 clientRequestId 已绑定不同任务": "This clientRequestId is already bound to a different task",
  "同一 clientRequestId 已绑定不同授权计划": "This clientRequestId is already bound to a different mandate",
  "同一 clientRequestId 已绑定不同规划目标": "This clientRequestId is already bound to a different plan goal",
  "同一 clientRequestId 已绑定不同请求内容": "This clientRequestId is already bound to a different request",
  "授权资金币种与资金组不一致": "The mandate's funding asset does not match the budget group",
  "TradeIntent 签名不是 owner 签的": "The TradeIntent signature was not produced by the owner",
  "条件校验失败": "Condition validation failed",
  "horizonHours 需为正数": "horizonHours must be a positive number",
  "owner 须为 EVM 地址": "owner must be an EVM address",
  "模板参数校验失败": "Playbook parameter validation failed",
  "deadline 必须在未来": "deadline must be in the future",
  "任务请求校验失败": "Task request validation failed",
  "回放参数校验失败": "Replay parameter validation failed",
  "复核项校验失败": "Review item validation failed",
  "授权计划字段非法": "Invalid mandate fields",
  "授权计划校验失败": "Mandate validation failed",
  "模拟目标校验失败": "Simulation goal validation failed",
  "理由卡校验失败": "Thesis card validation failed",
  "策略参数超范围": "Policy parameter out of range",
  "自报成本参数校验失败": "Cost override validation failed",
  "规划目标校验失败": "Plan goal validation failed",
  "角色校验失败": "Profile validation failed",
  "请求校验失败": "Request validation failed",
  "调仓参数校验失败": "Rebalance parameter validation failed",
  "资金组参数校验失败": "Budget group parameter validation failed",
  "需要 { items: Condition[] }": "Expected { items: Condition[] }",
  "需要 kind 与 refId": "kind and refId are required",
  "需要 kind (job|plan) 与 from / refId (id)": "kind (job|plan) and from / refId (id) are required",
  "双策略对照需要恰好两套 variants": "A policy comparison needs exactly two variants",
  "amountRaw 不能超过授权剩余额度": "amountRaw cannot exceed the mandate's remaining budget",
  "amountRaw 须为十进制整数串": "amountRaw must be a decimal integer string",
  "chatId 须为 Telegram 数字 chat id": "chatId must be a numeric Telegram chat id",
  "clientRequestId 必填": "clientRequestId is required",
  "executionChainId 与服务配置不一致": "executionChainId does not match the service configuration",
  "mandate 必填": "mandate is required",
  "mandateId 必填": "mandateId is required",
  "ownerAddress 须为 EVM 地址": "ownerAddress must be an EVM address",
  "priority 须为非负整数": "priority must be a non-negative integer",
  "secret 须为 16–256 字符（用于 HMAC-SHA256 签名）": "secret must be 16–256 characters (used for HMAC-SHA256 signing)",
  "status 只能是 holds|invalidated|unknown": "status must be one of holds | invalidated | unknown",
  "taskId 必填": "taskId is required",
  "url 非法": "Invalid url",
  "validUntil 必须是未来的 ISO 时间": "validUntil must be an ISO timestamp in the future",
  "webhook 须为 https": "webhook url must be https",
  "签署的授权与该腿草案不一致": "The signed mandate does not match this leg's draft",
  "同一 mandateDigest 已登记": "This mandateDigest is already registered",
  "授权计划与登记表/策略不一致": "The mandate does not match the registry / policy",
  "mandate.effectivePolicyHash 与任务当前条件（conditionsHash）不一致：改条件 = 新授权（K-09）": "mandate.effectivePolicyHash does not match the task's current conditions (conditionsHash): changed conditions require a new authorization (K-09)",
  "TradeMandate 签名不是 owner 签的": "The TradeMandate signature was not produced by the owner",
  "任务还没有落库的评估证据，无法固定同一快照；等 monitor 评估一次后再对照": "The task has no stored evaluation yet, so a shared evidence snapshot cannot be fixed; compare after the monitor has evaluated it once",
  "该规划没有可推荐候选": "This plan has no recommended candidate",
  "当前持仓已在目标权重内（或价格未知），没有可执行的腿": "Holdings are already within target weights (or prices are unknown); there is no leg to execute",
  "调用方不能代表该 owner：需要受信代理的 x-verify-caller，或此前已为该地址登记过任务/授权": "This caller cannot act for that owner: a trusted proxy's x-verify-caller is required, or the address must already have a job/mandate registered by this caller",
  "只能查询与调用方绑定的 owner": "Only the owner bound to this caller can be queried",
  "授权 owner 与资金组 owner 不一致": "The mandate owner does not match the budget group owner",
  "需要 owner=<EVM 地址>": "owner=<EVM address> is required",
  "该调用方需要在请求体给出 ownerAddress": "This caller must provide ownerAddress in the request body",
  "报告尚未付款": "The report has not been paid for yet",
  "规划尚未付款": "The plan has not been paid for yet",
  "归属周期与组周期不一致": "The attributed period does not match the group's period",
  "授权期限超出组周期：注册时必须指定归属周期（attributedPeriod）": "The mandate deadline exceeds the group's period: specify attributedPeriod when registering",
  "策略参数越界": "Policy parameter out of range",
  "没有可挂复核项的 research 前提": "No research premise to attach the review item to",
  "机器前提由条件求值决定，不能手动标记": "Machine premises are decided by condition evaluation and cannot be marked manually",
  "复核项只能挂在 research 前提上（机器/时间门前提由条件求值决定）": "Review items can only be attached to research premises (machine / timing premises are decided by condition evaluation)",
  "资金组只统计买入支出；卖出授权不占预算，卖出收入也不恢复额度": "Budget groups only count buy-side spend; sell mandates take no budget and sell proceeds do not restore it",
  "SIMULATION 任务不需要授权": "SIMULATION tasks need no authorization",
  "该步骤证书已过期，需重新 prepare-step": "This step certificate has expired; call prepare-step again",
  "任务不存在或不属于该调用方": "Task not found or not owned by this caller",
  "任务不存在（或 Lane B 任务表尚未接入）": "Task not found",
  "该任务已有理由卡；用 review-items / premises 更新": "This task already has a thesis card; update it via review-items / premises",
  "该尝试已绑定另一笔交易": "This attempt is already bound to another transaction",
  "LIVE 任务需要 PLANGUARD_ADDRESS；可先用 mode=SIMULATION": "LIVE tasks need PLANGUARD_ADDRESS on this deployment; use mode=SIMULATION meanwhile",
  "该 key 需要 x-verify-caller: <EVM 地址>": "This key requires x-verify-caller: <EVM address>",
  "未配置 FINNHUB_API_KEY": "FINNHUB_API_KEY is not configured on this deployment",
};

const CJK = /[㐀-鿿＀-￯　-〿]/;

/** 字段级 details[].message（core validate.ts 等）的中文 → 英文 */
const DETAIL_ZH_EN: Record<string, string> = {
  "请求体必须是对象": "Request body must be an object",
  "1–128 位 [A-Za-z0-9_-:.]": "1–128 characters of [A-Za-z0-9_-:.]",
  "非法 EVM 地址": "Invalid EVM address",
  "不能是零地址": "Must not be the zero address",
  "必须是正整数": "Must be a positive integer",
  "格式 eip155:<chainId>:<小写地址>": "Format eip155:<chainId>:<lowercase address>",
  "与 executionChainId 不一致": "Does not match executionChainId",
  "输入输出资产不能相同": "Input and output assets must differ",
  "必须是十进制整数字符串": "Must be a decimal integer string",
  "必须大于 0": "Must be greater than 0",
  "超过硬上限": "Exceeds the hard cap",
  "首版仅支持 exactIn": "Only exactIn is supported",
  "side 只能是 buy 或 sell": "side must be buy or sell",
  "未知策略": "Unknown policy",
  "未知策略版本": "Unknown policy version",
  "必须显式给出": "Must be given explicitly",
};
const DETAIL_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^(.+?)=(.+?) 不在 \[(.+?), (.+?)\]$/, (m) => `${m[1]}=${m[2]} is outside [${m[3]}, ${m[4]}]`],
  [/^(.+?) 必须是整数或 null$/, (m) => `${m[1]} must be an integer or null`],
];

function englishDetail(message: string, field: unknown, code: unknown): string {
  const hit = DETAIL_ZH_EN[message];
  if (hit) return hit;
  for (const [re, fn] of DETAIL_PATTERNS) {
    const m = message.match(re);
    if (m) return fn(m);
  }
  return [typeof field === "string" ? field : "", typeof code === "string" ? code.replace(/_/g, " ") : ""].filter(Boolean).join(": ") || "Invalid";
}

/** details 里凡是带中文 message 的对象（数组项或 fields[] 项）都改成英文 + messageZh；其它原样 */
export function translateDetails(details: unknown): unknown {
  if (Array.isArray(details)) return details.map(translateDetails);
  if (!details || typeof details !== "object") return details;
  const o = details as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };
  if (typeof o["message"] === "string" && CJK.test(o["message"]) && typeof o["messageZh"] !== "string") {
    out["message"] = englishDetail(o["message"], o["field"], o["code"]);
    out["messageZh"] = o["message"];
  }
  for (const k of ["fields", "errors", "problems"]) if (Array.isArray(o[k])) out[k] = translateDetails(o[k]);
  return out;
}

/** code → 通用英文（原文未列出时） */
function englishForCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Request failed";
}

export function englishMessage(code: string, message: string | undefined): { message: string; messageZh?: string } {
  if (!message || message === code) return { message: englishForCode(code) };
  if (!CJK.test(message)) return { message };
  return { message: ZH_EN[message] ?? englishForCode(code), messageZh: message };
}

/** 对外错误正文：{ error, message(EN), messageZh?, details? } */
export function errorBody(err: HttpError): { error: string; message: string; messageZh?: string; details?: unknown } {
  const m = englishMessage(err.code, err.message);
  return { error: err.code, message: m.message, ...(m.messageZh ? { messageZh: m.messageZh } : {}), details: err.details === undefined || err.details === null ? undefined : translateDetails(err.details) };
}
