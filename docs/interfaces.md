# Chaconne Verify · 接口冻结（Interfaces）

> 冻结日：2026-09-20。唯一类型事实来源：`packages/core/src/verify/contracts.ts`（导入路径 `@chaconne/core/verify`）。
> 改动任何冻结项 = 新增 CV-D 决策条目 + 通知全部 lane。本文只做导航与约定说明，不复制类型定义。

## 1. 命名与单位约定

| 项 | 约定 |
|---|---|
| assetKey | `eip155:<chainId>:<小写地址>`；symbol 仅展示，不用于查库、缓存、签名匹配 |
| 链上金额 | 十进制整数字符串（最小单位）；禁止 JS number |
| 小数价格 | 十进制字符串（`"250.12"`），定点计算见 `amounts.ts` |
| bps | 整数；100 bps = 1%；发给 OKX 的 `slippagePercent` 用 `bpsToPercentString` 显式换算 |
| 链下时间 | ISO-8601 UTC（必须 `Z` 结尾），`time.ts` 是唯一换算入口（Pyth 秒 / OKX 毫秒） |
| 链上时间 | Unix 秒（uint64） |
| 哈希 | `0x` + 64 hex，keccak256 |
| 价格冲击 | `priceImpactPercentRaw` 原样保留；`adverseImpactBps` 由 `parseAdverseImpactBps` 解析，**null ≠ 0**；符号约定：负 = 不利（Lane B 探针若证实相反须改此函数并升黄金样本） |

## 2. 冻结的类型（contracts.ts）

- 资产：`AssetRef`、`RegistryEntry`、`AssetRegistry`、`TokenForm`
- 时间：`EvidenceTime`（requestedAt / receivedAt / sourcePublishedAt / sourceTimeKind）、`BlockContext`
- 任务：`CreateVerifyJob`（对外）、`NormalizedJob`（内部，参数已展开）
- 策略：`PolicyId`（STRICT_LIVE / REFERENCE_CONTEXT / QUOTE_ONLY）、`PolicyDefinition`、`EffectivePolicyParams`、`EffectivePolicy`
- 证据：`EvidenceRecord` + 7 种 payload（`okx_quote` / `okx_rwa_token` / `pyth_reference` / `ref_close` / `stablecoin_usd` / `token_meta` / `registry_lookup`）、`EvidenceMode`（LIVE / REPLAY / FIXTURE / FORK / SIMULATION）
- 报告：`VerifyReport`、`Reason`、`ReasonCode`（23 个）、`Verdict`、`ComparisonStatus`、`ReportReference`、`NormalizedQuote`
- 状态机：`OrderState`、`ExecutionState`
- 链上：`TradeIntent`、`VerificationCertificate`、`Eip712Domain`

## 3. 哈希规范

| 哈希 | 计算 | 位置 |
|---|---|---|
| `policyDefinitionHash` | keccak256(canonical(PolicyDefinition)) | `policy.ts` |
| `effectivePolicyHash` | keccak256(canonical({policyDefinitionHash, params})) | `policy.ts` |
| `registryHash` | keccak256(canonical({version, chainId, entries 按 assetKey 排序、仅规则相关字段})) | `registry.ts` |
| `requestHash` | keccak256(canonical(NormalizedJob 全字段 + `request-1`)) | `report.ts` |
| `evidenceHash` | keccak256(canonical({`evidence-1`, items 按 evidenceId 排序})) ——不含自身、intentDigest、签名、成交 hash | `report.ts` |
| `reportHash` | keccak256(canonical(VerifyReport)) | `report.ts` |
| `intentDigest` / 证书摘要 | EIP-712，domain `ChaconneVerifyGuard` v1；与 viem 互检通过 | `eip712.ts` |

canonical 规则（`canon-1`）：键按 UTF-16 升序、丢 undefined、留 null、number 仅安全整数、数组保序。

## 4. 策略与阈值（v1.0.0，本项目可调配置，非 OKX 保证）

| 参数 | 值 |
|---|---|
| quoteMaxAgeSeconds | 30 |
| liveReferenceMaxAgeSeconds | 90 |
| closeMaxSessionsSinceClose | 0（收盘必须是最近一个已完成交易日） |
| closeCrossVerifyToleranceBps | 50 |
| certificateTtlSeconds | 60 |
| futureSkewToleranceSeconds | 5 |
| requireImpactKnown | true（三策略均是） |
| maxSlippageBps 范围 | 1–300，必填 |
| maxPriceImpactBps 范围 | 1–1000，默认 100 |
| maxReferenceDeviationBps 范围 | 1–2000，默认 300（QUOTE_ONLY 不适用） |

verdict：HARD 阻断码任一 → `rejected`；其它 block（信息不足）→ `limited`；否则 `eligible`。`executionEligible` 仅在 `eligible` 为 true。

REFERENCE_CONTEXT 合格收盘 = `official` 来源，或 `pyth`(最后常规观测) + OKX RWA 休市 `stockPrice`（当前与该证据接收时刻均处 CLOSED/HOLIDAY）价差 ≤ 50 bps → `close_cross_verified`。`pyth_provisional` 单独出现不合格；常规时段内 OKX stockPrice 是实时价，不作收盘交叉源。

## 5. HTTP 路径（Lane C 实现；此处冻结路径与状态码）

| 方法 路径 | 用途 | 未付款 |
|---|---|---|
| `GET /v1/assets` | 支持资产（registry 版本 + hash） | 200 |
| `GET /v1/policies` | 三策略完整定义 + 哈希 | 200 |
| `POST /v1/jobs` | 创建任务（幂等键 `(callerId, clientRequestId)`；同键异体 409） | 201 / 200(重放) |
| `GET /v1/jobs/:id` | 任务状态（付款/报告/额度/执行） | 200 |
| `GET /v1/jobs/:id/report` | 付费报告 | **402 + PAYMENT-REQUIRED**（价格 0 时 200） |
| `POST /v1/jobs/:id/prepare-execution` | body `{refreshKey}`（幂等键）；消耗再核验额度 → 新报告版本 + TradeIntent typed data + 证书签名 + Guard 调用参数 | 402 未付 / 409 额度耗尽 / 422 不合格(REJECTED，仍耗额) / 503 未配 Guard 或签名身份 |
| `POST /v1/jobs/:id/submissions` | body `{attemptId, txHash}`；记录 tx hash，状态 SUBMITTED；服务端核实器按 RPC 回执推进：REORG_PENDING（确认数不足）→ CONFIRMED（回执成功 + Guard 事件 intentDigest 一致 + ≥6 确认）/ REVERTED / UNKNOWN（回执缺失 >10 min、事件缺失、摘要不符；带 reason）；`executions[].receipt` 与 `execution.receipt` 返回回执摘要 | 202；同尝试换 hash 409 |

