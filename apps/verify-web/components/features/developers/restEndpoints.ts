/** REST 端点表（逐字迁自 v7 开发者页）：[路径, 中文说明, 英文说明] */
export type EndpointRow = readonly [path: string, zh: string, en: string];

export const V1_ROWS: readonly EndpointRow[] = [
  ["GET /v1/assets", "支持资产（链+合约主键、登记版本与哈希、是否可执行）", "Supported assets (chain+contract key, registry version/hash, executionAllowed)"],
  ["GET /v1/policies", "三策略完整定义与哈希（v1.0.0 与 v1.1.0）", "The three policies with definition hashes (v1.0.0 and v1.1.0)"],
  ["GET /v1/products", "商品目录：verify_once / plan / monitor_window / task_bundle，价格与交付定义", "Products: verify_once / plan / monitor_window / task_bundle with price and delivery definition"],
  ["POST /v1/jobs", "创建固定意图任务，立即算出报告 v1；幂等键 clientRequestId", "Create a fixed-intent task; report v1 computed immediately; idempotent by clientRequestId"],
  ["GET /v1/jobs/:id", "任务状态：付款 / 报告版本 / 额度 / 执行与链上回执", "Task state: payment / report versions / entitlement / executions with server-verified receipts"],
  ["GET /v1/jobs/:id/report", "报告 + 证据（收费时未付款 402）", "Report + evidence (402 when paid and unpaid)"],
  ["GET /v1/jobs/:id/bundle · /bill", "证据包（含 bundleHash 与证明签名）· 账单（服务费 / 本金 / gas 分列）", "Evidence bundle (bundleHash + attestation signature) · bill (fees / principal / gas)"],
];

export const V5_ROWS: readonly EndpointRow[] = [
  ["POST /v1/plans · GET /v1/plans/:id", "规划：金额阶梯 × 资金币种 × 三策略对照，≤12 候选，给出推荐与下一步", "Plan: amount ladder × funding currencies × three policies, ≤12 candidates, recommendation and next step"],
  ["POST /v1/plans/:id/jobs", "把某个候选转成核验任务（同一 requestHash 链）", "Turn a candidate into a verification task (same requestHash chain)"],
  ["POST /v1/mandates", "登记已签名的 TradeMandate（一次签名：预算/单步/步数/资产集合/期限/策略哈希）", "Register a signed TradeMandate (one signature: budget, per-step cap, steps, asset set, deadline, policy hashes)"],
  ["GET /v1/mandates/:id", "授权状态、已用预算、步数、评估时间线与变化说明", "Authorization state, spent budget, steps, evaluation timeline and deltas"],
  ["POST /v1/mandates/:id/pause · resume · cancel", "链下暂停 / 继续 / 取消（取消建议同时链上 revokeMandate）", "Off-chain pause / resume / cancel (cancel should be paired with on-chain revokeMandate)"],
  ["POST /v1/mandates/:id/prepare-step", "就绪时返回 MandateStep typed data + 步骤证书 + 路由 calldata；否则返回等待原因", "When READY returns MandateStep typed data + step certificate + router calldata; otherwise the wait reason"],
  ["POST /v1/mandates/:id/steps/:n/submissions", "记录步骤 tx hash；核实器按 MandateStep 事件确认", "Record the step tx hash; the verifier confirms via the MandateStep event"],
  ["GET /v1/mandates/:id/bundle · /bill", "授权计划的证据包与账单", "Evidence bundle and bill of an authorized task"],
  ["POST /v1/simulations · GET /v1/simulations/:id", "模拟：真实数据跑规划与规则，不签证书不执行（免费）", "Simulation: real data through planner and rules, no certificate, no execution (free)"],
  ["GET/PUT /v1/profiles/me · POST/GET /v1/templates", "角色（只影响文案）· 复用模板（只含结构，不含金额/钱包）", "Persona (copy only) · remix templates (structure only, never amounts/wallets)"],
  ["POST /v1/shares · GET /pub/reports[/:shareId]", "战报公开设置 · 公开读取（无需 key，金额可区间化，钱包恒隐藏）", "Share settings · public read (no key; amounts can be ranged; wallet always hidden)"],
  ["POST /a2mcp/plan · POST /a2mcp/monitor · GET /a2mcp/monitor/:id", "第二个 A2MCP 服务「Plan & Monitor」（同一 200 契约）", "Second A2MCP service “Plan & Monitor” (same 200 contract)"],
];

