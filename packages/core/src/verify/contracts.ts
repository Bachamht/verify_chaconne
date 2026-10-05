/**
 * Chaconne Verify · 冻结接口契约（D-080 / docs/devday-2026/interfaces.md）
 *
 * 本文件是全部 lane（service / web / mcp / contracts）共用的**唯一类型事实来源**。
 * 冻结后改动必须新增 CV-D 决策条目并通知 Lane I。
 *
 * 约定：
 *  - 链上金额一律十进制整数字符串（最小代币单位），禁止 JS number；
 *  - 时间：链下 ISO-8601 UTC 字符串；链上 Unix 秒（uint64）；
 *  - 哈希：`0x` + 64 hex（keccak256）；
 *  - assetKey：`eip155:<chainId>:<小写地址>`；symbol 仅展示。
 */

/* ------------------------------------------------------------------ */
/* 基础标量                                                             */
/* ------------------------------------------------------------------ */

export type Hex = `0x${string}`;
export type Bytes32 = `0x${string}`;
export type EvmAddress = `0x${string}`;
/** 十进制整数字符串（最小单位） */
export type RawAmount = string;
/** 十进制小数字符串（不限精度，如 "123.45"） */
export type DecimalString = string;
/** ISO-8601 UTC（`YYYY-MM-DDTHH:mm:ss.sssZ`） */
export type IsoUtc = string;
/** `YYYY-MM-DD`（来源市场当地交易日） */
export type TradingDate = string;

/* ------------------------------------------------------------------ */
/* §4.1 资产身份                                                        */
/* ------------------------------------------------------------------ */

export type TokenForm = "plain" | "rebasing" | "vault_share";

export interface AssetRef {
  /** `eip155:<chainId>:<lowercase address>` */
  assetKey: string;
  chainId: number;
  tokenAddress: EvmAddress;
  /** 必须经链上/已核实元数据确认 */
  tokenDecimals: number;
  /** 本项目 registry 的稳定 ID（如 `xstocks`） */
  issuerId: string;
  /** 仅展示，不用于查库/缓存/签名匹配 */
  displaySymbol: string;
  /** 本项目登记的标的身份（如 `us-equity:AAPL`），不凭同名自动映射 */
  underlyingId: string;
  tokenForm: TokenForm;
  registryVersion: string;
}

/** 资产登记条目（人工复核 allowlist 的一行）。 */
export interface RegistryEntry extends AssetRef {
  /** 资产角色：可作交易输入（稳定币）/ 输出（股票代币） */
  role: "stable_input" | "stock_output";
  /** 股票代币：1 代币对应多少股（十进制串）；稳定币：null */
  sharesPerToken: DecimalString | null;
  /** 换算来源说明（发行商文档/链上 multiplier）与核验日期 */
  unitSource: { description: string; verifiedAt: IsoUtc } | null;
  /** 稳定币：美元计价核验方式（如 `paxos_usdg_attestation`）；股票代币 null */
  usdPegSource: string | null;
  /** 来源与核验记录（不含密钥） */
  provenance: Array<{ source: string; url?: string; verifiedAt: IsoUtc }>;
  /** 是否允许进入执行 allowlist */
  executionAllowed: boolean;
}

export interface AssetRegistry {
  version: string;
  /** 主网 196 / 测试网 1952 分别登记 */
  chainId: number;
  entries: RegistryEntry[];
}

/* ------------------------------------------------------------------ */
/* §4.3 证据时间                                                        */
/* ------------------------------------------------------------------ */

export type SourceTimeKind = "published" | "block" | "not_provided";

export interface EvidenceTime {
  /** 本服务发出请求 */
  requestedAt: IsoUtc;
  /** 本服务收到响应 */
  receivedAt: IsoUtc;
  /** 上游明确给出的源时间；无则 null */
  sourcePublishedAt: IsoUtc | null;
  sourceTimeKind: SourceTimeKind;
}

export interface BlockContext {
  chainId: number;
  blockNumber: string;
  blockHash: Bytes32 | null;
  blockTimestamp: IsoUtc | null;
}

/* ------------------------------------------------------------------ */
/* §5.1 创建任务                                                        */
/* ------------------------------------------------------------------ */

export type PolicyId = "STRICT_LIVE" | "REFERENCE_CONTEXT" | "QUOTE_ONLY";
export type TradeMode = "exactIn";

export interface CreateVerifyJob {
  /** 同一调用方范围内幂等 */
  clientRequestId: string;
  /** 交易资金所有者 */
  ownerAddress: EvmAddress;
  recipientAddress: EvmAddress;
  executionChainId: number;
  inputAssetKey: string;
  outputAssetKey: string;
  amountInRaw: RawAmount;
  mode: TradeMode;
  policyId: PolicyId;
  policyVersion: string;
  /** 用户滑点上限（bps，100 = 1%） */
  maxSlippageBps: number;
  /** 用户价格冲击上限；null = 未设置（策略仍要求该项可核验） */
  maxPriceImpactBps: number | null;
  /** 可执行单价相对参考价的允许偏差上限；null = 采用策略默认 */
  maxReferenceDeviationBps: number | null;
  /** v2 (A2 定稿)：交易方向；缺省 = "buy"（稳定币→股票代币）。"sell" = 股票代币→稳定币。requestHash 仅在 "sell" 时纳入该字段 */
  side?: "buy" | "sell";
}

/** 校验+规范化后的任务（服务内部/报告使用），全部字段已展开默认值。 */
export interface NormalizedJob {
  clientRequestId: string;
  ownerAddress: EvmAddress;
  recipientAddress: EvmAddress;
  executionChainId: number;
  inputAssetKey: string;
  outputAssetKey: string;
  amountInRaw: RawAmount;
  mode: TradeMode;
  policyId: PolicyId;
  policyVersion: string;
  params: EffectivePolicyParams;
  /** v2：见 CreateVerifyJob.side；缺省 buy */
  side?: "buy" | "sell";
}

/* ------------------------------------------------------------------ */
/* §5.2 规则（两层哈希）                                                */
/* ------------------------------------------------------------------ */

export type ReferenceRequirement = "live" | "official_close" | "none";

export interface ParamRange {
  min: number;
  max: number;
  default: number | null;
  /** 为 true 时用户必须显式给值（或有非 null 默认） */
  required: boolean;
}

/** 固定、版本化的策略定义（管理员在 Guard 中按其哈希启用/禁用）。 */
export interface PolicyDefinition {
  /** v2 (v1.1.0+)：REFERENCE_CONTEXT 可接受的收盘 kind；v1.0.0 定义无此字段（哈希不变） */
  acceptedCloseKinds?: ReferenceKind[];
  policyId: PolicyId;
  version: string;
  engineVersion: string;
  mode: TradeMode;
  referenceRequirement: ReferenceRequirement;
  /** `regular` = 须在常规交易时段；`any` = 不限 */
  sessionRequirement: "regular" | "any";
  /** 准备证明时 quote 自 receivedAt 至今允许的最大年龄 */
  quoteMaxAgeSeconds: number;
  /** 实时参考价源时间允许的最大年龄（仅 live） */
  liveReferenceMaxAgeSeconds: number;
  /** 收盘参考：自该交易日收盘以来允许错过的应捕获收盘数（0 = 必须是最近一个已完成交易日） */
  closeMaxSessionsSinceClose: number;
  /** close_cross_verified 两源价差容忍（bps） */
  closeCrossVerifyToleranceBps: number;
  /** 证明有效期上限（秒） */
  certificateTtlSeconds: number;
  /** 源时间/证据时间允许超前本地时钟的容忍（秒） */
  futureSkewToleranceSeconds: number;
  /** 价格冲击必须可核验（null → 阻断） */
  requireImpactKnown: boolean;
  paramRanges: {
    maxSlippageBps: ParamRange;
    maxPriceImpactBps: ParamRange;
    maxReferenceDeviationBps: ParamRange;
  };
}