| `GET /pub/market/xlayer` | **公开行情**（主站 chaconne.xyz 的 poller 每 30 s 拉）：X Layer 允许执行的股票代币对 USDG 的 OKX 聚合器三档买入报价（100 / 1k / 10k USDG）；无鉴权无 x402；服务端缓存 30 s + single-flight；上游失败回上一份 `stale:true`；从未成功 503 `{error:"unavailable"}`。契约 §10.16 | 200 / 503 |
| `POST/GET /a2mcp/verify` | OKX AI A2MCP 单端点（平台调用，不带 API key；限频按 IP）。**CV-D10（2026-09-21）：OKX 调用客户端只接受 200/402，其它状态判 `endpoint_unreachable`** → 空参/参数错误回 **200** `{ok:false,status:"input_required",missingParams,problems,resolved,schema,example}`；免费成功 200 `{ok:true,status:"delivered",summary,resolvedInput,…报告}`；收费 402；同参幂等；凭证不得跨任务复用。输入宽容：资产可用符号/代码/0x 地址，金额可用人类单位 `amount`，常见别名，policyId 缺省 REFERENCE_CONTEXT、maxSlippageBps 缺省 50（`src/http/a2mcpInput.ts`）。`/a2mcp/plan`、`/a2mcp/monitor` 同约定 | 200 / 402 |

鉴权：`x-api-key` 或 `Authorization: Bearer`，映射 callerId；他人任务一律 404。付款响应：`202 payment_unknown` 表示结算结果未知（只对账、勿重付）。Guard 调用签名：`execute(intent, intentSignature, cert, certSignature, routerCalldata)`（`apps/verify-service/src/execution/guardAbi.ts`）。

## 6. MCP 工具名（Lane F）

`list_supported_assets`、`get_verification_policy`、`prepare_verification`、`purchase_verification`、`get_verification`、`prepare_guard_trade`、`get_execution_status`。

## 7. 数据库表（Lane C 出迁移；列见 v1 技术设计 §8）

`verify_jobs`、`verify_orders`、`verify_payment_attempts`、`verify_evidence`、`verify_reports`、`verify_entitlements`、`verify_execution_attempts`、`verify_payment_events`、`verify_refunds`。退款工单只经运营者 CLI（`apps/verify-service/scripts/ops.ts`）人工推进，无 HTTP 入口。

## 8. 共享 fixture

`packages/core/src/verify/fixtures.ts`（场景构造器，地址全为占位值）+ `__fixtures__/*.json`（黄金样本：STRICT_LIVE 合格 / 休市拒绝 / REFERENCE_CONTEXT 交叉核验、策略哈希）。黄金样本变化必须 `UPDATE_FIXTURES=1` 重生成并记 CV-D。

## 9. 冻结后决策（CV-D）

| ID | 日期 | 决定 | 影响 |
|---|---|---|---|
| CV-D01 | 2026-09-20 | 证据 kind `pyth_reference` 泛化为"实时参考 tick"，`provider` 字段标明来源（`pyth-hermes` / `finnhub`），`feedId` 形如 `finnhub:AAPL`。类型名不改（避免黄金样本升版）。 | 报告 `reference.sourceId` 已含 provider；规则不变 |
| CV-D02 | 2026-09-20 | Pyth equity 授权失效（Hermes 公开 401 / 生产 key 403，同 FIX-085）→ 首版实时与收盘参考源改为 **Finnhub** `quote`：`t` 为最新成交源时间；`t` ≥ 当日常规收盘 → `ref_close(official, tradingDate=当日)`；盘中用 `pc` 记上一已完成交易日。OKX RWA 列表在 X Layer 的 `stockPrice` 为空，`close_cross_verified` 路径保留但当前不触发。 | `apps/verify-service/src/adapters/finnhub.ts`、`evidence/live.ts`；REPLAY 测试 |
| CV-D03 | 2026-09-20 | `priceImpactPercent` 符号按 OKX 文档公式 (收到−支付)/支付：负=不利。探针 $5 报价为 0/0.01/0.03（正），解析为 0 不利 bps。 | `amounts.ts` 保持不变 |
| CV-D04 | 2026-09-20 | 已核验路由选择器：`0xf2c42696 dagSwapByOrderId`、`0x0c307f76 dagSwapTo(receiver)`（指定 swapReceiverAddress=Guard 时 OKX 返回后者；服务侧校验 receiver 必须 = Guard）。服务侧解码校验 from/to/amount/deadline，Guard 侧选择器白名单 + 余额差双层。其它选择器 → ROUTE_UNSUPPORTED。anvil 分叉主网真实执行通过（G-01 FORK）。 | `adapters/okx/calldata.ts`、Guard `setSelector`、`scripts/forkExecute.ts` |
| CV-D05 | 2026-09-20 | rebasing 输出代币（xStocks EVM）转账舍入可在 Guard 留 ≤ 数 wei 粉尘：不变量"Guard 余额 = 捐赠额"对 rebasing 代币放宽为"≤ 1e6 wei 粉尘"；粉尘由 owner `rescue`，不归任何用户。 | `forkExecute.ts` 断言；Guard 不改 |

## 10. v2 增补（升级执行计划 v5 §3，2026-09-21 冻结；I2 + A2）

唯一事实来源仍是 `packages/core/src/verify/contracts.ts`（末尾「v2 增补」段，只追加）与 `eip712.ts`（末尾 PlanGuard 段）。本节只冻结约定与命名；字段以代码为准。

### 10.1 规划（W1）
- 类型：`PlanGoal` / `PlanLeg` / `PlanCandidate` / `PlanReport` / `PlanNextStep` / `PlanSide`；常量 `DEFAULT_LADDER_BPS = [10000,7500,5000,2500,1000]`、`PLAN_MAX_CANDIDATES = 12`、`PLAN_MAX_QUOTES_PER_LEG = 8`。
- 哈希：`goalHash = keccak256(canonical(PlanGoal))`；`evidenceHash` 规则同报告（证据集合顺序无关）；`planHash = keccak256(canonical(PlanReport 去掉 planHash))`。
- 规则：候选由确定性程序生成（同证据集合 → 同 planHash）；`recommended` 只能是 `chosenPolicyVerdict === "eligible"` 且 `completionBps` 最大者；并列时 ① legIndex 小者 ② **同腿同完成度按 `expectedOutRaw` 大者**（同一输出代币可直接比较，I2 2026-09-21 LIVE 发现：多资金币种并列时原按 ID 字典序会推荐到手更少的那个）③ candidateId 字典序；`USER_MUST_RELAX_LIMIT` 永远不自动执行；缩小金额不算完成原目标（`completionBps < 10000` → `ACCEPT_PARTIAL`）。
- 引擎位置：`packages/core/src/verify/plan/`（`buildLadder`、`scoreCandidate`、`chooseRecommended`、`explainNextStep`），纯函数，输入是已取得的 quote 证据集合。

