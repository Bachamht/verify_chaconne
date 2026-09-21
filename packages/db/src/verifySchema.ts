/**
 * Chaconne Verify 业务表（D-080；技术设计 §8）。
 * 只由 apps/verify-service 写；旧 poller/web/bot 不读不写。所有表前缀 verify_。
 * 金额一律 text（十进制整数串）；时间 timestamptz；JSON 用 jsonb。
 */
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/* ---------- 任务：一条固定意图 ---------- */
export const verifyJobs = pgTable(
  "verify_jobs",
  {
    id: text("id").primaryKey(), // job_<hex>
    callerId: text("caller_id").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    jobJson: jsonb("job_json").notNull(), // NormalizedJob
    policyDefinitionHash: text("policy_definition_hash").notNull(),
    effectivePolicyHash: text("effective_policy_hash").notNull(),
    policySnapshot: jsonb("policy_snapshot").notNull(), // { definition, params }
    registryVersion: text("registry_version").notNull(),
    registryHash: text("registry_hash").notNull(),
    executionChainId: integer("execution_chain_id").notNull(),
    guardAddress: text("guard_address"), // 首次准备执行时写入
    ownerAddress: text("owner_address").notNull(),
    executionNonce: text("execution_nonce"), // 首次准备时原子分配；同任务全部刷新共用
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    unique("verify_jobs_caller_req_uq").on(t.callerId, t.clientRequestId),
    unique("verify_jobs_nonce_uq").on(t.executionChainId, t.guardAddress, t.ownerAddress, t.executionNonce),
    index("verify_jobs_owner_idx").on(t.ownerAddress),
  ],
);