/** 该任务最终采用的参数（用户值 + 默认展开）。 */
export interface EffectivePolicyParams {
  maxSlippageBps: number;
  maxPriceImpactBps: number | null;
  maxReferenceDeviationBps: number | null;
}

export interface EffectivePolicy {
  definition: PolicyDefinition;
  policyDefinitionHash: Bytes32;
  params: EffectivePolicyParams;
  effectivePolicyHash: Bytes32;
}

/* ------------------------------------------------------------------ */
/* 证据记录（规范化后，可哈希）                                          */
/* ------------------------------------------------------------------ */

export type ReferenceKind =
  | "live"
  | "official_close"
  | "close_cross_verified"
  | "provisional_close"
  | "last_regular_observation"
  /** v2 (CV-D06)：当日 16:00:00 ET 整的最后一笔成交充当收盘，未经次日 pc / candle 确认 */
  | "close_last_tick";

export type EvidenceKind =
  | "okx_quote"
  | "okx_rwa_token"
  | "pyth_reference"
  | "ref_close"
  | "stablecoin_usd"
  | "token_meta"
  | "registry_lookup";

/** OKX DEX aggregator quote（exactIn），字段为本项目适配后的口径。 */
export interface OkxQuoteEvidence {
  kind: "okx_quote";
  chainId: number;
  fromToken: EvmAddress;
  toToken: EvmAddress;
  amountInRaw: RawAmount;
  expectedOutRaw: RawAmount;
  /** 上游原值（字符串原样保留）；null = 上游未给 */
  priceImpactPercentRaw: string | null;
  /** 本项目解析后的不利冲击（bps）；null = 未知/解析失败 */
  adverseImpactBps: number | null;
  /** 路由摘要（dex 名称列表），仅展示 */
  routeSummary: string[];
  /** 该路由是否在已验证可由 Guard 调用的路由类型内 */
  routeSupported: boolean;
}

/** OKX RWA token 列表条目（休市时 stockPrice 为最近收盘参考）。 */
export interface OkxRwaTokenEvidence {
  kind: "okx_rwa_token";
  chainId: number;
  tokenAddress: EvmAddress;
  issuer: string;
  /** 链上代币价格（USD/代币单位） */
  priceUsd: DecimalString | null;
  /** 股票参考价（USD/股）；文档：15s 更新，休市取最近收盘 */
  stockPriceUsd: DecimalString | null;
  /** v2 (W5)：OKX 列表的 `ratio`（代币/股乘数），作为乘数证据；v1 记录无此字段 */
  ratio?: DecimalString | null;
}

/** Pyth（现有管道）参考价 tick。 */
export interface PythReferenceEvidence {
  kind: "pyth_reference";
  underlyingId: string;
  feedId: string;
  priceUsd: DecimalString;
  confBps: number | null;
  /** 该 tick 源时间所处时段（由日历推导） */
  sessionAtPublish: "PRE" | "REGULAR" | "POST" | "CLOSED" | "HOLIDAY";
  tradingDate: TradingDate;
}

/** 收盘记录（现有 ref_closes 或其它正式来源）。 */
export interface RefCloseEvidence {
  kind: "ref_close";
  underlyingId: string;
  closeUsd: DecimalString;
  tradingDate: TradingDate;
  /** `pyth` = REGULAR 内捕获；`pyth_provisional` = 盘后末价充当；`official` = 交易所正式；`last_tick` = 16:00:00 ET 最后成交（v2, CV-D06，未确认） */
  closeSource: "pyth" | "pyth_provisional" | "official" | "last_tick";
  /** v2：`official` 的确认依据（candle 或次日 previousClose 一致）；v1 记录无此字段 */
  confirmation?: { method: "candle" | "next_day_pc"; confirmedAt: IsoUtc; matchedUsd: DecimalString } | null;
}

/** 稳定币美元计价核验。 */
export interface StablecoinUsdEvidence {
  kind: "stablecoin_usd";
  tokenAddress: EvmAddress;
  chainId: number;
  /** 1 代币 = ? USD */
  usdPerToken: DecimalString | null;
  method: string;
}

/** 代币元数据（链上读取）。 */
export interface TokenMetaEvidence {
  kind: "token_meta";
  chainId: number;
  tokenAddress: EvmAddress;
  decimals: number | null;
  symbol: string | null;
  /** rebasing 乘数等（原样字符串）；无则 null */
  multiplier: DecimalString | null;
}

/** registry 查询结果（记录用了哪个版本、命中了什么）。 */
export interface RegistryLookupEvidence {
  kind: "registry_lookup";
  registryVersion: string;
  registryHash: Bytes32;
  inputMatched: boolean;
  outputMatched: boolean;
}

export type EvidencePayload =
  | OkxQuoteEvidence
  | OkxRwaTokenEvidence
  | PythReferenceEvidence
  | RefCloseEvidence
  | StablecoinUsdEvidence
  | TokenMetaEvidence
  | RegistryLookupEvidence
  /* v6 (CV-D 2026-09-23) */
  | MarketContextEvidence
  | MarketEventEvidence
  | PortfolioSnapshotEvidence;

export type EvidenceMode = "LIVE" | "REPLAY" | "FIXTURE" | "FORK" | "SIMULATION";

export interface EvidenceRecord {
  /** 稳定 ID（服务分配，如 `ev_01H…`） */
  evidenceId: string;
  provider: string;
  /** 端点标识（非完整 URL，不含参数中的密钥） */
  endpoint: string;
  /** 非敏感请求参数指纹 */
  requestFingerprint: string;
  time: EvidenceTime;
  block: BlockContext | null;
  /** 原文 keccak256（原文私有保存或不可保存时仅存哈希） */
  rawHash: Bytes32;
  parserVersion: string;
  mode: EvidenceMode;
  payload: EvidencePayload;
}

/* ------------------------------------------------------------------ */
/* §5.2 原因码                                                          */
/* ------------------------------------------------------------------ */

export type ReasonSeverity = "info" | "warning" | "block";