export const V6_ROWS: readonly EndpointRow[] = [
  ["GET /v1/context?tier=agent&assetKey&owner&taskId", "免费档市场上下文（crowsnest 签名导出）：时段、交易日/假日/提前收盘、宏观与联储事件、静默期、曲线形态、漂移判定。每个字段 {value, source, observedAt, fetchedAt, status}；数值 value 是十进制字符串；不在档位的字段整个标 unavailable/not_in_tier 而不省略；provenance.mode 非 live 时不得当实时。永远 200。", "Free-tier market context (signed crowsnest export): session, trading day / holiday / early close, macro & Fed events, blackout, curve shape, drift verdict. Every field is {value, source, observedAt, fetchedAt, status}; numeric values are decimal strings; fields outside the tier are unavailable/not_in_tier, never omitted; provenance.mode other than live must not be treated as live. Always 200."],
  ["GET /v1/events · GET /v1/events/:id/revisions", "事件列表（稳定 id、日期精度、确认/估计/修订、修订号）与修订史；窗口由每个任务自己按条件算", "Event list (stable id, date precision, confirmed/estimated/revised, revision) and revision history; each task computes its own window"],
  ["POST /v1/tasks · GET /v1/tasks/:id · GET /v1/tasks?owner", "从模板 + 条件建任务：返回任务（阻塞项全量、nextCheckAt、执行器三态）、待签 TradeMandate 草案、理由卡草案、资金组分配", "Create a task from a playbook + conditions: task (all blockers, nextCheckAt, executor presence), TradeMandate draft, thesis draft, budget allocation"],
  ["POST /v1/tasks/:id/pause · resume · cancel", "服务侧停止：只阻止后续签发；已取走且未过期的证书仍可能可执行；彻底停止以链上 revokeMandate 确认为准（D-088）", "Service-side stop: blocks new certificates only; a pulled, unexpired certificate may still execute; hard stop = on-chain revokeMandate confirmation (D-088)"],
  ["POST /v1/tasks/:id/authorize · prepare-step · GET explain-wait · POST compare-policies", "提交已签授权；条件前置链评估；等待诊断；同快照对照（SIMULATION）", "Submit the signed mandate; condition-gated step preparation; wait diagnosis; same-snapshot comparison (SIMULATION)"],
  ["POST /v1/mandates/:id/executor/heartbeat", "agent-wallet 执行器心跳（60 s）→ executorPresence=online；不携带任何权限", "Agent-wallet executor heartbeat (60 s) → executorPresence=online; carries no permission"],
  ["GET /v1/event-impacts?owner&horizonHours · POST /v1/theses · /v1/budget-groups · GET /v1/portfolio/:owner · /v1/notify/* · /v1/replays · /v1/rebalance/*", "影响清单、理由卡、资金组、组合与成本覆盖、通知（webhook HMAC / Telegram）、无前视回放、调仓编排", "Impacts, thesis cards, budget groups, portfolio with cost coverage, notifications (HMAC webhooks / Telegram), no-look-ahead replays, rebalance orchestration"],
  ["GET /v1/recaps?owner&date · GET /v1/recaps/:id · POST /v1/recaps/:id/share · GET /pub/recaps/:shareId", "夜班日志：纽约实际收盘后 45 分钟生成；账目与时间线可复算；模拟/回放/真实标识；默认私密，公开可隐藏资产与金额", "Night journal: generated 45 min after the actual NY close; ledger reconciles with the timeline; simulation/replay/live labels; private by default, public view can hide assets and amounts"],
  ["POST /a2mcp/agent-tasks", "第三个 A2MCP 服务「Agent Tasks」草稿：owner 或资产集合 → 事件影响 + 任务草案；审核期价格 0；等 #13803 结果后再提交上架", "Third A2MCP service “Agent Tasks” (draft): owner and/or assets → event impacts + task drafts; price 0 during review; submitted only after #13803 concludes"],
];
