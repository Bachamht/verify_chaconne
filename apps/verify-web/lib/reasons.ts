/** 原因码 → 人话（zh/en）。工程字段留给开发者详情。 */
import type { Locale } from "./i18n";

const R: Record<string, { en: string; zh: string }> = {
  ASSET_UNSUPPORTED: { en: "Asset is not in the verified registry (chain + contract).", zh: "资产不在已核验登记表内（链+合约）。" },
  REGISTRY_MISMATCH: { en: "Registry data does not match the request or the chain.", zh: "登记数据与请求或链上不一致。" },
  SOURCE_TIME_MISSING: { en: "Reference source did not provide a publish time — cannot claim it is live.", zh: "参考源没有给出发布时间 — 不能称为实时。" },
  SOURCE_TIME_FUTURE: { en: "A source timestamp is in the future beyond tolerance.", zh: "源时间超前本地时钟超出容忍。" },
  REFERENCE_MISSING: { en: "No stock reference price available.", zh: "没有可用的股票参考价。" },
  REFERENCE_STALE: { en: "Stock reference is older than the policy allows.", zh: "股票参考价比策略允许的更旧。" },
  REFERENCE_PROVISIONAL: { en: "Only a provisional / unofficial close is available — not accepted as an official close.", zh: "只有临时/非正式收盘 — 不作为正式收盘接受。" },
  REFERENCE_DEVIATION_EXCEEDED: { en: "Executable price deviates from the reference beyond your limit.", zh: "可执行单价相对参考价的偏差超过你的上限。" },
  MARKET_OUTSIDE_REGULAR: { en: "US market is outside regular hours — STRICT_LIVE refuses (this is correct, not a failure).", zh: "美股不在常规时段 — STRICT_LIVE 拒绝（这是正确结果，不是故障）。" },
  CLOSE_SESSION_MISMATCH: { en: "The close on file is not the most recent completed trading day.", zh: "收盘记录不是最近一个已完成交易日。" },
  SOURCE_CONFLICT: { en: "Two sources disagree beyond tolerance.", zh: "两个来源冲突超过容忍。" },
  TOKEN_UNIT_UNVERIFIED: { en: "Token-to-share conversion is not verified.", zh: "代币与股数换算未核验。" },
  USD_CONVERSION_UNKNOWN: { en: "Stablecoin USD price unavailable — not assumed to be 1.", zh: "稳定币美元价不可得 — 不默认为 1。" },
  QUOTE_UNAVAILABLE: { en: "No executable route/quote for this amount.", zh: "该金额没有可成交路由/报价。" },
  QUOTE_TOO_OLD: { en: "Quote is older than allowed — re-verify.", zh: "报价过旧 — 请再核验。" },
  PRICE_IMPACT_UNKNOWN: { en: "Price impact unknown — not treated as zero.", zh: "价格冲击未知 — 不当作 0。" },
  PRICE_IMPACT_EXCEEDED: { en: "Price impact exceeds your limit.", zh: "价格冲击超过你的上限。" },
  ROUTE_UNSUPPORTED: { en: "Route is not in the verified set for Guard execution.", zh: "路由不在 Guard 已验证范围。" },
  MIN_OUT_INVALID: { en: "Minimum output rounds to zero.", zh: "最小到账量为 0。" },
  AMOUNT_OUT_OF_RANGE: { en: "Amount out of range.", zh: "金额越界。" },
  POLICY_PARAM_OUT_OF_RANGE: { en: "A policy parameter is out of range.", zh: "策略参数越界。" },
  COMPARISON_NOT_REQUESTED: { en: "QUOTE_ONLY: stock reference comparison not performed by design.", zh: "QUOTE_ONLY：按设计不做股票参考比较。" },
  CLOSE_CROSS_VERIFIED: { en: "Close cross-verified by two sources.", zh: "收盘价经两源交叉核验。" },
  UNIT_CHANGED: { en: "The token's unit multiplier changed during the monitoring window; the plan must be recomputed.", zh: "监测窗口内代币单位乘数发生变化，需要重新规划。" },
  CLOSE_UNCONFIRMED: { en: "Close taken from the 16:00 ET last trade; not yet confirmed by the next session's previous close.", zh: "收盘价取自 16:00 ET 最后一笔成交，尚未经次日前收确认。" },
  STEP_AWAITING_CONFIRMATION: { en: "This step is already submitted; the next step waits for its on-chain confirmation.", zh: "本步已提交，下一步要等它链上确认后才发出。" },
  /* ---- v6 条件层阻塞码（V-32：阻塞项用短句，不露原始码） ---- */
  CONTEXT_UNAVAILABLE: { en: "Market context is unavailable right now; waiting for it to come back.", zh: "市场上下文暂时不可用，等它恢复。" },
  CONTEXT_STALE: { en: "Market context is older than allowed; waiting for a fresh package.", zh: "市场上下文比允许的更旧，等新的一包。" },
  CONTEXT_FIELD_NOT_IN_TIER: { en: "A field this rule needs is not in the free context tier.", zh: "这条规则需要的字段不在免费档上下文里。" },
  EVENT_WINDOW_ACTIVE: { en: "Inside your event window: nothing is issued until the window closes.", zh: "处于你设定的事件窗口内：窗口结束前不签发。" },
  EVENT_DATE_UNCERTAIN: { en: "This event has a date but no time; choose whole-day wait or ignore it.", zh: "该事件只有日期、没有具体时刻：需要你选择整日等待或忽略。" },
  EARNINGS_WINDOW_ACTIVE: { en: "Inside your earnings window: issuance pauses around the report.", zh: "处于你设定的财报窗口内：财报前后暂停签发。" },
  EARNINGS_COVERAGE_UNKNOWN: { en: "The earnings calendar does not cover this asset; treated as unknown, not as no earnings.", zh: "财报日历未覆盖该资产：按未知处理，不当作没有财报。" },
  FED_BLACKOUT: { en: "Inside the Fed blackout period you chose to avoid.", zh: "处于你选择避开的联储静默期。" },
  VOL_REGIME_EXCEEDED: { en: "Volatility is above the limit you set.", zh: "波动率高于你设的上限。" },
  SESSION_RULE_BLOCK: { en: "The US market is outside the session you allowed (regular hours only).", zh: "现在不在你允许的美股时段（只在常规时段买）。" },
  CROSS_ASSET_UNCONFIRMED: { en: "Cross-asset confirmation is not available yet.", zh: "跨资产确认还没有出现。" },
  STEP_GAP_NOT_ELAPSED: { en: "The minimum gap since the last confirmed step has not elapsed.", zh: "距离上一步确认还没过最小间隔。" },
  DAILY_STEP_CAP_REACHED: { en: "Today's step cap is reached; the next step waits for the next trading day.", zh: "今天的步数上限已到，下一步等下一个交易日。" },
  PREMIUM_CONDITION_NOT_MET: { en: "The on-chain premium is above your threshold.", zh: "链上溢价高于你设的阈值。" },
  TARGET_NOT_REACHED: { en: "The target price has not been reached.", zh: "还没到你设的目标价。" },
  TRACKED_COST_UNKNOWN: { en: "Part of the position has no traced cost, so the P&L rule cannot be evaluated.", zh: "部分持仓没有可追溯成本，盈亏规则无法判定。" },
  CASH_FLOOR_BLOCK: { en: "This step would go below your cash floor.", zh: "这一步会跌破你的现金下限。" },
  BUDGET_GROUP_CONFLICT: { en: "Another task in the same budget group has priority right now.", zh: "同一资金组里另一个任务现在优先。" },
  BUDGET_GROUP_EXHAUSTED: { en: "The budget group's cap for this period is used up.", zh: "资金组本期上限已用完。" },
  BUDGET_PENDING_OCCUPIED: { en: "The budget is occupied by a step still awaiting confirmation.", zh: "预算被一笔尚未确认的步骤占着。" },
  THESIS_INVALIDATED: { en: "A checked premise of the thesis no longer holds; the task needs your decision.", zh: "理由卡里一条机器核对的前提不再成立，需要你决定。" },
  THESIS_UNKNOWN: { en: "A thesis premise cannot be checked yet.", zh: "理由卡里有前提暂时无法核对。" },
  THESIS_EXPIRED: { en: "The thesis has expired; renew it or stop the task.", zh: "理由卡已到期，续一张或停止任务。" },
  EXECUTOR_OFFLINE: { en: "No executor is online; certificates are still issued, nobody executes them.", zh: "没有执行器在线：证书仍会签发，但没有人来执行。" },
  AWAITING_USER_SIGNATURE: { en: "Waiting for your wallet signature.", zh: "等待你的钱包签名。" },
};

export function reasonText(code: string, locale: Locale): string {
  return R[code]?.[locale] ?? code;
}
export function hasReasonText(code: string): boolean {
  return code in R;
}