export const REASON_CODES = [
  "ASSET_UNSUPPORTED",
  "REGISTRY_MISMATCH",
  "SOURCE_TIME_MISSING",
  "SOURCE_TIME_FUTURE",
  "REFERENCE_MISSING",
  "REFERENCE_STALE",
  "REFERENCE_PROVISIONAL",
  "REFERENCE_DEVIATION_EXCEEDED",
  "MARKET_OUTSIDE_REGULAR",
  "CLOSE_SESSION_MISMATCH",
  "SOURCE_CONFLICT",
  "TOKEN_UNIT_UNVERIFIED",
  "USD_CONVERSION_UNKNOWN",
  "QUOTE_UNAVAILABLE",
  "QUOTE_TOO_OLD",
  "PRICE_IMPACT_UNKNOWN",
  "PRICE_IMPACT_EXCEEDED",
  "ROUTE_UNSUPPORTED",
  "MIN_OUT_INVALID",
  "AMOUNT_OUT_OF_RANGE",
  "POLICY_PARAM_OUT_OF_RANGE",
  "COMPARISON_NOT_REQUESTED",
  "CLOSE_CROSS_VERIFIED",
  /** v2 (W5)：监测窗口内代币乘数变化（non-HARD，需重新规划） */
  "UNIT_CHANGED",
  /** v2 (CV-D06)：收盘价来自 16:00 最后成交且未经次日确认（info） */
  "CLOSE_UNCONFIRMED",
  /** v2 (I2 2026-09-21)：本步已提交、等待链上确认后才推进下一步（info，不是失败） */
  "STEP_AWAITING_CONFIRMATION",
  /* ---- v6 (I 2026-09-23 冻结)：条件层原因码，全部 non-HARD → 任务进 WAITING；证据不足一律等待 ---- */
  "CONTEXT_UNAVAILABLE",
  "CONTEXT_STALE",
  "CONTEXT_FIELD_NOT_IN_TIER",
  "EVENT_WINDOW_ACTIVE",
  "EVENT_DATE_UNCERTAIN",
  "EARNINGS_WINDOW_ACTIVE",
  "EARNINGS_COVERAGE_UNKNOWN",
  /** 仅当用户显式加入 not_in_fed_blackout 条件时才会出现（模板默认不加） */
  "FED_BLACKOUT",
  "VOL_REGIME_EXCEEDED",
  "SESSION_RULE_BLOCK",
  "CROSS_ASSET_UNCONFIRMED",
  "STEP_GAP_NOT_ELAPSED",
  "DAILY_STEP_CAP_REACHED",
  "PREMIUM_CONDITION_NOT_MET",
  "TARGET_NOT_REACHED",
  "TRACKED_COST_UNKNOWN",
  "CASH_FLOOR_BLOCK",
  "BUDGET_GROUP_CONFLICT",
  "BUDGET_GROUP_EXHAUSTED",
  "BUDGET_PENDING_OCCUPIED",
  "THESIS_INVALIDATED",
  "THESIS_UNKNOWN",
  "THESIS_EXPIRED",
  /** 信息项：执行器离线不阻塞签发，只影响页面「谁来执行」的提示 */
  "EXECUTOR_OFFLINE",
  /** 信息项：浏览器钱包路径等待用户签名 */
  "AWAITING_USER_SIGNATURE",
  /* ---- CV-D16 批次 2：agent 交易意图的四道核验 ---- */
  /** 意图超出签名范围（资产不在集合 / 金额超每笔上限 / 超总额 / 超步数 / 过期 / 未允许卖出） */
  "INTENT_OUT_OF_SCOPE",
  /** 决策记录引用了信任档位不允许采信的依据（如 platform_only 下引用 agent 研究结论） */
  "DECISION_BASIS_NOT_ADMISSIBLE",
  /** 签名里的硬约束未满足（与计划条件无关） */
  "HARD_CONSTRAINT_BLOCK",
  /** 范围允许卖出，但卖出需按资产另签卖出授权，本意图不签发（v7 起只用于没有卖出草案的旧任务） */
  "SELL_MANDATE_REQUIRED",
  /* ---- v7（Lane I 2026-10-02 冻结，开发计划 §2.13） ---- */
  /** non-HARD：同一步已有被取走的证书或在途作业，等到签名 validUntil + margin */
  "EXECUTION_IN_FLIGHT",
  /** 阻塞，userActionRequired：委托清单未完成（买入授权或额度签名缺失） */
  "DELEGATION_INCOMPLETE",
  /** 阻塞，userActionRequired：owner 对 PlanGuard 的链上额度不足 */
  "ALLOWANCE_INSUFFICIENT",
  /** 阻塞，userActionRequired：owner 的输入代币余额不足 */
  "BALANCE_INSUFFICIENT",
  /** 阻塞：该股票没有签过卖出授权 */
  "SELL_NOT_DELEGATED",
  /** 阻塞：卖出数量无法核对（D-092 2026-10-02 简化后只在链上余额读不到时出现，detail.note = balance_unavailable）；超出链上余额走 BALANCE_INSUFFICIENT。码名保留兼容 */
  "SELL_EXCEEDS_TASK_POSITION",
  /** 信息项：平台执行身份不可用（gas 低 / 离线） */
  "EXECUTOR_UNAVAILABLE",
  /** 信息项：托管 Agent 达到次数 / 成本上限 */
  "AGENT_LIMIT_REACHED",
  /** 信息项：事件预定时间已到但实际值未入库 */
  "EVENT_DATA_PENDING",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  severity: ReasonSeverity;
  evidenceIds: string[];
  /** 机器可读的补充数据（数值、阈值、对比值），不含自然语言 */
  detail?: Record<string, string | number | boolean | null>;
}

/* ------------------------------------------------------------------ */
/* §5.2 报告                                                            */
/* ------------------------------------------------------------------ */

export type Verdict = "eligible" | "limited" | "rejected";
export type ComparisonStatus = "live" | "official_close" | "unverified" | "not_requested";

export interface NormalizedQuote {
  amountInRaw: RawAmount;
  expectedOutRaw: RawAmount;
  /** 按用户滑点上限向下取整后的绝对最小到账量（链上硬边界） */
  minOutRaw: RawAmount;
  priceImpactPercent: string | null;
  adverseImpactBps: number | null;
  requestedAt: IsoUtc;
  receivedAt: IsoUtc;
  sourcePublishedAt: IsoUtc | null;
  /** 可执行单价：USD / 股（仅当 USD 换算与单位换算均已核验） */
  executableUsdPerShare: DecimalString | null;
}

export interface ReportReference {
  underlyingId: string;
  priceUsd: DecimalString;
  kind: ReferenceKind;
  tradingDate: TradingDate | null;
  sourcePublishedAt: IsoUtc | null;
  sourceId: string;
  /** 可执行单价相对参考价的偏差（bps，正 = 链上更贵）；不可比时 null */
  deviationBps: number | null;
}

export interface VerifyReport {
  schemaVersion: "1";
  jobId: string;
  reportVersion: number;
  requestHash: Bytes32;
  policyDefinitionHash: Bytes32;
  effectivePolicyHash: Bytes32;
  registryHash: Bytes32;
  evaluatedAt: IsoUtc;
  verdict: Verdict;
  executionEligible: boolean;
  comparisonStatus: ComparisonStatus;
  /** 评估时刻的市场时段（America/New_York 日历推导） */
  marketSession: "PRE" | "REGULAR" | "POST" | "CLOSED" | "HOLIDAY";
  reasons: Reason[];
  normalizedQuote: NormalizedQuote | null;
  reference: ReportReference | null;
  evidenceIds: string[];
  evidenceHash: Bytes32;
  /** 完整可读规则快照 */
  policySnapshot: {
    definition: PolicyDefinition;
    params: EffectivePolicyParams;
  };
}

/* ------------------------------------------------------------------ */
/* §7.2 状态机枚举（本项目状态，非 SDK 枚举）                            */
/* ------------------------------------------------------------------ */