/* ---------- 服务订单：一个任务一张单，价格随订单版本固定 ---------- */
export const verifyOrders = pgTable("verify_orders", {
  id: text("id").primaryKey(), // ord_<hex>
  jobId: text("job_id").notNull().unique(),
  priceUsd: text("price_usd").notNull(), // 展示/定价口径（"0.01"）；"0" = 免费
  priceAmount: text("price_amount"), // 结算币最小单位（SDK 解析后回填）
  priceAsset: text("price_asset"), // 结算币合约地址
  network: text("network").notNull(), // eip155:196 | eip155:1952
  merchant: text("merchant").notNull(), // 收款地址
  state: text("state").notNull(), // OrderState
  /** v2：订单关联对象种类（job | plan | mandate）；job_id 列存该对象 id（历史列名，v2 起语义为 ref id） */
  refKind: text("ref_kind").notNull().default("job"),
  sku: text("sku").notNull().default("verify_once"), // ProductSku
  settledAt: ts("settled_at"),
  deliveredAt: ts("delivered_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/* ---------- 付款尝试：一次经 SDK 验证的付款凭证 ---------- */
export const verifyPaymentAttempts = pgTable(
  "verify_payment_attempts",
  {
    id: text("id").primaryKey(), // pay_<hex>
    orderId: text("order_id").notNull(),
    proofDigest: text("proof_digest").notNull(), // keccak(canonical(paymentPayload))，不存明文凭证
    payer: text("payer"),
    providerReference: text("provider_reference").unique(), // 结算 tx hash
    network: text("network").notNull(),
    state: text("state").notNull(), // VERIFIED | SETTLEMENT_PENDING | SETTLED | FAILED | UNKNOWN
    errorCode: text("error_code"),
    lastCheckedAt: ts("last_checked_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_payment_attempts_order_proof_uq").on(t.orderId, t.proofDigest), index("verify_payment_attempts_state_idx").on(t.state)],
);

/* ---------- 证据：规范化记录（原文私有存储只留指针） ---------- */
export const verifyEvidence = pgTable(
  "verify_evidence",
  {
    evidenceId: text("evidence_id").primaryKey(),
    jobId: text("job_id").notNull(),
    reportVersion: integer("report_version").notNull(),
    record: jsonb("record").notNull(), // EvidenceRecord
    rawRef: text("raw_ref"), // 私有原文指针（文件路径/对象键），可为空
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_evidence_job_idx").on(t.jobId, t.reportVersion)],
);

/* ---------- 报告：不可变，(job, version) 唯一 ---------- */
export const verifyReports = pgTable(
  "verify_reports",
  {
    jobId: text("job_id").notNull(),
    version: integer("version").notNull(),
    reportJson: jsonb("report_json").notNull(), // VerifyReport
    reportHash: text("report_hash").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    policyDefinitionHash: text("policy_definition_hash").notNull(),
    effectivePolicyHash: text("effective_policy_hash").notNull(),
    verdict: text("verdict").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.version] })],
);

/* ---------- 再核验额度：付款后 N 次 / 窗口内；DB 级非负与不超额 ---------- */
export const verifyEntitlements = pgTable(
  "verify_entitlements",
  {
    orderId: text("order_id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    maxRefreshes: integer("max_refreshes").notNull(),
    usedRefreshes: integer("used_refreshes").notNull().default(0),
    reservedRefreshes: integer("reserved_refreshes").notNull().default(0),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    check("verify_entitlements_nonneg", sql`${t.usedRefreshes} >= 0 AND ${t.reservedRefreshes} >= 0`),
    check("verify_entitlements_cap", sql`${t.usedRefreshes} + ${t.reservedRefreshes} <= ${t.maxRefreshes}`),
  ],
);

/* ---------- 执行尝试：一次准备执行 = 新报告版本 + 证书 ---------- */
export const verifyExecutionAttempts = pgTable(
  "verify_execution_attempts",
  {
    id: text("id").primaryKey(), // exe_<hex>
    jobId: text("job_id").notNull(),
    refreshKey: text("refresh_key").notNull(), // 客户端幂等键
    reportVersion: integer("report_version").notNull(),
    nonce: text("nonce").notNull(),
    intentJson: jsonb("intent_json").notNull(), // TradeIntent
    intentDigest: text("intent_digest").notNull(),
    calldataHash: text("calldata_hash").notNull(),
    certificateJson: jsonb("certificate_json"), // VerificationCertificate（拒绝时 null）
    certificateSignature: text("certificate_signature"),
    validUntil: ts("valid_until"),
    state: text("state").notNull(), // ExecutionState
    txHash: text("tx_hash"),
    receiptJson: jsonb("receipt_json"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_execution_attempts_refresh_uq").on(t.jobId, t.refreshKey), index("verify_execution_attempts_job_idx").on(t.jobId)],
);

/* ---------- 付款事件：对账审计链 + outbox ---------- */
export const verifyPaymentEvents = pgTable(
  "verify_payment_events",
  {
    id: serial("id").primaryKey(),
    paymentAttemptId: text("payment_attempt_id"),
    source: text("source").notNull(), // sdk_verify | sdk_settle | reconcile | manual
    eventKey: text("event_key").notNull(), // 来源内唯一（如 txHash:status）
    digest: text("digest").notNull(),
    payload: jsonb("payload").notNull(), // 脱敏摘要
    occurredAt: ts("occurred_at").notNull(),
    processed: boolean("processed").notNull().default(false),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [unique("verify_payment_events_source_key_uq").on(t.source, t.eventKey), index("verify_payment_events_unprocessed_idx").on(t.processed)],
);

/* ---------- 退款工单：区分 requested / approved / submitted / confirmed / failed ---------- */
export const verifyRefunds = pgTable(
  "verify_refunds",
  {
    id: text("id").primaryKey(), // rfd_<hex>
    orderId: text("order_id").notNull(),
    requestId: text("request_id").notNull(),
    reason: text("reason").notNull(),
    requestedAmount: text("requested_amount").notNull(),
    currency: text("currency").notNull(),
    state: text("state").notNull(),
    providerReference: text("provider_reference"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_refunds_order_request_uq").on(t.orderId, t.requestId)],
);

/* ================================================================== */
/* v2（迁移 0017，升级执行计划 v5 §3.6 / interfaces §10.6）              */
/* ================================================================== */

/* ---------- 规划任务：一个目标 → 有限候选 ---------- */
export const verifyPlans = pgTable(
  "verify_plans",
  {
    id: text("id").primaryKey(), // pln_<hex>
    callerId: text("caller_id").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    goalJson: jsonb("goal_json").notNull(), // PlanGoal
    goalHash: text("goal_hash").notNull(),
    planJson: jsonb("plan_json").notNull(), // PlanReport
    planHash: text("plan_hash").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    evidenceJson: jsonb("evidence_json").notNull(), // EvidenceRecord[]
    registryHash: text("registry_hash").notNull(),
    policyDefinitionHash: text("policy_definition_hash").notNull(),
    effectivePolicyHash: text("effective_policy_hash").notNull(),
    policySnapshot: jsonb("policy_snapshot").notNull(),
    evaluatedAt: ts("evaluated_at").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [unique("verify_plans_caller_req_uq").on(t.callerId, t.clientRequestId), index("verify_plans_owner_idx").on(t.ownerAddress)],
);

/* ---------- 授权计划：用户一次签署的 TradeMandate ---------- */
export const verifyMandates = pgTable(
  "verify_mandates",
  {
    id: text("id").primaryKey(), // mnd_<hex>
    callerId: text("caller_id").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    planId: text("plan_id"),
    jobId: text("job_id"),
    ownerAddress: text("owner_address").notNull(),
    chainId: integer("chain_id").notNull(),
    planGuardAddress: text("plan_guard_address").notNull(),
    mandateJson: jsonb("mandate_json").notNull(), // { mandate: TradeMandate, domain, legs: [{outputToken, weightBps}], inputAssetKey, outputAssetKeys, sku }
    mandateDigest: text("mandate_digest").notNull().unique(),
    signature: text("signature").notNull(),
    policyDefinitionHash: text("policy_definition_hash").notNull(),
    effectivePolicyHash: text("effective_policy_hash").notNull(),
    policySnapshot: jsonb("policy_snapshot").notNull(),
    registryHash: text("registry_hash").notNull(),
    state: text("state").notNull(), // MandateState
    budgetCap: text("budget_cap").notNull(),
    spent: text("spent").notNull().default("0"),
    stepsDone: integer("steps_done").notNull().default(0),
    maxSteps: integer("max_steps").notNull(),
    validFrom: ts("valid_from").notNull(),
    deadline: ts("deadline").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_mandates_caller_req_uq").on(t.callerId, t.clientRequestId), index("verify_mandates_state_idx").on(t.state)],
);

/* ---------- 授权计划评估：monitor 每轮一行 ---------- */
export const verifyMandateEvaluations = pgTable(
  "verify_mandate_evaluations",
  {
    id: text("id").primaryKey(), // evl_<hex>
    mandateId: text("mandate_id").notNull(),
    evaluatedAt: ts("evaluated_at").notNull(),
    status: text("status").notNull(), // READY | WAIT | BLOCKED | DONE
    reportJson: jsonb("report_json"), // VerifyReport（评估用的完整报告）
    jobJson: jsonb("job_json"), // NormalizedJob（该次评估的步骤任务原文；规则重算用）
    reportHash: text("report_hash"),
    evidenceJson: jsonb("evidence_json").notNull(), // EvidenceRecord[]
    reasonsJson: jsonb("reasons_json").notNull(),
    deltaJson: jsonb("delta_json"), // DeltaExplanation | null
    preparedStepIndex: integer("prepared_step_index"),
  },
  (t) => [index("verify_mandate_evaluations_mandate_idx").on(t.mandateId, t.evaluatedAt)],
);

/* ---------- 授权计划步骤：签发的步骤证书与执行回执 ---------- */
export const verifyMandateSteps = pgTable(
  "verify_mandate_steps",
  {
    id: text("id").primaryKey(), // stp_<hex>
    mandateId: text("mandate_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    evaluationId: text("evaluation_id"),
    state: text("state").notNull(), // MandateStepState
    stepJson: jsonb("step_json").notNull(), // { step: MandateStep, routerCalldata, domain, reportHash }
    stepDigest: text("step_digest").notNull(),
    certificateJson: jsonb("certificate_json").notNull(), // { certificate: StepCertificate, signer }
    certificateSignature: text("certificate_signature").notNull(),
    validUntil: ts("valid_until").notNull(),
    pulledAt: ts("pulled_at"),
    txHash: text("tx_hash"),
    receiptJson: jsonb("receipt_json"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_mandate_steps_mandate_step_uq").on(t.mandateId, t.stepIndex), index("verify_mandate_steps_state_idx").on(t.state)],
);

/* ---------- 模拟任务：跑规划与规则，不签证书不执行 ---------- */
export const verifySimulations = pgTable(
  "verify_simulations",
  {
    id: text("id").primaryKey(), // sim_<hex>
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    personaId: text("persona_id"),
    goalJson: jsonb("goal_json").notNull(),
    planJson: jsonb("plan_json").notNull(),
    planHash: text("plan_hash").notNull(),
    evidenceMode: text("evidence_mode").notNull(), // 底层证据模式（LIVE/FIXTURE）；对外一律标 SIMULATION
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_simulations_owner_idx").on(t.ownerAddress)],
);

/* ---------- 角色：只影响文案 ---------- */
export const verifyProfiles = pgTable("verify_profiles", {
  ownerAddress: text("owner_address").primaryKey(),
  personaId: text("persona_id").notNull(),
  name: text("name").notNull(),
  tone: text("tone").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/* ---------- 翻创模板：结构不含金额/钱包 ---------- */
export const verifyTemplates = pgTable("verify_templates", {
  id: text("id").primaryKey(), // tpl_<hex>
  authorAddress: text("author_address").notNull(),
  authorName: text("author_name"),
  kind: text("kind").notNull(), // job | plan
  templateJson: jsonb("template_json").notNull(),
  createdAt: ts("created_at").notNull(),
});

/* ---------- 战报公开设置 ---------- */
export const verifyShares = pgTable(
  "verify_shares",
  {
    shareId: text("share_id").primaryKey(), // shr_<hex>
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    kind: text("kind").notNull(), // job | mandate | simulation | plan
    refId: text("ref_id").notNull(),
    privacyJson: jsonb("privacy_json").notNull(), // SharePrivacy
    public: boolean("public").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_shares_ref_uq").on(t.kind, t.refId), index("verify_shares_public_idx").on(t.public, t.createdAt)],
);