### 10.2 授权计划与步骤（W2，PlanGuard v2）
- EIP-712 domain：`{ name: "ChaconneVerifyPlanGuard", version: "1", chainId, verifyingContract: PlanGuard }`（`makePlanGuardDomain`）。`Eip712Domain.name` 放宽为联合类型（CV-D07）。
- 结构与字段顺序（= 合约 struct，部署后冻结）：`TradeMandate(owner,recipient,inputToken,outputSetHash,budgetCap,perStepCap,maxSteps:uint32,policyDefinitionHash,effectivePolicyHash,registryHash,validFrom:uint64,deadline:uint64,nonce)`；`MandateStep(mandateDigest,stepIndex:uint32,outputToken,amountIn,minAmountOut,router,spender,calldataHash,evidenceHash,deadline:uint64)`；`StepCertificate(stepDigest,evidenceHash,policyDefinitionHash,effectivePolicyHash,issuedAt,validUntil,signerEpoch)`。
- `outputSetHash = keccak256(abi.encodePacked(sorted unique outputTokens))`（小写字典序；合约侧用 sorted-list 验证：调用方传入 sorted 数组，合约重算哈希并线性查找 outputToken）。
- 摘要：`mandateDigest` / `stepDigest` / `stepCertificateDigest`（`typedDataDigest` 同 v1）。黄金值：`packages/core/test/verify.eip712v2.test.ts`（与 viem 互检）；Foundry 侧互检由 Lane D2 追加。
- 链下状态：`MANDATE_STATES = DRAFT|ACTIVE|PAUSED|CANCELLED|REVOKED|COMPLETED|EXPIRED`；步骤 `MANDATE_STEP_STATES = PREPARED|EXPIRED|SUBMITTED|REORG_PENDING|CONFIRMED|REVERTED|UNKNOWN`；评估 `MandateEvalStatus = READY|WAIT|BLOCKED|DONE`；`DeltaExplanation`（`explainDelta(prev,next)` 纯函数）。
- 合约不变量与规则见 v5 §4 W2；**执行者无门槛**、服务端不做 relayer（D-081）。rebasing 输入容差 `inputShortfallTolerance[token]`（默认 0；登记的 rebasing 股票代币 1e6 wei）。
- 步骤证书有效期（W7-2，PlanGuard 与 v1 同规则）：`validUntil = min(issuedAt + certificateTtlSeconds, quote.receivedAt + quoteMaxAgeSeconds, [STRICT_LIVE] reference.sourcePublishedAt + liveReferenceMaxAgeSeconds)`。

**D2 定稿（2026-09-21）**：
- 合约 `ChaconneVerifyPlanGuard`（继承 `EIP712` + `GuardCore`）。Solidity 中步骤结构名为 `Step`（事件名 `MandateStep` 已冻结，同名冲突），ABI tuple 无名，TS 侧仍叫 `MandateStep`。
- `executeStep(TradeMandate m, bytes mSig, address[] outputSet, Step s, StepCertificate c, bytes cSig, bytes routerCalldata) payable returns (spent, received, refunded)`；`msg.value` 必须为 0。`outputSet` 必须严格升序（按 uint160）、非空，且 `keccak256(concat20(outputSet)) == m.outputSetHash`（**紧凑 20 字节拼接**，不是 `abi.encodePacked(address[])` 的 32 字节填充；与 core `outputSetHash` 一致）。
- 检查顺序（影响错误码）：mandate 静态/时间/签名/撤销/nonce → 步序 `StepOutOfOrder(expected, given)` → `StepsExhausted` → `PerStepCapExceeded` → `BudgetExceeded` → `StepExpired` → `OutputNotInSet` → 路由/代币/选择器/calldata 白名单（GuardCore 错误）→ `CertificateStepMismatch` → `CertificateBindingMismatch` → `CertificateOutlivesStep` → 证书窗口/签名/epoch。
- nonce：`mandateNonceUsed[owner][nonce]` 在 step 0 绑定（`mandateOfNonce` 记 digest）；`cancelMandateNonce` 只能阻止未开始的授权；`revokeMandate(TradeMandate m)` 仅 `m.owner`。
- rebasing 输入：`setInputShortfallTolerance(token, wei)`；实际拉入 ∈ [amountIn − tol, amountIn]，按实际值记账；卖出时路由请求量应为 `amountIn − tol`（否则路由 transferFrom 会超额失败）。
- 其它接口：`mandateDigest(m)`、`stepDigest(s)`、`certificateDigest(c)`、`computeOutputSetHash(set)`、`mandateState(digest) → (spent, steps, revoked)`、`domainSeparator()`；事件 `MandateStep(owner, mandateDigest, stepIndex, outputToken, amountIn, spent, received, refunded, evidenceHash, executor)`、`MandateRevoked`、`MandateNonceCancelled`。
- gas（分叉实测）：买入步 ≈ 55 万，卖出步 ≈ 63.5 万；建议执行者 estimateGas ×1.3。

### 10.3 证据包与账单（W3/W4）
- `EvidenceBundle`（schemaVersion "1"，kind job|mandate）：`bundleHash = keccak256(canonical(bundle 去掉 bundleHash/bundleSignature))`；`bundleSignature` = 证明身份对 `bundleHash` 的 **EIP-191 personal_sign**（`signMessage({ raw: bundleHash })`），不引入第二把私钥。
- `Bill = { serviceFees[], principal[], gas[], selfPayment }`；`Product`（`ProductSku = verify_once|plan|monitor_window|task_bundle`）。
- 验证器检查清单（离线）：canonical 哈希重算（evidence/report/plan/bundle）→ 证书/授权/意图签名与 signer/epoch → intentDigest/mandateDigest/stepDigest 重算 → 规则重算（`evaluate` 结果与报告一致）；（联网可选）回执解码与摘要比对、Guard 当前 signer/epoch。

