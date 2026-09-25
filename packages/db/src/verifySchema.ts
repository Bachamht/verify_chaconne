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
    /* ---- v6 Lane B ---- */
    /** 所属任务（null = v5 独立授权计划，由 mandates monitor 直接评估；非 null 的只经任务前置链评估） */
    taskId: text("task_id"),
    /** 授权承诺的条件集哈希（进 effectivePolicyHash 展开参数 → 证书与证据包，K-10） */
    conditionsHash: text("conditions_hash"),
  },
  (t) => [unique("verify_mandates_caller_req_uq").on(t.callerId, t.clientRequestId), index("verify_mandates_state_idx").on(t.state), index("verify_mandates_task_idx").on(t.taskId)],
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


/* ================================================================== */
/* ---- v6 Lane B ----                                                 */
/* 上下文快照 / 事件与修订 / 任务与阻塞快照 / 理由卡与检查；verify_mandates 增列在上方表定义里（task_id / conditions_hash）。 */
/* 迁移 0018 由 Lane I 统一重生成（合并 B/C/D/E 的表）。                */
/* ================================================================== */

/* ---------- 上下文快照：每次摄入全量 + 哈希 + 逐字段 status（interfaces §11.9） ---------- */
export const verifyContextSnapshots = pgTable(
  "verify_context_snapshots",
  {
    id: text("id").primaryKey(), // ctx_<hex>
    producer: text("producer").notNull(), // crowsnest
    publicKeyId: text("public_key_id"),
    packagedAt: ts("packaged_at"),
    receivedAt: ts("received_at").notNull(),
    /** ok | rejected（验签/结构失败）| unavailable（不可达） */
    status: text("status").notNull(),
    signatureValid: boolean("signature_valid").notNull().default(false),
    contextHash: text("context_hash"),
    /** CV-D13：live | backfill | sample（只有 live 可参与 LIVE 判定） */
    provenanceMode: text("provenance_mode"),
    fieldStatus: jsonb("field_status").notNull(), // Record<path, CtxStatus>
    contextJson: jsonb("context_json"), // MarketContext（验签通过的全量；拒收时 null）
    evidenceJson: jsonb("evidence_json").notNull(), // EvidenceRecord(kind=market_context)
    rawHash: text("raw_hash").notNull(),
    sourceEndpoint: text("source_endpoint").notNull(),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_context_snapshots_received_idx").on(t.receivedAt), index("verify_context_snapshots_status_idx").on(t.status, t.receivedAt)],
);

/* verify_events / verify_event_revisions：见 packages/db/src/schema.ts 的 Lane D 块（同名同义，B 直接用 D 的表） */

/* ---------- 任务：playbook + 条件 + 授权 + 理由卡 + 资金组 ---------- */
export const verifyTasks = pgTable(
  "verify_tasks",
  {
    id: text("id").primaryKey(), // tsk_<hex>
    callerId: text("caller_id").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    playbookId: text("playbook_id").notNull(),
    playbookVersion: text("playbook_version").notNull(),
    paramsJson: jsonb("params_json").notNull(),
    goalJson: jsonb("goal_json").notNull(), // PlanGoal
    conditionsJson: jsonb("conditions_json").notNull(), // ConditionSet
    conditionsHash: text("conditions_hash").notNull(),
    /** 授权范围（scope/1，CV-D16）：目标 / 资产集合 / 总额 / 每笔上限 / 期限 / 允许卖出 / 信任档位 / 签发方式 / 硬约束 */
    scopeJson: jsonb("scope_json"), // TaskScope
    /** scopeHash = 签名折入的绑定哈希（effectivePolicyHash 展开参数 conditionsHash 的取值）；旧任务 null = 折的是 conditions_hash */
    scopeHash: text("scope_hash"),
    /** 唤醒通路（CV-D16 批次 3）：当前轮次 AgentTurn（只对 scope.issuance=agent 的任务） */
    agentTurnJson: jsonb("agent_turn_json"),
    /** 任务简报（批次 6，签名之外可改）：TaskBrief = 策略文本（带版本历史）+ 关注的事件 + 接管的 agent + 示例来源 */
    briefJson: jsonb("brief_json"),
    /** 用户删除（归档）：列表与记录里不再出现，详情仍可打开（授权 / 证书 / 回执不销毁） */
    archivedAt: ts("archived_at"),
    mode: text("mode").notNull(), // LIVE | SIMULATION
    status: text("status").notNull(), // TaskStatus
    mandateIds: jsonb("mandate_ids").notNull().$type<string[]>(),
    thesisId: text("thesis_id"),
    budgetGroupId: text("budget_group_id"),
    blockersJson: jsonb("blockers_json").notNull(), // Blocker[]
    nextCheckAt: ts("next_check_at"),
    /** 最近一次评估（含 mandate 评估摘要），页面/explain-wait 用 */
    lastEvaluationJson: jsonb("last_evaluation_json"),
    planId: text("plan_id"),
    planJson: jsonb("plan_json"), // PlanReport（候选）
    mandateDraftJson: jsonb("mandate_draft_json"), // { mandate, domain, typedData }（未签）
    budgetAllocationJson: jsonb("budget_allocation_json"),
    /** 时间线：status 变更 / 停止 / 授权 / 理由卡动作 */
    timelineJson: jsonb("timeline_json").notNull(),
    exitDraftJson: jsonb("exit_draft_json"), // draft_exit 生成的卖出草案
    stepsConfirmed: integer("steps_confirmed").notNull().default(0),
    stepsPlanned: integer("steps_planned").notNull(),
    lastConfirmedStepAt: ts("last_confirmed_step_at"),
    deadline: ts("deadline").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_tasks_caller_req_uq").on(t.callerId, t.clientRequestId), index("verify_tasks_owner_idx").on(t.ownerAddress), index("verify_tasks_status_idx").on(t.status, t.nextCheckAt)],
);

/* ---------- agent 交易意图（CV-D16 批次 2）：意图 + 决策记录 + 四道核验结果；certified 的意图指向签发的步骤 ---------- */
export const verifyTaskIntents = pgTable(
  "verify_task_intents",
  {
    id: text("id").primaryKey(), // int_<hex>
    taskId: text("task_id").notNull(),
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    kind: text("kind").notNull(), // buy | sell
    outputAssetKey: text("output_asset_key").notNull(),
    amountInRaw: text("amount_in_raw").notNull(),
    decisionJson: jsonb("decision_json").notNull(), // DecisionRecord（agent 原样提交）
    triageJson: jsonb("triage_json").notNull(), // ClaimTriage[]
    checksJson: jsonb("checks_json").notNull(), // IntentCheck[]
    planDeviationsJson: jsonb("plan_deviations_json").notNull(), // Reason[]（计划条件偏离，信息项）
    status: text("status").notNull(), // IntentStatus
    stepJson: jsonb("step_json"), // { mandateId, stepIndex, validUntil }
    /** 本次核验用到的证据 id（决策记录里 platform_fact 的核对范围） */
    evidenceIdsJson: jsonb("evidence_ids_json").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_task_intents_task_req_uq").on(t.taskId, t.clientRequestId), index("verify_task_intents_task_idx").on(t.taskId, t.createdAt)],
);

/* ---------- 任务阻塞快照：阻塞集合变化才写一行（含可复算的求值输入） ---------- */
export const verifyTaskBlockers = pgTable(
  "verify_task_blockers",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id").notNull(),
    evaluatedAt: ts("evaluated_at").notNull(),
    outcome: text("outcome").notNull(), // ConditionOutcome
    blockersJson: jsonb("blockers_json").notNull(), // Blocker[]
    blockerSetKey: text("blocker_set_key").notNull(),
    nextCheckAt: ts("next_check_at"),
    /** ConditionEvaluationRecord（input + output）——验证器复算用 */
    evaluationJson: jsonb("evaluation_json").notNull(),
    /** 本次求值用到的规范化证据记录（market_context / market_event / okx_quote…）；Lane E 对照与回放读 */
    recordsJson: jsonb("records_json"),
  },
  (t) => [index("verify_task_blockers_task_idx").on(t.taskId, t.evaluatedAt)],
);

/* ---------- 理由卡 ---------- */
export const verifyTheses = pgTable(
  "verify_theses",
  {
    id: text("id").primaryKey(), // ths_<hex>
    taskId: text("task_id").notNull(),
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    goal: text("goal").notNull(),
    rationale: text("rationale").notNull(),
    premisesJson: jsonb("premises_json").notNull(), // Premise[]
    validUntil: ts("valid_until").notNull(),
    onInvalidation: text("on_invalidation").notNull(),
    status: text("status").notNull(), // ThesisStatus
    lastCheckedAt: ts("last_checked_at"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("verify_theses_task_idx").on(t.taskId), index("verify_theses_owner_idx").on(t.ownerAddress)],
);

/* ---------- 理由卡检查记录：每次重评一行 ---------- */
export const verifyThesisChecks = pgTable(
  "verify_thesis_checks",
  {
    id: serial("id").primaryKey(),
    thesisId: text("thesis_id").notNull(),
    checkedAt: ts("checked_at").notNull(),
    status: text("status").notNull(),
    premisesJson: jsonb("premises_json").notNull(),
    /** 触发的 onInvalidation 动作（notify | pause_issuance | draft_exit | expired | null） */
    actionTaken: text("action_taken"),
    evidenceIds: jsonb("evidence_ids").notNull().$type<string[]>(),
  },
  (t) => [index("verify_thesis_checks_thesis_idx").on(t.thesisId, t.checkedAt)],
);

/* ================================================================== */
/* ---- v6 Lane C ----（迁移 0018；interfaces §11.9。B/D/E 的表由 Lane I 并进同一份 0018） */
/* ================================================================== */

/* ---------- 资金组（C8，D-086 服务侧协调；一组 = 一个预算周期） ---------- */
export const verifyBudgetGroups = pgTable(
  "verify_budget_groups",
  {
    id: text("id").primaryKey(), // bgp_<hex>
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    name: text("name").notNull(),
    inputAssetKey: text("input_asset_key").notNull(),
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    capRaw: text("cap_raw").notNull(),
    cashFloorRaw: text("cash_floor_raw").notNull().default("0"),
    priorityRule: text("priority_rule").notNull().default("priority_then_created"),
    /** 乐观锁/账目版本：每次分配/结算/释放 +1（通知 version 也用它） */
    version: integer("version").notNull().default(0),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("verify_budget_groups_owner_idx").on(t.ownerAddress), check("verify_budget_groups_period_chk", sql`${t.periodEnd} > ${t.periodStart}`)],
);

/* ---------- 资金组分配：一条授权在一组内的预留/占用/支出（BudgetAllocation） ---------- */
export const verifyBudgetAllocations = pgTable(
  "verify_budget_allocations",
  {
    id: text("id").primaryKey(), // bal_<hex>
    groupId: text("group_id").notNull(),
    taskId: text("task_id").notNull(),
    mandateId: text("mandate_id").notNull(),
    priority: integer("priority").notNull().default(100),
    requestedRaw: text("requested_raw").notNull(),
    reservedRaw: text("reserved_raw").notNull().default("0"),
    spentRaw: text("spent_raw").notNull().default("0"),
    pendingRaw: text("pending_raw").notNull().default("0"),
    state: text("state").notNull(), // reserved | waiting | released | settled
    /** 归属周期（跨周期授权必须显式指定；缺省 = 组周期） */
    periodStart: ts("period_start").notNull(),
    periodEnd: ts("period_end").notNull(),
    releaseReason: text("release_reason"), // reverted | expired | revoked | cancelled
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_budget_allocations_group_mandate_uq").on(t.groupId, t.mandateId), index("verify_budget_allocations_group_idx").on(t.groupId, t.state), index("verify_budget_allocations_mandate_idx").on(t.mandateId)],
);

/* ---------- 资金组流水：预留/等待/在途/结算/释放/现金下限检查（只追加） ---------- */
export const verifyBudgetLedger = pgTable(
  "verify_budget_ledger",
  {
    id: serial("id").primaryKey(),
    groupId: text("group_id").notNull(),
    allocationId: text("allocation_id"),
    kind: text("kind").notNull(), // reserve | waiting | pending | settle | release | promote | cash_floor_check
    amountRaw: text("amount_raw").notNull(),
    spentAfterRaw: text("spent_after_raw").notNull(),
    reservedAfterRaw: text("reserved_after_raw").notNull(),
    /** 不变量断言结果（每次分配/结算后，B-02） */
    invariantOk: boolean("invariant_ok").notNull(),
    detail: jsonb("detail"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_budget_ledger_group_idx").on(t.groupId, t.createdAt)],
);

/* ---------- 自报成本（C4，Q-03：source 固定 user_reported，与链上可追溯成本分开展示） ---------- */
export const verifyCostOverrides = pgTable(
  "verify_cost_overrides",
  {
    id: text("id").primaryKey(), // ovr_<hex>
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    assetKey: text("asset_key").notNull(),
    qtyRaw: text("qty_raw").notNull(),
    /** 该数量的总成本（资金币最小单位） */
    costRaw: text("cost_raw").notNull(),
    inputAssetKey: text("input_asset_key").notNull(),
    source: text("source").notNull().default("user_reported"),
    note: text("note"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_cost_overrides_owner_idx").on(t.ownerAddress, t.assetKey)],
);

/* ---------- 通知渠道：webhook（HMAC-SHA256）/ Telegram（独立 bot，只推送） ---------- */
export const verifyNotificationChannels = pgTable(
  "verify_notification_channels",
  {
    id: text("id").primaryKey(), // nch_<hex>
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    kind: text("kind").notNull(), // webhook | telegram
    /** webhook: URL；telegram: chat id（链接完成后） */
    target: text("target"),
    /** webhook 签名密钥（调用方提供的共享密钥，不是链上私钥）；telegram: null */
    secret: text("secret"),
    state: text("state").notNull(), // active | pending_link | disabled
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    linkCode: text("link_code"),
    linkExpiresAt: ts("link_expires_at"),
    linkedAt: ts("linked_at"),
    disabledAt: ts("disabled_at"),
    disabledReason: text("disabled_reason"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("verify_notification_channels_owner_idx").on(t.ownerAddress, t.state), index("verify_notification_channels_link_idx").on(t.linkCode)],
);

/* ---------- 通知 outbox：幂等键 `${type}:${entityId}:${version}`；载荷只含 id/类型/版本/摘要/链接 ---------- */
export const verifyNotificationOutbox = pgTable(
  "verify_notification_outbox",
  {
    id: text("id").primaryKey(), // ntf_<hex>
    idempotencyKey: text("idempotency_key").notNull().unique(),
    ownerAddress: text("owner_address").notNull(),
    type: text("type").notNull(),
    entityId: text("entity_id").notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").notNull(), // NotificationPayload
    state: text("state").notNull(), // pending | sent | failed | no_channel
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    /** 每渠道投递记录 [{channelId, kind, ok, status, at, error?}] */
    deliveries: jsonb("deliveries").notNull().default([]),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("verify_notification_outbox_state_idx").on(t.state, t.nextAttemptAt), index("verify_notification_outbox_entity_idx").on(t.entityId)],
);

/* ---------- 执行器心跳（60 s）：3 分钟内有心跳 = online ---------- */
export const verifyExecutorHeartbeats = pgTable(
  "verify_executor_heartbeats",
  {
    id: text("id").primaryKey(), // hb_<hex>
    mandateId: text("mandate_id").notNull(),
    executorId: text("executor_id").notNull(),
    path: text("path").notNull(), // agent_wallet | browser_wallet
    lastSeenAt: ts("last_seen_at").notNull(),
    meta: jsonb("meta"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [unique("verify_executor_heartbeats_mandate_executor_uq").on(t.mandateId, t.executorId), index("verify_executor_heartbeats_mandate_idx").on(t.mandateId, t.lastSeenAt)],
);

/* ---------- 调仓计划（C3 `portfolio_rebalance`）：先卖后买、每腿单独授权、允许 PARTIAL ---------- */
export const verifyRebalancePlans = pgTable(
  "verify_rebalance_plans",
  {
    id: text("id").primaryKey(), // rbp_<hex>
    callerId: text("caller_id").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    taskId: text("task_id"),
    budgetGroupId: text("budget_group_id"),
    inputAssetKey: text("input_asset_key").notNull(),
    cashFloorRaw: text("cash_floor_raw").notNull(),
    targetsJson: jsonb("targets_json").notNull(),
    previewJson: jsonb("preview_json").notNull(), // RebalancePreview
    snapshotJson: jsonb("snapshot_json").notNull(), // portfolio_snapshot 证据
    policyJson: jsonb("policy_json").notNull(), // { policyId, policyVersion, maxSlippageBps, maxPriceImpactBps, maxReferenceDeviationBps }
    state: text("state").notNull(), // DRAFT | ACTIVE | PARTIAL | COMPLETED | CANCELLED
    phase: text("phase").notNull(), // selling | buying | done
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_rebalance_plans_caller_req_uq").on(t.callerId, t.clientRequestId), index("verify_rebalance_plans_owner_idx").on(t.ownerAddress)],
);

export const verifyRebalanceLegs = pgTable(
  "verify_rebalance_legs",
  {
    id: text("id").primaryKey(), // rbl_<hex>
    planId: text("plan_id").notNull(),
    legIndex: integer("leg_index").notNull(),
    side: text("side").notNull(), // sell | buy
    assetKey: text("asset_key").notNull(),
    amountRaw: text("amount_raw").notNull(),
    estUsd: text("est_usd").notNull(),
    state: text("state").notNull(), // PLANNED | READY_TO_AUTHORIZE | AUTHORIZED | CONFIRMED | FAILED | SKIPPED
    mandateId: text("mandate_id"),
    draftJson: jsonb("draft_json"), // 授权草案（未签 TradeMandate + typedData 域）
    resultJson: jsonb("result_json"), // { spentRaw, receivedRaw, txHash, reason }
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_rebalance_legs_plan_leg_uq").on(t.planId, t.legIndex), index("verify_rebalance_legs_mandate_idx").on(t.mandateId)],
);

/* ---- v6 Lane E ---- */
/* 决策实验（C9）：对照与回放的落库。迁移由 Lane I 合并进 0018；合并前测试/演示用 apps/verify-service/src/lab/store.ts 的 DDL 建表。 */

/* ---------- 同输入对照：固定同一证据快照，SIMULATION，不写授权 ---------- */
export const verifyPolicyComparisons = pgTable(
  "verify_policy_comparisons",
  {
    id: text("id").primaryKey(), // cmp_<hex>（由内容派生）
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    taskId: text("task_id").notNull(),
    evidenceSnapshotId: text("evidence_snapshot_id").notNull(), // snap_<hash 前 24 hex>
    snapshotHash: text("snapshot_hash").notNull(),
    comparisonJson: jsonb("comparison_json").notNull(), // PolicyComparison
    resultJson: jsonb("result_json").notNull(), // ComparePoliciesResult（含 planner 摘要、outcomeDiff、remix）
    evaluatorId: text("evaluator_id").notNull(),
    mode: text("mode").notNull().default("SIMULATION"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_policy_comparisons_task_idx").on(t.taskId, t.createdAt)],
);

/* ---------- 决策回放：无前视，输出覆盖与缺口，不输出收益 ---------- */
export const verifyReplays = pgTable(
  "verify_replays",
  {
    id: text("id").primaryKey(), // rpl_<hex>
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address"),
    assetKey: text("asset_key").notNull(),
    playbookId: text("playbook_id").notNull(),
    conditionsHash: text("conditions_hash").notNull(),
    fromAt: ts("from_at").notNull(),
    toAt: ts("to_at").notNull(),
    runJson: jsonb("run_json").notNull(), // ReplayRun
    resultJson: jsonb("result_json").notNull(), // ReplayRunResult（含 sources 计数与说明）
    evaluatorId: text("evaluator_id").notNull(),
    mode: text("mode").notNull().default("REPLAY"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_replays_caller_idx").on(t.callerId, t.createdAt)],
);

/* ---- v6 Lane D ---- */
/* 个人事件台（C6）。`verify_events` / `verify_event_revisions` 按 interfaces.md §11.2 契约定义（Lane B 同名同义，合并时 Lane I 去重）；
 * `verify_earnings_*` 是 Lane D 自己的财报源摄入记录与"同一事件"匹配键。迁移 0018 由 Lane C 出，本文件只定义。 */
export const verifyEvents = pgTable(
  "verify_events",
  {
    /** `${source}:${kind}:${YYYY-MM-DD}:${slug}`；改期不换 id */
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    underlyingIds: jsonb("underlying_ids").notNull(), // string[]
    scheduledAtUtc: ts("scheduled_at_utc"),
    dateLocal: text("date_local").notNull(),
    datePrecision: text("date_precision").notNull(), // exact | day | estimate
    sessionHint: text("session_hint"), // bmo | amc | dmh | null
    status: text("status").notNull(), // confirmed | estimated | revised | cancelled | released
    revision: integer("revision").notNull(),
    revisedFrom: jsonb("revised_from"), // { scheduledAtUtc, dateLocal } | null
    source: text("source").notNull(),
    sourceFetchedAt: ts("source_fetched_at").notNull(),
    /** 首次入库时刻与 producer 值的较早者 */
    firstKnownAt: ts("first_known_at").notNull(),
    releasedAt: ts("released_at"),
    tz: text("tz").notNull(),
    /** 完整 MarketEvent（契约字段以此为准） */
    eventJson: jsonb("event_json").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("verify_events_kind_date_idx").on(t.kind, t.dateLocal), index("verify_events_status_idx").on(t.status)],
);

export const verifyEventRevisions = pgTable(
  "verify_event_revisions",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    revision: integer("revision").notNull(),
    eventJson: jsonb("event_json").notNull(), // 该版本的完整 MarketEvent
    changedFields: jsonb("changed_fields").notNull(), // string[]
    changedAt: ts("changed_at").notNull(),
  },
  (t) => [unique("verify_event_revisions_uq").on(t.eventId, t.revision)],
);

/** 财报源每次请求一条：覆盖判定（EARNINGS_COVERAGE_UNKNOWN）与证据回溯都从这里读 */
export const verifyEarningsIngests = pgTable(
  "verify_earnings_ingests",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(), // finnhub
    symbol: text("symbol").notNull(),
    underlyingId: text("underlying_id").notNull(),
    httpStatus: integer("http_status").notNull(),
    ok: boolean("ok").notNull(),
    rowCount: integer("row_count").notNull(),
    rawHash: text("raw_hash").notNull(),
    requestedAt: ts("requested_at").notNull(),
    receivedAt: ts("received_at").notNull(),
    fromDate: text("from_date").notNull(),
    toDate: text("to_date").notNull(),
    eventIds: jsonb("event_ids").notNull(), // string[]
    evidenceIds: jsonb("evidence_ids").notNull(), // string[]
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_earnings_ingests_underlying_idx").on(t.underlyingId, t.receivedAt)],
);

/** "同一财报事件"匹配键（symbol + 财年 + 季度）→ 事件 id：改期时据此保住 id、只升 revision */
export const verifyEarningsPeriods = pgTable("verify_earnings_periods", {
  matchKey: text("match_key").primaryKey(), // `${source}:${symbol}:${year}Q${quarter}`
  eventId: text("event_id").notNull(),
  createdAt: ts("created_at").notNull(),
});
/* ---- v6 Lane F ----
 * Chaconne Agent C5：夜班日志与事件任务（interfaces §11.9；迁移 0018 由 Lane C 统一出，
 * 本块只定义列，与 verifySchema.ts 的 verify_* 表同一约定：金额 text、时间 timestamptz、JSON jsonb）。
 * verify-service 在表未落地时自动退回内存缓存（recaps/store.ts），不会因此拒启。 */
export const verifyRecaps = pgTable(
  "verify_recaps",
  {
    id: text("id").primaryKey(), // rcp_<hex>（owner+date 确定性 id）
    callerId: text("caller_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    /** 纽约本地交易日 YYYY-MM-DD */
    nyDate: text("ny_date").notNull(),
    /** 实际收盘（含提前收盘）+45 分钟，UTC */
    generateAfter: ts("generate_after").notNull(),
    generatedAt: ts("generated_at").notNull(),
    recapJson: jsonb("recap_json").notNull(), // Recap（apps/verify-service/src/recaps/types.ts）
    /** 分享：默认私密；公开时可隐藏资产与金额（R-04） */
    shareId: text("share_id"),
    public: boolean("public").notNull().default(false),
    hideAssets: boolean("hide_assets").notNull().default(true),
    hideAmounts: boolean("hide_amounts").notNull().default(true),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [unique("verify_recaps_owner_date_uq").on(t.callerId, t.ownerAddress, t.nyDate), index("verify_recaps_share_idx").on(t.shareId)],
);

export const verifyMissions = pgTable(
  "verify_missions",
  {
    id: text("id").primaryKey(), // msn_<hex>
    callerId: text("caller_id"),
    ownerAddress: text("owner_address"),
    kind: text("kind").notNull(), // event | replay | simulation
    eventId: text("event_id"),
    assetKey: text("asset_key"),
    /** 任务对应的标注日期（事件日或回放日，YYYY-MM-DD） */
    dateLabel: text("date_label").notNull(),
    mode: text("mode").notNull(), // LIVE | SIMULATION | REPLAY
    missionJson: jsonb("mission_json").notNull(), // Mission（apps/verify-service/src/missions/build.ts）
    /** 用户从该任务创建出的 task id（翻创记录，不是排行榜） */
    createdTaskId: text("created_task_id"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("verify_missions_owner_idx").on(t.ownerAddress, t.createdAt)],
);

/** 钱包绑定的 API key（FIX-175）：只存哈希；nonce 唯一 = 签名不能重放；revoked_at 非空即失效 */
export const verifyApiKeys = pgTable(
  "verify_api_keys",
  {
    id: text("id").primaryKey(), // key_<hex>
    keyHash: text("key_hash").notNull(), // sha256(hex) of the raw key
    ownerAddress: text("owner_address").notNull(),
    label: text("label").notNull(),
    /** 列表里认 key 用的片段（前 8 + 后 4 位），不是 key 本身 */
    hint: text("hint").notNull(),
    nonce: text("nonce").notNull(),
    createdAt: ts("created_at").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [unique("verify_api_keys_hash_uq").on(t.keyHash), unique("verify_api_keys_nonce_uq").on(t.nonce), index("verify_api_keys_owner_idx").on(t.ownerAddress)],
);
