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
export const MANDATE_STEP_STATES = ["PREPARED", "EXPIRED", "SUBMITTED", "REORG_PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"] as const;
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
export const PLAYBOOK_IDS = ["session_dca", "event_aware_accumulate", "discount_watch", "target_sell", "portfolio_rebalance"] as const;
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

export type PremiseKind = "machine" | "research";
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
export const NOTIFICATION_TYPES = ["task.status_changed", "task.step_ready", "task.step_confirmed", "task.step_reverted", "task.blocked", "event.revised", "event.released", "thesis.invalidated", "thesis.unknown", "budget.conflict", "budget.released", "task.expiring", "recap.ready"] as const;
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