### 10.4 HTTP 新增（verify-service，Lane C2）
| 方法 路径 | 用途 | 付费/状态码 |
|---|---|---|
| `POST /v1/plans`、`GET /v1/plans/:id` | 规划任务（幂等键 `(callerId, clientRequestId)`；同键异体 409） | SKU `plan`；201/200/402 |
| `POST /v1/plans/:id/jobs` | 把 `recommended`（或指定 candidateId）转成 job（同 requestHash 链） | 201 |
| `POST /v1/mandates` | 提交已签名 TradeMandate（typedData + signature）+ planId/jobId；服务校验签名、registry、策略哈希 | SKU `task_bundle` 或 `monitor_window`；201/402/422 |
| `GET /v1/mandates/:id` | 状态、预算已用/剩余、步数、最近评估与 delta | 200 |
| `POST /v1/mandates/:id/pause` / `resume` / `cancel` | 链下状态；cancel 建议同时链上 `revokeMandate` | 200 / 409 |
| `POST /v1/mandates/:id/prepare-step` | READY → MandateStep typedData + StepCertificate + 签名 + routerCalldata；否则 `{status: WAIT|BLOCKED|DONE, reasons, delta}` | 200 / 409 |
| `POST /v1/mandates/:id/steps/:n/submissions` | 记录 tx hash；核实器复用 `execution/receipts.ts`，事件 `MandateStep` | 202 / 409 |
| `GET /v1/jobs/:id/bundle`、`GET /v1/mandates/:id/bundle` | 证据包 | 200（含在原购买内） |
| `GET /v1/jobs/:id/bill`、`GET /v1/mandates/:id/bill` | 账单 | 200 |
| `GET /v1/products` | 商品目录 | 200 |
| `POST /v1/simulations`、`GET /v1/simulations/:id` | 模拟任务：LIVE 证据，跑规划+规则，不签证书不执行，verdict 照常 | 免费 201 |
| `GET/PUT /v1/profiles/me` | 角色 | 200 |
| `POST /v1/templates`、`GET /v1/templates/:id` | 翻创模板（不含金额/钱包/旧报价/旧授权） | 201/200 |
| `POST /v1/shares`、`GET /pub/reports/:shareId` | 战报公开设置与公开读取（隐私过滤） | 201/200/404 |
| `POST /a2mcp/plan`、`POST /a2mcp/monitor`、`GET /a2mcp/monitor/:id` | 第二个 A2MCP 服务（`input_required` 形态；免费先行，D-083） | 400/200/402 |

### 10.5 MCP 工具新增（Lane F2）
`plan_trade`、`create_simulation`、`get_products`、`prepare_mandate`（返回待签 typedData）、`register_mandate`、`get_mandate`、`pause_mandate`/`resume_mandate`/`cancel_mandate`、`execute_next_step`（仅 agent-wallet 模式）、`get_evidence_bundle`、`verify_evidence_bundle`（本地离线）、`create_share_card`。
agent-wallet 模式（CV-D08）：`AGENT_WALLET_PRIVATE_KEY` 是用户自己的 Agent 钱包（客户端侧，只能出现在 verify-mcp 的 `.env`）；必须同时配 `AGENT_WALLET_MAX_SPEND_USD`、`AGENT_WALLET_CHAIN_IDS`，超限拒绝；verify-mcp 的私钥护栏改为"拒绝除 `AGENT_WALLET_PRIVATE_KEY` 之外的任何 `*PRIVATE_KEY*`"。verify-service 护栏不变（只允许 `ATTESTATION_PRIVATE_KEY`）。

### 10.6 数据库（迁移 0017，Lane C2）
`verify_plans`（id, caller_id, client_request_id, goal_json, goal_hash, plan_json, plan_hash, evidence_hash, registry_hash, policy hashes, evaluated_at, created_at；unique (caller_id, client_request_id)）、`verify_mandates`（id, caller_id, plan_id?, job_id?, owner, mandate_json, mandate_digest unique, signature, state, budget_cap, spent, steps_done, max_steps, valid_from, deadline, created_at, updated_at）、`verify_mandate_evaluations`（id, mandate_id, evaluated_at, status, report_version?, reasons_json, delta_json, prepared_step_index）、`verify_mandate_steps`（id, mandate_id, step_index, state, step_json, step_digest, certificate_json, certificate_signature, valid_until, tx_hash, receipt_json, created_at, updated_at；unique (mandate_id, step_index)）、`verify_simulations`、`verify_profiles`（owner_address pk）、`verify_templates`、`verify_shares`（share_id pk, kind, ref_id, privacy_json, public bool）。金额一律十进制字符串。

### 10.7 时点与单位（W5，CV-D06）
- `ReferenceKind` 新增 `close_last_tick`；`RefCloseEvidence.closeSource` 新增 `last_tick`，可选 `confirmation {method: candle|next_day_pc}`；`OkxRwaTokenEvidence.ratio?`；原因码新增 `UNIT_CHANGED`（warning，non-HARD）与 `CLOSE_UNCONFIRMED`（info）。
- 分类：Finnhub `quote.t` == 当日 16:00:00 ET 整且当日已收盘 → `ref_close(closeSource=last_tick)` → 报告 kind `close_last_tick`；`official_close` 只在 candle（若免费档可用，先探针）或次日 `pc` 与已记录 last_tick 一致时；`t < 16:00` 且已收盘 → `last_regular_observation`。
- 策略 **v1.1.0**：`PolicyDefinition.acceptedCloseKinds?`（v1.0.0 对象不含此字段，哈希不变，v1 Guard 白名单不受影响）；REFERENCE_CONTEXT v1.1.0 = `["official_close","close_cross_verified","close_last_tick"]`，报告与页面必须显示"来自 16:00 最后成交，未经次日确认"；PlanGuard 白名单启用 v1.1.0 三策略哈希。黄金样本 v2 由 A2 重生成（v1 样本保留）。
- 链上乘数读取函数名**不得猜**：B2 从 Sourcify/OKLink 已验证源码查到后写 `the address-approval log (internal)` + design log。

### 10.8 冻结后决策（v2）
| ID | 日期 | 决定 |
|---|---|---|
| CV-D06 | 2026-09-21 | 收盘分类修正（见 10.7）；策略升 v1.1.0 |
| CV-D07 | 2026-09-21 | `Eip712Domain.name` 放宽为 `"ChaconneVerifyGuard" \| "ChaconneVerifyPlanGuard"`；v1 编码与哈希不变 |
| CV-D08 | 2026-09-21 | verify-mcp agent-wallet 模式（见 10.5）；服务端零 relayer（D-081） |
| CV-D10 | 2026-09-21 | A2MCP 传输约定：缺参数/非法参数回 HTTP 200 + `status:"input_required"`（ASP #13803 首次审核被驳回的根因：OKX 客户端把 400 判为端点不可达）；策略版本缺省改为最新 1.1.0（a2mcp / plans / web / mcp / sdk），v1 Guard 白名单已补 v1.1.0 三策略 + 登记表 v1.1.0 |
| CV-D09 | 2026-09-21 | `CreateVerifyJob.side?` / `NormalizedJob.side?`（缺省 buy；requestHash 仅 sell 时纳入 side，buy 哈希与 v1 一致）；`EvidenceBundle` 增 `job`/`goal?`/`registryVersion`（见 10.9，A2 定稿，I2 批准） |

