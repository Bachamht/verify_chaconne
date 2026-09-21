/** 全站共享类型（§4 / §5 / §7 术语见 §14.1） */

export type Session = "PRE" | "REGULAR" | "POST" | "CLOSED" | "HOLIDAY";

export type Quality = "ok" | "degraded" | "quarantined";

export type IssuerModel = "price_tracking" | "total_return";

export type Chain = "solana" | "ethereum" | "bnb" | "base" | "arbitrum";

export type StepJumpSeverity = "none" | "minor" | "major";

export type TokenPriceSource = "jupiter_quote" | "jupiter_price" | "dexscreener" | "gecko";

export type RefPriceSource = "pyth" | "finnhub";

/** data_events.kind（§4）+ 运营事件 */
export type DataEventKind =
  | "step_jump"
  | "source_conflict"
  | "reclassify_suggest"
  | "feed_stale"
  | "quality_change"
  | "rate_limited"
  | "shadow_audit_mismatch"
  | "calendar_reminder"
  | "label_change";