export const ORDER_STATES = [
  "CREATED",
  "REPORT_READY",
  "PAYMENT_REQUIRED",
  "SETTLEMENT_PENDING",
  "PAYMENT_UNKNOWN",
  "PAID",
  "DELIVERED",
  "FAILED",
  "EXPIRED",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const EXECUTION_STATES = [
  "CREATED",
  "EVALUATING",
  "REJECTED",
  "PREPARED",
  "USER_SIGNING",
  "SUBMITTED",
  "CONFIRMED",
  "REVERTED",
  "EXPIRED",
  "UNKNOWN",
  "REORG_PENDING",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/* ------------------------------------------------------------------ */
/* §9.2 EIP-712 结构（TS 镜像；字段顺序一经部署冻结）                    */
/* ------------------------------------------------------------------ */

export interface TradeIntent {
  owner: EvmAddress;
  recipient: EvmAddress;
  inputToken: EvmAddress;
  outputToken: EvmAddress;
  amountIn: RawAmount;
  minAmountOut: RawAmount;
  router: EvmAddress;
  spender: EvmAddress;
  calldataHash: Bytes32;
  policyDefinitionHash: Bytes32;
  effectivePolicyHash: Bytes32;
  registryHash: Bytes32;
  evidenceHash: Bytes32;
  /** uint256，十进制串 */
  nonce: string;
  /** uint64 Unix 秒，十进制串 */
  deadline: string;
}

export interface VerificationCertificate {
  intentDigest: Bytes32;
  evidenceHash: Bytes32;
  policyDefinitionHash: Bytes32;
  effectivePolicyHash: Bytes32;
  issuedAt: string;
  validUntil: string;
  signerEpoch: string;
}

export interface Eip712Domain {
  /** v1 Guard = "ChaconneVerifyGuard"；v2 PlanGuard = "ChaconneVerifyPlanGuard"（CV-D07 放宽为联合类型） */
  name: "ChaconneVerifyGuard" | "ChaconneVerifyPlanGuard";
  version: "1";
  chainId: number;
  verifyingContract: EvmAddress;
}

/* ================================================================== */
/* v2 增补（升级执行计划 v5 §3，2026-09-21 冻结）——只追加，不改已有类型   */
/* ================================================================== */

/* ---------- §3.1 规划（W1） ---------- */
export type PlanSide = "buy" | "sell";
export type PlanNextStep = "READY" | "ACCEPT_PARTIAL" | "SWITCH_INPUT" | "WAIT_CONDITION" | "PROVIDE_DATA" | "USER_MUST_RELAX_LIMIT";
/** 默认金额阶梯（相对该腿目标，bps） */
export const DEFAULT_LADDER_BPS = [10_000, 7_500, 5_000, 2_500, 1_000] as const;
export const PLAN_MAX_CANDIDATES = 12;
export const PLAN_MAX_QUOTES_PER_LEG = 8;

export interface PlanLeg {
  outputAssetKey: string;
  /** 该腿占总预算的比例（bps），单腿 = 10000 */
  weightBps: number;
}
export interface PlanGoal {
  ownerAddress: EvmAddress;
  recipientAddress: EvmAddress;
  executionChainId: number;
  legs: PlanLeg[];
  /** 允许的资金币种（多选）与总预算（按 inputAssetKeys[0] 的最小单位） */
  budget: { inputAssetKeys: string[]; amountInRaw: RawAmount };
  side: PlanSide;
  policyId: PolicyId;
  policyVersion: string;
  maxSlippageBps: number;
  maxPriceImpactBps: number | null;
  maxReferenceDeviationBps?: number | null;
  /** ISO */
  deadline: IsoUtc;
  ladderBps?: number[];
}
export interface PlanFeeEstimate {
  gasNative: RawAmount | null;
  routeFeeBps: number | null;
}
export interface PlanCandidate {
  candidateId: string;
  legIndex: number;
  inputAssetKey: string;
  amountInRaw: RawAmount;
  expectedOutRaw: RawAmount | null;
  adverseImpactBps: number | null;
  feeEstimate: PlanFeeEstimate;
  /** 相对该腿目标（bps） */
  completionBps: number;
  verdictByPolicy: Record<PolicyId, { verdict: Verdict; blocking: ReasonCode[] }>;
  chosenPolicyVerdict: Verdict;
  reasons: Reason[];
  evidenceIds: string[];
  nextStep: PlanNextStep;
}
export interface PlanReport {
  schemaVersion: "1";
  planId: string;
  goalHash: Bytes32;
  evaluatedAt: IsoUtc;
  registryHash: Bytes32;
  policyDefinitionHash: Bytes32;
  effectivePolicyHash: Bytes32;
  candidates: PlanCandidate[];
  /** 只能是 chosenPolicyVerdict === "eligible" 且 completionBps 最大者；无则 null */
  recommended: string | null;
  evidenceHash: Bytes32;
  planHash: Bytes32;
}

/* ---------- §3.2 授权计划与步骤（W2，PlanGuard v2） ---------- */
/** TS 镜像；字段顺序 = 合约 struct 顺序，一经部署冻结。uint 一律十进制字符串。 */
export interface TradeMandate {
  owner: EvmAddress;
  recipient: EvmAddress;
  /** buy: 稳定币；sell: 股票代币 */
  inputToken: EvmAddress;
  /** keccak256(abi.encodePacked(sorted outputTokens)) */
  outputSetHash: Bytes32;
  budgetCap: RawAmount;
  perStepCap: RawAmount;
  maxSteps: string;
  policyDefinitionHash: Bytes32;
  effectivePolicyHash: Bytes32;
  registryHash: Bytes32;
  validFrom: string;
  deadline: string;
  /** 授权 nonce（owner 维度，与 v1 意图 nonce 分开的命名空间） */
  nonce: string;
}
export interface MandateStep {
  mandateDigest: Bytes32;
  stepIndex: string;
  outputToken: EvmAddress;
  amountIn: RawAmount;
  minAmountOut: RawAmount;
  router: EvmAddress;
  spender: EvmAddress;
  calldataHash: Bytes32;
  evidenceHash: Bytes32;
  deadline: string;
}
export interface StepCertificate {
  stepDigest: Bytes32;
  evidenceHash: Bytes32;
  policyDefinitionHash: Bytes32;
  effectivePolicyHash: Bytes32;
  issuedAt: string;
  validUntil: string;
  signerEpoch: string;
}

export const MANDATE_STATES = ["DRAFT", "ACTIVE", "PAUSED", "CANCELLED", "REVOKED", "COMPLETED", "EXPIRED"] as const;
export type MandateState = (typeof MANDATE_STATES)[number];
export const MANDATE_STEP_STATES = ["PREPARED", "EXPIRED", "SUBMITTED", "REORG_PENDING", "CONFIRMED", "REVERTED", "UNKNOWN", "SUPERSEDED"] as const;
/** v7（CV-D24）：只有这些「活」状态受 (mandate_id, step_index) 部分唯一索引约束；SUPERSEDED / EXPIRED / REVERTED 可与一条活行同 index 共存 */
export const LIVE_MANDATE_STEP_STATES = ["PREPARED", "SUBMITTED", "REORG_PENDING", "CONFIRMED", "UNKNOWN"] as const;
export type MandateStepState = (typeof MANDATE_STEP_STATES)[number];
export type MandateEvalStatus = "READY" | "WAIT" | "BLOCKED" | "DONE";

/** delta 解释器输出（纯函数 explainDelta(prev, next)） */
export interface DeltaExplanation {
  addedReasons: ReasonCode[];
  removedReasons: ReasonCode[];
  impactBpsChange: { from: number | null; to: number | null } | null;
  deviationBpsChange: { from: number | null; to: number | null } | null;
  sessionChange: { from: string; to: string } | null;
  unitChange: { from: DecimalString | null; to: DecimalString | null } | null;
  /** 人话（en / zh） */
  summary: { en: string; zh: string };
}
export interface MandateEvaluation {
  evaluationId: string;
  mandateId: string;
  evaluatedAt: IsoUtc;
  status: MandateEvalStatus;
  reportHash: Bytes32 | null;
  reasons: Reason[];
  delta: DeltaExplanation | null;
  /** READY 时预生成的步骤（未被拉取前不算"已发出"） */
  preparedStepIndex: string | null;
}

/* ---------- §3.3 证据包（W3）与账单 ---------- */
export type ProductSku = "verify_once" | "plan" | "monitor_window" | "task_bundle";
export interface Product {
  sku: ProductSku;
  name: { en: string; zh: string };
  priceUsd: DecimalString;
  network: string;
  /** 有效期（秒）；null = 一次性交付 */
  validitySeconds: number | null;
  delivery: { en: string; zh: string };
  /** "没有可行方案 / 信息不足算什么" */
  noResultIs: { en: string; zh: string };
}
export interface BillLine {
  label: string;
  asset: string;
  amountRaw: RawAmount;
  amountUsd: DecimalString | null;
  network: string;
  txHash: Hex | null;
}
export interface Bill {
  serviceFees: BillLine[];
  principal: BillLine[];
  gas: BillLine[];
  /** 自付演示 = demo_self_payment */
  selfPayment: boolean;
}
export interface MandateStepRecord {
  stepIndex: string;
  state: MandateStepState;
  step: MandateStep;
  stepDigest: Bytes32;
  certificate: StepCertificate | null;
  certificateSignature: Hex | null;
  txHash: Hex | null;
  receiptSummary: unknown;
}
export interface EvidenceBundle {
  schemaVersion: "1";
  kind: "job" | "mandate";
  id: string;
  exportedAt: IsoUtc;
  chainId: number;
  /** A2 定稿：规则重算需要任务原文与登记表版本 */
  job: NormalizedJob | null;
  goal?: PlanGoal | null;
  registryVersion: string;
  registry: RegistryEntry[];
  registryHash: Bytes32;
  policy: PolicyDefinition;
  effectivePolicy: EffectivePolicy;
  evidence: EvidenceRecord[];
  reports: VerifyReport[];
  plans?: PlanReport[];
  certificates: Array<{ typedData: unknown; signature: Hex; signer: EvmAddress; epoch: number }>;
  intents?: Array<{ typedData: unknown; signature: Hex }>;
  mandate?: { typedData: unknown; signature: Hex; steps: MandateStepRecord[] };
  executions: Array<{ attemptId: string; txHash?: Hex; chainId: number; receiptSummary?: unknown }>;
  bill: Bill;
  /** v2.1 (V-07)：证明签名者与 epoch，随包携带，离线验证器不再依赖"有证书才知道 signer" */
  attestationSigner?: EvmAddress;
  attestationEpoch?: number;
  /** canonical(除 bundleHash/bundleSignature 外全部) */
  bundleHash: Bytes32;
  /** attestation key 对 bundleHash 的 EIP-191 签名 */
  bundleSignature: Hex;
}

/* ---------- W6 Club ---------- */
export const PERSONA_IDS = ["turtle_drummer", "cat_conductor", "ox_bassist"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];
export interface Profile {
  ownerAddress: EvmAddress;
  personaId: PersonaId;
  name: string;
  tone: "calm" | "playful" | "terse";
}
export type ShareStatus = "completed" | "partial" | "waiting" | "rejected" | "simulation";
export type SharePrivacy = { amounts: "exact" | "range" | "hidden"; wallet: "hidden" };

/* ================================================================== */
/* v6 增补（Chaconne Agent，2026-09-23 冻结；Lane I）                    */
/* 产品语义以上游 v6 文档 §6 为准；改动走 CV-D。金额十进制字符串；          */
/* 链下时间 ISO-8601 UTC；哈希 keccak256（canonical `canon-1`）。        */
/* ================================================================== */

/* ---------- §1.1 事件契约（C6 的根） ---------- */
export const EVENT_KINDS = ["MACRO_TIER1", "MACRO_TIER2", "FED_SPEECH", "FED_BLACKOUT", "EARNINGS", "CORPORATE_ACTION", "MARKET_HOLIDAY", "EARLY_CLOSE"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventStatus = "confirmed" | "estimated" | "revised" | "cancelled" | "released";
export type EventDatePrecision = "exact" | "day" | "estimate";
/** 财报时段：盘前 / 盘后 / 盘中；未知 null */
export type EventSessionHint = "bmo" | "amc" | "dmh" | null;
export interface MarketEvent {
  /** 稳定：`${source}:${kind}:${YYYY-MM-DD}:${slug}`；改期不换 id，revision+1 */
  id: string;
  kind: EventKind;
  name: string;
  /** EARNINGS / CORPORATE_ACTION 必填；宏观为空数组 */
  underlyingIds: string[];
  /** datePrecision='exact' 时必填 */
  scheduledAtUtc: IsoUtc | null;
  /** YYYY-MM-DD（来源市场当地） */
  dateLocal: string;
  datePrecision: EventDatePrecision;
  sessionHint: EventSessionHint;
  status: EventStatus;
  revision: number;
  revisedFrom?: { scheduledAtUtc: IsoUtc | null; dateLocal: string };
  source: string;
  sourceFetchedAt: IsoUtc;
  /** 首次可知时刻——回放只用 firstKnownAt ≤ t 的版本（无前视） */
  firstKnownAt: IsoUtc;
  releasedAt?: IsoUtc;
  /** IANA 时区，如 'America/New_York' */
  tz: string;
}

/* ---------- §1.2 上下文契约（C1） ---------- */
export type CtxPurpose = "internal" | "display" | "agent" | "paid";
/** unfinished = 标签时间晚于打包时刻的未完成区间（如日线未收），不得当已发生观测 */
export type CtxStatus = "ok" | "stale" | "unavailable" | "unfinished";
/**
 * CV-D12（2026-09-23，Lane I 裁决）：canonical `canon-1` 只允许安全整数，浮点数无法进入签名。
 * 因此**数值型上下文字段的 value 一律为十进制字符串**（`DecimalString`，如 "18.3"、"4.96"），
 * 与仓库「所有金额十进制字符串」的惯例一致（复用第 24 行既有 `DecimalString`）。消费方按需解析，不得假设是 number。
 */
export interface CtxField<T> {
  value: T | null;
  source: string;
  /** 观测/统计期时点（定盘日、K 线收盘）；与 fetchedAt（哨兵抓取）、packagedAt（打包）严格区分 */
  observedAt: IsoUtc | null;
  fetchedAt: IsoUtc;
  status: CtxStatus;
  purposes: CtxPurpose[];
  note?: string;
}
export type SessionLabel = "ASIA" | "EU_OPEN" | "US_PRE" | "US_REGULAR" | "US_POST";
export type CrossAssetState = "relief" | "transmission" | "divergence" | "undecided";
export interface MarketContext {
  schemaVersion: "chaconne-context/1";
  producer: "crowsnest";
  packagedAt: IsoUtc;
  /** Ed25519 签名，覆盖 canonical(除 signature 外) */
  signature: string;
  signatureAlg: "ed25519";
  publicKeyId: string;
  session: {
    label: CtxField<SessionLabel>;
    usTradingDay: CtxField<boolean>;
    holiday: CtxField<string | null>;
    earlyClose: CtxField<boolean>;
    hoursToUsOpen: CtxField<DecimalString>;
    hoursToUsClose: CtxField<DecimalString>;
    etDate: CtxField<string>;
  };
  /** 未来 14 天 + 过去 2 天，宏观与联储层 */
  events: MarketEvent[];
  fed: { blackout: CtxField<boolean>; blackoutUntil: CtxField<IsoUtc | null>; hikeProb: CtxField<DecimalString>; hikeProbDrift24hPp: CtxField<DecimalString> };
  rates: { y2: CtxField<DecimalString>; y10: CtxField<DecimalString>; y30: CtxField<DecimalString>; s2s30Bp: CtxField<DecimalString>; curveShape: CtxField<string | null>; realYield10: CtxField<DecimalString>; move: CtxField<DecimalString> };
  risk: { vix: CtxField<DecimalString>; nqOvernightPct: CtxField<DecimalString>; esOvernightPct: CtxField<DecimalString>; dxy: CtxField<DecimalString>; dxyPct1d: CtxField<DecimalString> };
  crossAsset: { lastDataRelease: CtxField<{ eventId: string; state: CrossAssetState; atUtc: IsoUtc } | null> };
  driftVerdict: CtxField<string>;
  /** CV-D13：产物来源模式，防归档/回填冒充实时——`live` 才可参与 LIVE 判定；`backfill`/`sample` 只能用于回放与联调 */
  provenance?: { mode: "live" | "backfill" | "sample" };
}
/** 按调用方档位裁剪后的上下文：字段不在档位 → 整个字段 `{status:'unavailable', note:'not_in_tier'}`，绝不省略键 */
export type ContextTier = "internal" | "display" | "agent" | "paid";

/* ---------- §1.3 条件 DSL（C2）与三态 ---------- */
export type ConditionOutcome = "SATISFIED" | "UNSATISFIED" | "INSUFFICIENT_EVIDENCE";
/** referenceKind 复用第 210 行既有的 ReferenceKind（live | official_close | close_last_tick） */
export type Condition =
  | { type: "session"; allow: Array<"US_REGULAR" | "US_PRE" | "US_POST"> }
  | { type: "avoid_event_window"; kinds: EventKind[]; beforeMin: number; afterMin: number; includeEstimated: boolean; wholeDayIfDayPrecision: boolean }
  | { type: "earnings_window"; beforeTradingDays: number; afterSessions: number; requireRegularSessionAfter: boolean; requireLiveReferenceAfter: boolean }
  /** 默认不加入任何模板 */
  | { type: "not_in_fed_blackout" }
  | { type: "max_vix"; value: number }
  | { type: "max_move"; value: number }
  /** LIVE 执行条件只允许 referenceKind='live'；官方收盘/最后成交口径只用于 SIMULATION/观察 */
  | { type: "premium_bps_lte"; value: number; referenceKind: ReferenceKind; liveOnlyForExecution: true }
  /** 以上一步「确认」的交易日计 */
  | { type: "min_gap_trading_days"; days: number }
  | { type: "max_steps_per_trading_day"; value: number; scope: "task" | "budget_group" }
  /** 不含 undecided */
  | { type: "require_cross_asset_confirmation"; acceptStates: Array<Exclude<CrossAssetState, "undecided">> }
  | { type: "target_price_gte"; underlyingPriceUsd: string; referenceKind: "live" }
  | { type: "target_price_lte"; underlyingPriceUsd: string; referenceKind: "live" }
  /** 成本覆盖率 < 100% → INSUFFICIENT_EVIDENCE（TRACKED_COST_UNKNOWN） */
  | { type: "tracked_cost_pnl_pct_gte"; value: number }
  | { type: "cash_floor"; inputAssetKey: string; floorRaw: RawAmount }
  /** 理由卡任一机器前提失效/未知 → 不通过 */
  | { type: "thesis_holds"; thesisId: string };
export type ConditionType = Condition["type"];
export interface ConditionSet {
  version: "conditions/1";
  items: Condition[];
  /** keccak256(canonical({version, items}))；进入 effectivePolicyHash 的展开参数 → 进证书与证据包 */
  hash: Bytes32;
}
export interface ConditionItemResult {
  item: Condition;
  outcome: ConditionOutcome;
  reasons: Reason[];
  evidenceIds: string[];
  /** 已知恢复点；未知写 null */
  nextCheckAt: IsoUtc | null;
}
export interface ConditionEvaluation {
  outcome: ConditionOutcome;
  perItem: ConditionItemResult[];
  /** 各项 nextCheckAt 的最小值；全部未知 → null */
  nextCheckAt: IsoUtc | null;
  evaluatedAt: IsoUtc;
  conditionsHash: Bytes32;
}

/* ---------- §1.4 任务、理由卡、资金组、影响、对照、回放 ---------- */
export const TASK_STATUSES = ["DRAFT", "AWAITING_AUTHORIZATION", "ACTIVE", "WAITING", "STEP_PREPARED", "PARTIAL", "COMPLETED", "PAUSED", "REVOKE_PENDING", "REVOKED", "EXPIRED", "CANCELLED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** online = 3 分钟内有心跳；awaiting_signature = 浏览器钱包路径；offline = 都没有 */
export type ExecutorPresence = "online" | "awaiting_signature" | "offline";
/** agent_goal（CV-D16 批次 6）：目标式任务——没有模板，只有范围与目标；agent 自己的策略决定何时、买哪个、买多少 */
export const PLAYBOOK_IDS = ["session_dca", "event_aware_accumulate", "discount_watch", "target_sell", "portfolio_rebalance", "agent_goal"] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];
export interface Blocker {
  code: ReasonCode;
  evidenceIds: string[];
  evidenceAt: IsoUtc | null;
  nextCheckAt: IsoUtc | null;
  userActionRequired: boolean;
  /** 由原因码映射的说明文案，不生成预测 */
  text: string;
}
export interface Task {
  id: string;
  owner: EvmAddress;
  playbookId: PlaybookId;
  goal: PlanGoal;
  conditions: ConditionSet;
  /** 授权范围（CV-D16，scope/1）；旧任务缺省。类型见 tasks/scope.ts */
  scope?: import("./tasks/scope").TaskScope;
  /** 签名绑定的哈希（= effectivePolicyHash 展开参数 conditionsHash 的取值） */
  scopeHash?: Bytes32;
  /** 简报（批次 6，签名之外可改）：策略文本与版本、关注的事件、接管的 agent、示例来源 */
  brief?: import("./tasks/agentTurn").TaskBrief;
  mandateIds: string[];
  thesisId?: string;
  budgetGroupId?: string;
  status: TaskStatus;
  /** 全量阻塞项（不止第一个） */
  blockers: Blocker[];
  nextCheckAt: IsoUtc | null;
  executorPresence: ExecutorPresence;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
}

/**
 * machine = 由 Condition 求值的研究/风险前提（VIX、溢价、目标价、跨资产…），失效 → 论点被推翻；
 * research = 只收复核项，用户手动标记；
 * timing = 纯时间/时段门（session、min_gap_trading_days、事件窗口…；V-27 增补）：同样按 Condition 三态求值并展示，
 *          但**不参与**卡片状态，也不触发 onInvalidation——休市不是论点被推翻，只是等待。
 */
export type PremiseKind = "machine" | "research" | "timing";
export type PremiseStatus = "holds" | "invalidated" | "unknown";
export interface PremiseReviewItem { side: "support" | "counter"; text: string; sourceUrl: string; addedBy: "agent" | "user"; at: IsoUtc }
export interface Premise {
  id: string;
  kind: PremiseKind;
  text: string;
  /** machine 前提 = Condition 求值三态；research 前提只收 reviewItems 并保持 unknown 直到用户标记 */
  condition?: Condition;
  status: PremiseStatus;
  lastCheckedAt: IsoUtc | null;
  evidenceIds: string[];
  reviewItems?: PremiseReviewItem[];
}
export type ThesisOnInvalidation = "notify" | "pause_issuance" | "draft_exit";
export type ThesisStatus = "holds" | "invalidated" | "unknown" | "expired";
export interface ThesisCard {
  id: string;
  taskId: string;
  goal: string;
  rationale: string;
  premises: Premise[];
  validUntil: IsoUtc;
  onInvalidation: ThesisOnInvalidation;
  status: ThesisStatus;
}

export interface BudgetGroup {
  id: string;
  owner: EvmAddress;
  name: string;
  inputAssetKey: string;
  periodStart: IsoUtc;
  periodEnd: IsoUtc;
  capRaw: RawAmount;
  cashFloorRaw: RawAmount;
  priorityRule: "priority_then_created";
}
export type BudgetAllocationState = "reserved" | "waiting" | "released" | "settled";
/** 不变量：spentThisPeriod + Σ reservedRaw(可执行授权) ≤ capRaw；pendingRaw 计入 reserved 内不重复 */
export interface BudgetAllocation {
  groupId: string;
  taskId: string;
  mandateId: string;
  priority: number;
  reservedRaw: RawAmount;
  spentRaw: RawAmount;
  pendingRaw: RawAmount;
  state: BudgetAllocationState;
}

export type ImpactRelation = "company_direct" | "user_rule" | "macro_research";
export type ImpactEffect = "wait" | "pause_issuance" | "recheck" | "none";
export const IMPACT_ACTIONS = ["view_evidence", "create_watch_task", "keep_plan", "wait_by_rule", "pause_issuance", "preview_new_plan"] as const;
export type ImpactAction = (typeof IMPACT_ACTIONS)[number];
export interface EventImpact {
  eventId: string;
  relation: ImpactRelation;
  assets: string[];
  holdings: Array<{ assetKey: string; balanceRaw: RawAmount }>;
  tasks: Array<{ taskId: string; matchedRules: string[]; effect: ImpactEffect }>;
  actions: ImpactAction[];
}

export interface PolicyComparisonVariant { label: string; conditions: ConditionSet; outcome: ConditionOutcome; perItem: ConditionItemResult[] }
export interface PolicyComparison {
  id: string;
  taskId: string;
  /** 固定同一证据快照（最近一次评估的证据集合 + 上下文快照 + 事件版本） */
  evidenceSnapshotId: string;
  variants: PolicyComparisonVariant[];
  diff: Array<{ itemType: ConditionType; a: unknown; b: unknown }>;
  mode: "SIMULATION";
}
export type ReplayGapReason = "NO_ARCHIVE" | "NO_QUOTE" | "REFERENCE_PURGED";
export interface ReplayRun {
  id: string;
  playbookId: PlaybookId;
  conditions: ConditionSet;
  assetKey: string;
  from: IsoUtc;
  to: IsoUtc;
  /** 每个评估点只用 receivedAt/packagedAt/firstKnownAt ≤ t 的数据（knownAsOf 记录用到的最晚可知时刻） */
  points: Array<{ t: IsoUtc; outcome: ConditionOutcome; blockers: Blocker[]; knownAsOf: IsoUtc }>;
  coverage: Array<{ from: IsoUtc; to: IsoUtc; sources: string[] }>;
  gaps: Array<{ from: IsoUtc; to: IsoUtc; reason: ReplayGapReason }>;
}

/* ---------- §1.9 通知事件 ---------- */
export const NOTIFICATION_TYPES = ["task.status_changed", "task.step_ready", "task.step_confirmed", "task.step_reverted", "task.blocked", "event.revised", "event.released", "thesis.invalidated", "thesis.unknown", "budget.conflict", "budget.released", "task.expiring", "recap.ready", "task.intent_certified", "task.intent_rejected", "task.agent_turn", "task.agent_status", "task.delegation_completed", "task.needs_owner", "task.execution_failed", "task.recertified", "event.data_arrived", "agent.run_completed", "ops.alert"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
/** 载荷只含 id、类型、版本、摘要与链接；不含任何签名、证书、calldata（D-087：通知不携带权限） */
export interface NotificationPayload {
  type: NotificationType;
  entityId: string;
  version: number;
  /** 幂等键 `${type}:${entityId}:${version}` */
  idempotencyKey: string;
  summary: string;
  url: string;
  at: IsoUtc;
}

/* ---------- CV-D 新增证据 payload ---------- */
export interface MarketContextEvidence {
  kind: "market_context";
  schemaVersion: "chaconne-context/1";
  producer: "crowsnest";
  packagedAt: IsoUtc;
  publicKeyId: string;
  /** 验签结果与逐字段 staleness 由 verify-service 判定，不信 producer 自报 */
  signatureValid: boolean;
  contextHash: Bytes32;
  fieldStatus: Record<string, CtxStatus>;
}
export interface MarketEventEvidence {
  kind: "market_event";
  eventId: string;
  eventKind: EventKind;
  revision: number;
  status: EventStatus;
  datePrecision: EventDatePrecision;
  scheduledAtUtc: IsoUtc | null;
  dateLocal: string;
  firstKnownAt: IsoUtc;
}
export interface PortfolioSnapshotEvidence {
  kind: "portfolio_snapshot";
  owner: EvmAddress;
  chainId: number;
  blockNumber: number;
  holdings: Array<{ assetKey: string; balanceRaw: RawAmount; tracedQtyRaw: RawAmount | null }>;
}

/* =====================================================================================
 * v7 增补（Lane I 2026-10-02 冻结；开发计划 §2.1 / §2.2 / §2.5 / §2.6 / §2.7；interfaces.md §12）
 * 只有类型与常量；实现分别在 core/verify/{delegation,execution,agent} 与各服务里。
 * ===================================================================================== */

/** viem / 钱包 signTypedData 能直接吃的 typedData（domain 字段按代币 / 合约各自的域给出） */
export interface Eip712TypedData {
  domain: { name?: string; version?: string; chainId?: number; verifyingContract?: EvmAddress; salt?: Bytes32 };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/* ---------- §2.1 任务运行态 ---------- */
export const AGENT_MODES = ["hosted", "byo"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];
/** hosted = 平台执行身份（作业制）；agent_wallet = 用户 Agent 经 MCP 自己发；browser = owner 网页逐笔 */
export const EXECUTOR_MODES = ["hosted", "agent_wallet", "browser"] as const;
export type ExecutorMode = (typeof EXECUTOR_MODES)[number];
export type Actor = "owner" | "agent:hosted" | "agent:byo" | "executor:hosted" | "system";

export const HOSTED_AGENT_STATES = ["starting", "working", "awaiting_fill", "waiting", "blocked_owner", "blocked_operator", "paused", "ended"] as const;
export type HostedAgentState = (typeof HOSTED_AGENT_STATES)[number];
export type AgentPresence =
  | { mode: "hosted"; state: HostedAgentState; currentActivity: string | null; waitingFor: string | null; lastDecisionAt: IsoUtc | null; nextCheckAt: IsoUtc | null }
  | { mode: "byo"; state: "online" | "offline"; lastResponseAt: IsoUtc | null; nextCheckAt: IsoUtc | null }
  | { mode: "none"; state: "unassigned" };
export interface ExecutorStatus { mode: ExecutorMode | null; state: "ready" | "busy" | "paused" | "gas_low" | "offline" | "disabled"; address: EvmAddress | null; lastJobAt: IsoUtc | null }

export const NEEDS_OWNER_CODES = ["delegation_incomplete", "allowance_low", "balance_low", "permit_failed", "revoke_pending", "scope_exhausted", "agent_ended", "reclaim_allowance"] as const;
export type NeedsOwnerCode = (typeof NEEDS_OWNER_CODES)[number];
export interface NeedsOwnerItem {
  code: NeedsOwnerCode;
  blocking: boolean;
  text: { zh: string; en: string };
  action: { kind: "sign_delegation" | "sign_permit" | "confirm_revoke" | "reclaim_allowance" | "create_new_task" | "resume_or_cancel" | "top_up"; itemId?: string };
}
export const NEEDS_OPERATOR_CODES = ["executor_gas_low", "executor_offline", "model_unavailable", "rpc_unavailable", "agent_budget_exhausted", "integrity_alert", "contract_paused", /* v7 费用预算（interfaces §12.15，运营者确认 2026-10-02） */ "fee_budget_exhausted", "fee_cap_exceeded"] as const;
export type NeedsOperatorCode = (typeof NEEDS_OPERATOR_CODES)[number];
export interface TaskRuntime {
  agentMode: AgentMode | null;
  executorMode: ExecutorMode | null;
  presence: AgentPresence;
  executor: ExecutorStatus;
  needsOwner: NeedsOwnerItem[];
  needsOperator: NeedsOperatorCode[];
}

/* ---------- §2.2 委托清单 ---------- */
export type DelegationItemKind = "mandate_buy" | "mandate_sell" | "permit";
export type DelegationItemStatus = "todo" | "submitted" | "confirmed" | "failed" | "not_needed";
export interface DelegationItem {
  /** "buy" | "sell:<assetKey>" | "permit:<tokenAddress>" */
  id: string;
  kind: DelegationItemKind;
  /** buy = 资金币种；sell = 股票；permit = 被授权的代币 */
  assetKey: string;
  title: { zh: string; en: string };
  /** 这次签名允许什么、不允许什么（金额、合约、期限、能否撤回） */
  explain: { zh: string; en: string };
  /** mandate 来自建任务时的草案；permit 在 GET 时按当前 nonce 与账本现算并登记为 ISSUED；failed 时为 null */
  typedData: Eip712TypedData | null;
  /** permit 项：本次 GET 登记的请求 id（POST /allowances 必须引用它） */
  permitRequestId?: string;
  status: DelegationItemStatus;
  /** mandateId / permitId */
  ref: string | null;
  /** permit 上链交易（执行身份代付 gas） */
  txHash?: Hex | null;
  error?: { code: string; message: string };
}
export interface DelegationChecklist {
  taskId: string;
  items: DelegationItem[];
  /** userTransactions 正常恒为 0；只有不支持 permit 的回退路径才 > 0 */
  counts: { signaturesNeeded: number; signaturesDone: number; userTransactions: number };
  allowances: Array<{ token: EvmAddress; assetKey: string; onchainRaw: RawAmount; requiredRaw: RawAmount; pendingPermit: boolean }>;
  /** 本任务事实：买入授权 ACTIVE ∧ 本任务资金币种 permit 项 confirmed 或 not_needed */
  buyReady: boolean;
  /** 每只股票：卖出授权 ACTIVE ∧ 该股票 permit 项 confirmed 或 not_needed */
  sellReady: Record<string, boolean>;
  /** 全部项 confirmed 或 not_needed */
  complete: boolean;
}

/* ---------- §2.3 permit 与额度账本 ---------- */
export const PERMIT_STATES = ["ISSUED", "SUBMITTED", "CONFIRMED", "FAILED", "SUPERSEDED"] as const;
export type PermitState = (typeof PERMIT_STATES)[number];
export type PermitPurpose = "delegation" | "reclaim";
/** 额度余量：permitValue = required + ceil(required × 50 / 10_000) */
export const PERMIT_HEADROOM_BPS = 50 as const;
/** permit 签名可提交的截止时间（秒）：签名时刻 + 1800；不是额度有效期 */
export const PERMIT_DEADLINE_S = 1800 as const;
export interface PermitDomainEntry {
  assetKey: string;
  token: EvmAddress;
  /** 链上 name() 原文 */
  name: string;
  /** 与链上 DOMAIN_SEPARATOR() 匹配成功的版本串；null = 域里不含 version */
  version: string | null;
  domainSeparator: Bytes32;
  verifiedBlock: number;
  verifiedAt: IsoUtc;
  forkAcceptance: { block: number; tx: Hex } | null;
  sources: string[];
}
export interface PermitDomainsFile { version: "permit-domains/1"; chainId: number; entries: PermitDomainEntry[] }

/* ---------- §2.5 执行作业与步骤生命周期 ---------- */
export const EXECUTION_JOB_KINDS = ["permit", "execute_step"] as const;
export type ExecutionJobKind = (typeof EXECUTION_JOB_KINDS)[number];
export const EXECUTION_JOB_STATES = ["QUEUED", "CLAIMED", "SENDING", "SENT", "CONFIRMED", "REVERTED", "EXPIRED", "FAILED", "CANCELLED"] as const;
export type ExecutionJobState = (typeof EXECUTION_JOB_STATES)[number];
export const TERMINAL_EXECUTION_JOB_STATES = ["CONFIRMED", "REVERTED", "EXPIRED", "FAILED", "CANCELLED"] as const;
export const FAULT_KINDS = ["cert_void", "receipt_delay", "rpc_timeout", "double_claim"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
export interface FaultSpec { kind: FaultKind; delayS?: number; createdAt: IsoUtc; by: string }
export interface ExecuteStepJobPayload {
  mandateId: string;
  stepId: string;
  stepIndex: number;
  /** 证书里签名的 validUntil（到期判断只认它） */
  validUntil: IsoUtc;
  /** = MandatesService.pullStep 的 READY 体（guardCall、approval、证书等），只给执行身份 */
  ready: Record<string, unknown>;
  fault?: FaultSpec;
}
export interface PermitJobPayload {
  permitId: string;
  owner: EvmAddress;
  token: EvmAddress;
  spender: EvmAddress;
  value: RawAmount;
  nonce: RawAmount;
  deadline: string;
  signature: Hex;
  fault?: FaultSpec;
}
export interface ExecutionJob {
  id: string;
  kind: ExecutionJobKind;
  taskId: string | null;
  mandateId: string | null;
  stepId: string | null;
  stepIndex: number | null;
  owner: EvmAddress;
  token: EvmAddress | null;
  state: ExecutionJobState;
  attempt: number;
  leaseUntil: IsoUtc | null;
  claimedBy: string | null;
  txHash: Hex | null;
  txNonce: string | null;
  validUntil: IsoUtc | null;
  errorCode: string | null;
  payload: PermitJobPayload | ExecuteStepJobPayload;
}
export type ExecutorEventType = "sending" | "sent" | "preflight_failed" | "receipt" | "abandoned";
/** reconcileStep 的判定（开发计划 §2.5 表驱动） */
export type StepReconcileVerdict = "CONFIRMED_BY_RECEIPT" | "WAIT" | "REVERTED" | "EXECUTED_ELSEWHERE" | "EXPIRED";
/** classifyRevert 的失败类别 */
export const REVERT_CLASSES = ["retry_new_cert", "wait_clock", "replan", "liquidity", "chain_ahead", "scope", "terminal", "allowance", "balance", "paused", "bug", "unknown"] as const;
export type RevertClass = (typeof REVERT_CLASSES)[number];

/* ---------- §2.6 Agent 运行时 ---------- */
export const AGENT_RUN_STATES = ["CLAIMED", "RUNNING", "COMPLETED", "INCOMPLETE", "FAILED", "CANCELLED"] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];
/** v7 新增的轮次原因（与 tasks/agentTurn.ts 的 AGENT_TURN_REASONS 合并后即全集；由 Lane A 并入） */
export const V7_AGENT_TURN_REASONS = ["assigned", "scheduled", "data_arrived", "execution_failed"] as const;
export interface AgentRunStep {
  seq: number;
  kind: "model" | "tool";
  name?: string;
  argsHash?: Bytes32;
  resultHash?: Bytes32;
  argsPreview?: string;
  resultPreview?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
  at: IsoUtc;
  error?: string;
}
export interface AgentRunSummary {
  runId: string;
  taskId: string;
  turnVersion: number;
  attempt: number;
  turnReason: string;
  mode: "LIVE" | "SIMULATION";
  model: string;
  /** prompts/system.md 的内容哈希 */
  promptHash: Bytes32;
  startedAt: IsoUtc;
  endedAt: IsoUtc | null;
  state: AgentRunState;
  action: { kind: "intent" | "status"; ref: string; status: string } | null;
  /** ≤ 280 字，取自 rationale / note */
  decisionSummary: string;
  nextCheckAt: IsoUtc | null;
  invalidation: string | null;
  toolCalls: Array<{ name: string; argsHash: Bytes32; resultHash: Bytes32 }>;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsdMicros: string };
  prevRunHash: Bytes32 | null;
  /** hashCanonical({ v: "agent-run/1", prevRunHash, taskId, turnVersion, attempt, model, promptHash, toolCalls, action, decisionSummary, nextCheckAt }) */
  runHash: Bytes32;
}
/** 托管 Agent 暴露给模型的 verify-mcp 工具（12 个；再加本地 fetch_source = 13 个） */
export const HOSTED_AGENT_MCP_TOOLS = ["get_turn_context", "get_executable_quotes", "get_market_context", "get_events", "explain_task_wait", "get_task_positions", "get_task_activity", "add_thesis_review_item", "submit_trade_intent", "withdraw_trade_intent", "report_agent_status", "remember_note"] as const;
export const AGENT_MEMORY_MAX_NOTES = 20 as const;
export const AGENT_MEMORY_NOTE_MAX_BYTES = 2048 as const;

/* ---------- §2.7 事件实际值 ---------- */
export interface EventOutcomeMetric {
  /** 例："payrolls_change"、"unemployment_rate"、"ahe_mom" */
  key: string;
  label: string;
  /** 十进制字符串（canon-1 不允许浮点） */
  actual: DecimalString;
  /** "thousands" | "percent" | "percent_mom" | "usd" … */
  unit: string;
  /** 统计期，如 "2026-09" */
  period: string;
  /** 本次发布里给出的上期值 */
  previous?: DecimalString;
  /** 本次发布对上期值的官方修订（统计机构的修订） */
  revisedPrevious?: DecimalString;
  /** 没有就不写；没有预期值不得生成「超预期 / 不及预期」 */
  expectation?: { value: DecimalString; kind: "survey" | "market_implied"; source: string; at: IsoUtc };
}
export interface EventOutcome {
  metrics: EventOutcomeMetric[];
  source: string;
  sourceUrl?: string;
  publishedAt: IsoUtc;
  fetchedAt: IsoUtc;
  provider: "crowsnest" | "finnhub";
}
export const EVENT_DATA_STATUSES = ["upcoming", "due_pending_data", "data_arrived", "revised"] as const;
export type EventDataStatus = (typeof EVENT_DATA_STATUSES)[number];
/** MarketEvent 的 v7 视图：producer 给 outcome；outcomeRevision / dataStatus 由服务端派生 */
export interface MarketEventV7 extends MarketEvent {
  outcome?: EventOutcome;
  outcomeRevision?: number;
  dataStatus?: EventDataStatus;
}