### 10.9 A2 定稿（2026-09-21，内核实现细节）
- **引擎入口**（`@chaconne/core/verify`）：`buildLadder(goal, registry, {maxCandidates?, maxQuotesPerLeg?}) → PlanCandidateSpec[]`（`{candidateId, legIndex, inputAssetKey, outputAssetKey, amountInRaw, ladderBps, weightBps}`，`candidateId = cand_<legIndex>_<ladderBps>_<keccak(inputAssetKey)[0:8]>`）；`PlanEvidenceSet = { shared: EvidenceRecord[]; quotes: Record<candidateId, EvidenceRecord | null> }`（null = 报价失败）；`buildPlanReport({planId, goal, registry, specs?, evidence, evaluatedAt, calendar?}) → PlanReport`；`candidateToCreateJob(goal, candidate, clientRequestId?) → CreateVerifyJob`；`bisectMaxAmount({lo, hi, capBps, probe, maxProbes?})`（可选二分，探测数 ≤ 8）。`goalHash = keccak(canonical({version:"goal-1", ...goal, ladderBps: goal.ladderBps ?? null, maxReferenceDeviationBps: ?? null}))`。
- **nextStep 规则**：eligible∧100%→READY；eligible∧<100%→ACCEPT_PARTIAL；PRICE_IMPACT/REFERENCE_DEVIATION 超限→USER_MUST_RELAX_LIMIT（同币种另有可行阶梯时亦然；本币种全不可行而他币种可行→SWITCH_INPUT）；ASSET/ROUTE/QUOTE/REGISTRY/MIN_OUT 阻断→他币种可行则 SWITCH_INPUT 否则 PROVIDE_DATA；MARKET_OUTSIDE_REGULAR/REFERENCE_STALE/QUOTE_TOO_OLD/CLOSE_SESSION_MISMATCH/REFERENCE_MISSING→WAIT_CONDITION；SOURCE_TIME_MISSING/USD_CONVERSION_UNKNOWN/TOKEN_UNIT_UNVERIFIED/PRICE_IMPACT_UNKNOWN/REFERENCE_PROVISIONAL/SOURCE_CONFLICT→PROVIDE_DATA。
- **卖出方向（CV-D09，additive）**：`CreateVerifyJob.side?` / `NormalizedJob.side?`（缺省 buy；requestHash 仅在 sell 时纳入 `side`，buy 哈希与 v1 完全一致）；`evaluateVerification` 按 side 对调登记角色（input 须 stock_output、output 须 stable_input），代币单位/参考价看股票腿，稳定币 USD 看稳定币腿，可执行单价 = 稳定币到账 USD / 股数；报价证据方向 from=股票 to=稳定币。PlanGoal 语义对称：`budget.inputAssetKeys` = 付出的资产（卖出时为股票代币），`legs[].outputAssetKey` = 收到的资产。
- **证据包**：`EvidenceBundle` 增 `job: NormalizedJob | null`、`goal?`、`registryVersion`（规则重算与登记表哈希重算需要）；`verifyBundleOffline(bundle, {verifyTypedData?, verifyMessage?, expectedSigner?})` 返回 `BundleCheck[]`（id/ok/detail），签名验证由调用方注入 viem（core 零依赖）；检查 id 前缀：`bundle_*`、`evidence_raw_hash`、`registry_hash`、`policy_definition_hash`、`effective_policy_hash`、`report_v<n>_{evidence_hash,hash,policy,rules}`、`plan_<id>_{hash,evidence_present}`、`cert_<i>_{intent_digest|step_digest,evidence_hash,digest,signature}`、`intent_<i>_signature`、`mandate_digest`、`mandate_step_<n>_{digest,cert_signature}`、`mandate_signature`。`bundleSignature` = signMessage({raw: bundleHash})。
- **收盘分类**：`classifyLastTrade({tUnixSec, nowIso}) → {closeSource: "last_tick"|"pyth", tradingDate, sourcePublishedAt, note} | null`（盘中/盘后 tick → null）；`confirmLastTick(recorded, {method, closeUsd, confirmedAt})` 一致才升级 official。策略 v1.1.0 哈希见 `__fixtures__/v2/policy.hashes.v1_1_0.json`；`latestPolicy(id)`、`LATEST_POLICY_VERSION = "1.1.0"`。
- **delta**：`explainDelta(prev | null, next) → DeltaExplanation`（info 级原因不计入增减；`unitChange` 取 UNIT_CHANGED.detail.to）。

### 10.11 B2 定稿（2026-09-21，数据侧实现细节）
- `LiveEvidenceProvider.quoteLadder(legs: LadderLeg[], registry, nowIso, opts?) → LadderResult { side, quotes[], evidence[], quoteCalls }`：每个金额一条 `okx_quote`（endpoint `aggregator/quote#ladder`，指纹 `chain:from:to:amount`）；每腿 > `PLAN_MAX_QUOTES_PER_LEG`(8) 的金额标 `skipped_cap` 不调上游；共享证据（stablecoin_usd / token_meta / okx_rwa_token / 参考价）每资产一条；默认串行（OKX 2 并发即 50011），`50011` 退避重试计入 `quoteCalls`；一个规划不得混合买卖。
- 卖出（CV-D09）：`collect` 按登记角色推导 side 并要求 `job.side` 一致；`stablecoin_usd` 取 `toToken.tokenUnitPrice`（method `okx_quote_to_token_unit_price`）；卖出时对稳定币也出 `token_meta`；OKX 卖出 swap 返回 `dagSwapTo`，解码器无需改动（receiver=Guard 规则同）。
- 乘数：`token_meta.multiplier` = 链上 `getCurrentMultiplier()`（18 位小数串，parserVersion `erc20-meta/2`，仅 xstocks+rebasing 条目）；`okx_rwa_token.ratio` = 列表 `tokenToAssetRatio`（parserVersion `okx-rwa/2`）；一致性判断 `multiplierMatchesRatio(onchain, ratio, toleranceBps=1)`（ratio 只有 6 位小数）。
- 收盘分类：`live.ts` 调 core `classifyLastTrade` / `confirmLastTick`；`closeClassification: "v1"` 保留旧规则仅作回归对照；`priorLastTick(underlyingId, tradingDate)` 由 C2 接库；`useCandle` 默认 false（免费档 403）。**已知缺口**：半日市 13:00:00 ET 最后成交不被 core 识别为 last_tick（只认 16:00），报 A2。
- 登记表：`registry.xlayer.v1.1.json`（`executionSides` additive；hash `0x8ea0…799a`）；`registry.xlayer.json` 仍为 v1.0.0 供 v1 Guard/verify-service 现网使用；切换由 C2 以 `REGISTRY_FILE` 指定。


### 10.12 F2 定稿（2026-09-21，MCP / SDK / agent-wallet 实现细节）
- **工具总数 20**（v1 7 + v2 13）。`execute_next_step` 与 `register_mandate(signLocally)` 是仅有的两个会动用 agent-wallet 的工具；其余不签名不付款。
- **agent-wallet 启用条件**：`AGENT_WALLET_PRIVATE_KEY` + `AGENT_WALLET_MAX_SPEND_USD` + `AGENT_WALLET_CHAIN_IDS` 三者齐备（部分配置 → 进程拒启）；额度按 6 位小数的稳定币挑战金额累计，超限拒付并原样返回 402；`VERIFY_CALLER` 缺省取钱包地址。
- **x402 自动付款**（`@chaconne/verify-sdk` `createX402Payer`）：只接受 `AGENT_WALLET_CHAIN_IDS` 对应的 `eip155:<id>` 挑战；EIP-3009 授权由官方 `@okxweb3/x402-core` client + `@okxweb3/x402-evm` `ExactEvmScheme` 生成；重试一次。
- **execute_next_step 本地核对**（发送前，任一不过即拒绝，不广播）：`step.mandateDigest == mandateDigest(本地 mandate)`、`expectedStepIndex`（可选）、`amountIn ≤ perStepCap`、`minAmountOut > 0`、证书与步骤未过期、`outputSetHash(outputSet) == mandate.outputSetHash` 且 `step.outputToken ∈ outputSet`、`certificate.stepDigest == stepDigest(step)`、chainId 在白名单；然后 `estimateGas`（失败 = 会 revert，不发）×1.3 发送，再 `POST …/steps/:n/submissions`。
- **prepare-step 响应字段假定**（C2 请对齐或 I2 集成时改 `toolsV2.ts` 一处）：`{ status, stepIndex, typedData{message=MandateStep}, step, stepDigest, certificate, certificateSignature, routerCalldata, outputSet?, planGuard?, validUntil, reasons?, delta? }`；`planGuard` 缺省取 mandate typedData 的 `verifyingContract`。
- **其它响应字段假定**：`POST /v1/plans` → `{ planId, plan: PlanReport }`；`POST /v1/mandates` → `{ mandateId, state, spent, stepsDone, maxSteps }`；`POST …/submissions` → `{ stepIndex, state, txHash }`；`POST /v1/simulations` → `{ simulationId, verdict, mode:"SIMULATION" }`；`POST /v1/shares` body `{ kind, refId, public, privacy:{amounts, wallet:"hidden"}, title? }` → `{ shareId, url, public }`。
- **证据包验证**：MCP `verify_evidence_bundle`、CLI `verify-bundle`、网页 `/verify-bundle` 共用 core `verifyBundleOffline`（注入 viem `verifyTypedData` / `verifyMessage`）；联网增项 `receipt_<attemptId>`（GuardedExecution / MandateStep 事件与 `receiptSummary.event` 比对）。检查 id 前缀即失败层：`bundle_ / evidence_ / registry_ / policy_ / report_ / plan_ / cert_ / intent_ / mandate_ / receipt_`。
- **PlanGuard ABI**：`packages/verify-mcp/src/planGuardAbi.ts` = D2 编译产物 `abi/ChaconneVerifyPlanGuard.json` 的子集（执行者所需函数/事件 + 全部自定义错误），`test/planGuardAbi.test.ts` 逐项比对防漂移。
- **执行者规则（I2 定，`execute_next_step` 默认发送器实现）**：`outputSet` 按 uint160 严格升序去重（`normalizeOutputSet`，= core `outputSetHash` 与合约 `computeOutputSetHash`）；发送前读 `mandateState(digest)`，`steps ≠ stepIndex` 或 `revoked` 即拒绝；输入代币由合约从 `m.owner` 拉款——agent 钱包 = owner 时先精确 `approve(PlanGuard, amountIn)`（已相等则跳过），第三方执行者只校验 owner 现有授权 ≥ amountIn 否则拒绝；`estimateGas × 1.3`（估算失败 = 会 revert，不广播）；等回执 ≤120 s 解码 `MandateStep` 事件并读回授权（应为 0），超时则交服务端核实器。
- **SDK**：`createClient({ baseUrl, apiKey?, caller?, x402Signer?, x402Networks?, onBeforePayment?, onPayment?, fetchImpl? })`；方法：`assets / policies / products / healthz / jobs.{create,get,report,prepareExecution,submit,bundle,bill} / plans.{create,get,toJob} / mandates.{create,get,pause,resume,cancel,prepareStep,submitStep,bundle,bill} / simulations.{create,get} / profiles.{me,update} / templates.{create,get} / shares.{create,getPublic} / a2mcp.{verify,plan}`。
### 10.13 E2 定稿（2026-09-21，入口实现与对 C2 的接口假设）

页面：`/plan`（三问式表单 → 候选表，含三策略对照列与 nextStep）、`/tasks/[id]`（授权任务进度/时间线/暂停继续取消/链上撤销/我来执行这一步/每步回执/账单/分享）、`/verify-bundle`（纯客户端验证器 + 篡改实验 + 可选联网回执比对）、`/play`（角色 + 三道现成题 → 模拟战报）、`/r/[shareId]`（公开战报 + `opengraph-image`）、`/live`（自愿公开战报列表）、`/replay/[assetKey]`（事件前后回放，静态 REPLAY 样本）、`/new?template=` 与 `/plan?template=`（翻创预填，只带结构）。

**所有 v2 接口访问集中在 `apps/verify-web/lib/api-v2.ts`（单点，集成时只改这一处）。** E2 对 C2 的响应形态假设如下（与实现不一致时以 C2 为准，改 api-v2.ts）：

| 端点 | E2 假设的关键字段 |
|---|---|
| `POST/GET /v1/plans[/:id]` | `PlanView { planId, clientRequestId, goal: PlanGoal, goalHash, report: PlanReport \| null, evidenceMode, order?, createdAt }`；创建请求体 = `PlanGoal` + `clientRequestId`（平铺，不包在 `goal` 里） |
| `POST /v1/plans/:id/jobs` | 请求 `{ candidateId, clientRequestId }` → `{ jobId }` |
| `POST /v1/mandates` | 请求 `{ typedData, signature, outputSet: address[], planId?, jobId?, inputAssetKey, outputAssetKeys[], policyId, policyVersion, clientRequestId }` → `MandateView` |
| `GET /v1/mandates/:id` | `MandateView { mandateId, state, owner, mandate: TradeMandate, mandateDigest, signature, outputSet, spent, stepsDone, maxSteps, budgetCap, perStepCap, validFrom, deadline, latestEvaluation, evaluations[], steps[], evidenceMode, policyId, policyVersion }`；`steps[] = { stepIndex, state, step, stepDigest, validUntil, txHash, receipt }`（`receipt.event` 形状同 v1 执行回执：`{spent, received, refunded}`，另有 `confirmations`/`requiredConfirmations`/`reason`） |
| `POST /v1/mandates/:id/prepare-step` | `PreparedStep { status: READY\|WAIT\|BLOCKED\|DONE, reasons?, delta?, step? }`，`step = { stepIndex, typedData(MandateStep), stepDigest, certificate, certificateSignature, attestationSigner, routerCalldata, outputSet, approval{token,spender,amount}, guardCall{to,functionName:"executeStep"}, validUntil }` |
| `POST /v1/mandates/:id/steps/:n/submissions` | 请求 `{ txHash }` → `MandateStepView` |
| `GET /v1/{jobs,mandates}/:id/bill` | `{ jobId\|mandateId, bill: Bill }`（core 类型，`BillLine.txHash` 用于浏览器链接；**不是裸 `Bill`**——web 在 `lib/api-v2.ts` `normalizeBill` 解包） |
| `GET /v1/products` | `{ products: Product[] }` |
| `POST /v1/simulations` | 请求 `{ goal, personaId?, presetId?, clientRequestId }` → `SimulationView { simulationId, goal, report, verdict, evidenceMode:"SIMULATION", personaId, createdAt, shareId? }` |
| `GET/PUT /v1/profiles/me` | `ProfileView { ownerAddress, personaId, name, tone }`；PUT 请求体同形（owner 由 `x-verify-caller` / body 定） |
| `POST/GET /v1/templates[/:id]` | 创建请求 `{ kind:"job"\|"plan", refId }`；读取 `TemplateView { templateId, authorName, authorPersonaId, kind, structure{inputAssetKeys, legs, side, policyId, policyVersion, maxSlippageBps, maxPriceImpactBps, maxReferenceDeviationBps} }`（**不含金额/钱包/旧报价/旧授权**，C-03） |
| `POST /v1/shares` | 请求 `{ kind, refId, public, privacy{amounts:"exact"\|"range"\|"hidden", wallet:"hidden"} }` → `ShareView` |
| `GET /pub/reports/:shareId` 与 `GET /pub/reports` | `PublicReport`（见 api-v2.ts）：三层战报所需的 `headline?/goal/result/evidence/persona/templateId/status/evidenceMode`；列表返回 `{ items: PublicReport[] }`（**列表端点是 E2 的假设**，C2 若不做可降级为空板）。私密或不存在 → 404 |

- **代理**：`app/api/verify/[...path]/route.ts` 的 ALLOWED 已放行全部 v2 路径并新增 `PUT`；owner cookie 现由 `v1/jobs`、`v1/plans`、`v1/simulations`、`v1/mandates`、`v1/profiles/me` 的 body（`ownerAddress` / `goal.ownerAddress` / `typedData.message.owner`）写入。新增 `app/api/pub/[...path]/route.ts` 代理公开战报（无 API key、无 cookie、30 s 公共缓存）。
- **合约调用**：`lib/planGuardAbi.ts` 按 §10.2 冻结签名手写 ABI（`executeStep(m, mSig, address[] outputSet, s, c, cSig, routerCalldata)`、`revokeMandate(m)`、`cancelMandateNonce`、`mandateState`、event `MandateStep`）。**D2 部署后须用其产出的 abi json 复核字段顺序。** 环境变量 `NEXT_PUBLIC_PLANGUARD_ADDRESS`（为空时授权按钮禁用并显示"尚未部署"）。
- **每步授权**：执行前对 PlanGuard 精确 approve `perStepCap`（不是 budgetCap，不做无限授权）。
- **诚实显示**：`CLOSE_UNCONFIRMED` 在报告页与规划页以显著横幅显示（非开发者详情），文案按 CV-D06；`UNIT_CHANGED` 走 warning 原因码文案。
- **角色不改结论**：角色只作用于战报文案模板（`lib/report-copy.ts`），规则引擎与合约不感知角色（C-01 由 C2 的哈希测试保证）。
- **/verify-bundle 离线**：页面不在加载时调任何 API（只有点"从服务加载"或带 `?job=`/`?mandate=` 才请求），core `verifyBundleOffline` 注入 viem 的 `verifyTypedData`/`verifyMessage`（V-06）。
### 10.14 C2 定稿（服务侧响应形状，2026-09-21）
- `POST /v1/plans` → `{planId, plan: PlanReport | null, planHash, goalHash, evidenceHash, candidateCount, recommended, order, evidenceMode, …}`；`plan` 仅在免费或已付款时随视图返回，付费时经 `GET /v1/plans/:id/report` 交付（`{plan, planHash, evidence, policySnapshot}`）。
- `POST /v1/plans/:id/jobs` → 任务视图 + `{planId, candidate}`；`clientRequestId = <planId>:<candidateId>`（PL-08 同一 requestHash 链）；候选 `nextStep=USER_MUST_RELAX_LIMIT` → 409 `candidate_requires_relaxed_limit`。
- `POST /v1/mandates` → 201（免费直接放行）/ 200（付款后）/ 402（未付费）；视图含顶层 `mandateId, state, spent, stepsDone, maxSteps, mandateDigest, typedData, outputSet, budget{cap,spent,remaining}, steps{done,max}, latestEvaluation, stepRecords`。登记失败：签名 422 `mandate_signature_invalid`、与登记表/策略不符 422 `mandate_rejected`（details 指字段）、同 digest 409 `mandate_already_registered`。
- `POST /v1/mandates/:id/prepare-step` → READY 时 200 `{status:"READY", stepIndex, typedData, step, stepDigest, certificate, certificateSignature, attestationSigner, routerCalldata, outputSet(升序), planGuard, validUntil, mandate, mandateSignature, evaluation, guardCall{to,functionName,abi,args,argOrder,gasHint}, approval}`；否则 409 `{status:"WAIT"|"BLOCKED"|"DONE", stepIndex, evaluation, reasons, delta}`。
- `POST /v1/mandates/:id/steps/:n/submissions` → 202 步骤视图（含 `stepIndex, state, txHash`）；过期证书 409 `step_expired`；换 hash 409 `tx_hash_conflict`。
- `POST /v1/jobs/:id/submissions` 增加可选 `intentSignature`（执行者回传用户 TradeIntent 签名，校验后进证据包；不传则包内无 `intents`）。
- `POST /v1/simulations` → 201 `{simulationId, verdict, recommended, mode:"SIMULATION", plan, planHash, certificatesIssued:0, executions:[], …}`。
- `POST /v1/shares` body `{kind, refId, public, privacy:{amounts:"exact"|"range"|"hidden"}, title?}` → `{shareId, public, privacy, title, publicUrl}`；`GET /pub/reports/:shareId` 仅 public=true，钱包恒隐藏、金额按 privacy 区间化（`< 10 / 10–100 / 100–1k / 1k–10k / > 10k`）。
- 账单 `GET /v1/{jobs|mandates}/:id/bill` → `{bill: Bill}`；`selfPayment` 在付款人=商户或命中 `DEMO_SELF_PAYMENT_ADDRESSES` 时为 true。
- 证据包 `GET /v1/{jobs|mandates}/:id/bundle` → `EvidenceBundle`（`bundleSignature` = 证明身份对 `bundleHash` 的 EIP-191）；收费任务未付款 → 402。

### 10.15 I2 集成定稿（2026-09-21）
- **公开战报形状对齐**：服务端 `GET /pub/reports/:shareId` 返回 C2 形状（`headline` 字符串 + `headlineZh`、`goal.input/output(s)/amount|budget`、`result.reasons(codes)+reasonDetails`、`verifier`、`createdAt`）；页面在 `apps/verify-web/lib/api-v2.ts#normalizePublicReport` 一处归一为 E2 的 `PublicReport`（`headline{en,zh}`、`goal.inputSymbol/outputSymbols/amountDisplay`、`result.reasons[{code,severity}]`、`evidence{…,txHashes}`）。新增 `GET /pub/reports?limit=` 列表（`{items}`，只含 public=true，最新在前，不排名）供 `/live`。
- **A2MCP 传输约定**见 §5 表与 CV-D10；三个 A2MCP 端点（verify / plan / monitor）缺参数一律 HTTP 200 + `status:"input_required"`。
- **策略版本缺省** = `LATEST_POLICY_VERSION`（1.1.0）：a2mcp、/v1/plans、网页 /new、MCP、SDK；两个 Guard 都已白名单 v1.0.0 与 v1.1.0。

### 10.16 公开行情 `GET /pub/market/xlayer`（主站 ← Verify，2026-09-21 冻结）
- **用途**：主站（`apps/poller`，分支 main）不持有 OKX 凭据，X Layer 也不在 DexScreener 覆盖内；由 verify-service 用已有 OKX key 报价并公开一份 30 s 快照，主站按 `address` 小写匹配 `assets(chain="xlayer")`。字段**一个不许增删**，缺省写 `null`（不省略）。
- **路径**：`/pub/` 前缀（nginx `^/(v1|a2mcp|healthz|pub/)` 已分流到服务，无需改 nginx）。响应头 `Cache-Control: public, max-age=15, s-maxage=30`；503 时 `no-store`。
- **成功 200**：
```json
{
  "schema": "chaconne-verify/market-xlayer/1",
  "chain": "xlayer", "chainIndex": "196", "source": "okx_dex_quote",
  "asOf": "2026-09-21T10:00:00.000Z", "ttlSec": 30, "stale": false,
  "input": { "symbol": "USDG", "address": "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "decimals": 6 },
  "tokens": [
    { "symbol": "AAPLx", "underlying": "AAPL", "address": "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", "decimals": 18,
      "priceUsd": 335.86, "execPrice1k": 335.97, "impact1kBps": 0, "execPrice10k": 337.81, "impact10kBps": 52,
      "receivedAt": "2026-09-21T10:00:00.000Z", "route": ["Uniswap V3", "xStocks wrap V2"],
      "verifyUrl": "https://verify.chaconne.xyz/new?stock=AAPLx&from=main" }
  ],
  "errors": [ { "symbol": "NVDAx", "code": "no_route", "size": 10000 } ]
}
```
- **语义**：`priceUsd` = 100 USDG 买入档成交价（USDG≈USD，≈中间价）；`execPrice1k/10k` = 1,000 / 10,000 USDG 买入档成交价；成交价 = 金额 ÷ `toTokenAmount`（按 decimals 换算），保留 6 位小数。`impactNkBps`：OKX `priceImpactPercent` 存在则优先（`parseAdverseImpactBps`：×100、向不利方向取整、取非负），缺失则 `max(0, round((execPriceNk / priceUsd − 1) × 1e4))`。`route` = 报价路由的 DEX 名（去重保序，取 1k 档）。`tokens` 顺序 = 登记表顺序，只含 `role=stock_output && executionAllowed`（当前 AAPLx、NVDAx；SPYx 不在列）；`input` = 登记表 USDG。`verifyUrl` = `${PUBLIC_BASE_URL || https://verify.chaconne.xyz}/new?stock=<symbol>&from=main`。
- **错误码** `errors[].code`：`no_route`（OKX 82000 或 `toTokenAmount=0`；只影响该档，其它档照报，不算失败）、`rate_limited`（50011/429：至多退避重试一次，仍限流即中止本轮，余下各档也记 rate_limited）、`upstream_error`（5xx / 网络异常 / 其它错误码；5xx 与网络异常中止本轮）。
- **缓存与降级**：内存快照 TTL 30 s；过期后并发请求 single-flight；刷新失败（本轮无任何成交价）→ 返回上一份并 `stale:true`（`asOf` 保持旧值），随后 TTL 内**冷却**不再打上游；从未成功 → 503。主站侧：`stale:true` 或 `asOf` 超过 3 分钟一律视为无价。
- **限流预算**：每轮 6 次 quote（2 代币 × 3 档），串行、档间 200 ms；与付费核验共用同一把 OKX key（任务侧报价自带 50011 退避重试）。
- **健康**：`GET /healthz` 增 `publicMarket: "/pub/market/xlayer" | null`（EVIDENCE_MODE=fixture 或无 OKX 凭据时为 null，端点 503）。
- **发布指纹**：`GET /healthz` 增 `release: { treeHash, exportedAt } | null`——来自 `apps/verify-service/release.json`（私有仓导出公开快照时写入，公开仓库 `docs/RELEASE.json` 同值；评审 clone 公开仓库后 `pnpm release:hash` 复算比对，证明线上运行的就是公开源码）。文件缺失为 null。
- **实现**：`apps/verify-service/src/market/xlayer.ts`；测试 `test/marketXlayer.test.ts`（8 例）；探针 `pnpm market:probe`（不起 HTTP/DB，直接打印一份快照）。
