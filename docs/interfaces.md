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
| `GET /v1/jobs/:id` | 任务状态（付款/报告/额度/执行）。**记录按钱包归属（FIX-174）**：建它的调用方，或代表其 owner 钱包的调用方（`web:<owner>` / `a2mcp:owner:<owner>` / 地址本身）都能读；plans / simulations / mandates / tasks 同规则 | 200 |
| `GET /v1/jobs/:id/report` | 付费报告 | **402 + PAYMENT-REQUIRED**（价格 0 时 200） |
| `POST /v1/jobs/:id/prepare-execution` | body `{refreshKey}`（幂等键）；消耗再核验额度 → 新报告版本 + TradeIntent typed data + 证书签名 + Guard 调用参数 | 402 未付 / 409 额度耗尽 / 422 不合格(REJECTED，仍耗额) / 503 未配 Guard 或签名身份 |
| `POST /v1/jobs/:id/submissions` | body `{attemptId, txHash}`；记录 tx hash，状态 SUBMITTED；服务端核实器按 RPC 回执推进：REORG_PENDING（确认数不足）→ CONFIRMED（回执成功 + Guard 事件 intentDigest 一致 + ≥6 确认）/ REVERTED / UNKNOWN（回执缺失 >10 min、事件缺失、摘要不符；带 reason）；`executions[].receipt` 与 `execution.receipt` 返回回执摘要 | 202；同尝试换 hash 409 |

| `GET /pub/market/xlayer` | **公开行情**（主站 chaconne.xyz 的 poller 定期拉）：X Layer 股票代币对 USDG 的 OKX 聚合器买入报价，分两层——execute（登记表内 2 只，100/1k/10k 三档带冲击 + 深链）、display（39 只，只有 100 USDG 档中间价，冲击与深链均 `null`）；无鉴权无 x402；服务端缓存 60 s + single-flight；上游失败回上一份 `stale:true`；从未成功 503 `{error:"unavailable"}`。契约 §10.16 | 200 / 503 |
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
| CV-D17 | 2026-09-26 | **key 必须带**（`VERIFY_AUTH_OPEN` 缺省关）。用户自助签发：网站 `/agent/keys` 钱包签名 → `vk_live_…`，调用方 `agent:<钱包>`，与网页会话 `web:<钱包>` 互见（记录按钱包归属，FIX-174）。网站改为钱包登录会话（`/api/session`，personal_sign，30 天 httpOnly cookie），代理不再接受请求里自报的真实地址 |
| CV-D15 | 2026-09-23 | 上下文字段的「值为 null」与「不可得」分开：producer 标 `status=ok` 且 `value=null`（不是假日 → `session.holiday`、不在静默期 → `fed.blackoutUntil`、近 24h 无已判定发布 → `crossAsset.lastDataRelease`）是**合法空值**，服务侧判为 `ok` 并照常做新鲜度（过期仍 `stale`）；只有 producer 未标 ok 的 null 才是 `unavailable`。条件求值：`not_in_fed_blackout` 的 `blackoutUntil` 与 `require_cross_asset_confirmation` 的 `lastDataRelease` 接受合法 null（后者 null = 没有需要确认的发布 → SATISFIED）；数值/枚举字段 null 仍算证据不足。来源：服务器上线观察（deployment runbook 2026-09-23）。 |
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

### 10.16 公开行情 `GET /pub/market/xlayer`（主站 ← Verify，2026-09-21 冻结；2026-09-22 加 `tier` 扩两层）
- **用途**：主站（`apps/poller`，分支 main）不持有 OKX 凭据，X Layer 也不在 DexScreener 覆盖内；由 verify-service 用已有 OKX key 报价并公开一份快照，主站按 `address` 小写匹配 `assets(chain="xlayer")`。字段**一个不许增删**，缺省写 `null`（不省略）。
- **两层（2026-09-22）**：
  - `tier:"execute"` —— 在 Verify 登记表 `xlayer-registry/1.1.0` 且 `executionAllowed` 的代币（当前 AAPLx、NVDAx）。报 100/1k/10k 三档，带冲击，带 `verifyUrl` 深链。
  - `tier:"display"` —— 比价展示层，名单在 `apps/verify-service/config/xlayer.display.json`（`xlayer-display/1.1.0`，39 只）。**只报 100 USDG 一档**当中间价，`execPrice1k/10k` 与 `impact*Bps` 一律 `null`，`verifyUrl` 一律 `null`（它们不在登记表里，`/new?stock=` 会解析失败）。
  - 展示名单**刻意不放进登记表**：登记表哈希在 Guard 合约白名单里，改它等于动链上配置。扩展示层只改这个独立文件，不触链。
- **路径**：`/pub/` 前缀（nginx `^/(v1|a2mcp|healthz|pub/)` 已分流到服务，无需改 nginx）。响应头 `Cache-Control: public, max-age=30, s-maxage=60`；503 时 `no-store`。
- **成功 200**（取自 2026-09-22 真实上游快照，41 只中各摘一只）：
```json
{
  "schema": "chaconne-verify/market-xlayer/1",
  "chain": "xlayer", "chainIndex": "196", "source": "okx_dex_quote",
  "asOf": "2026-09-22T09:36:49.183Z", "ttlSec": 60, "stale": false,
  "input": { "symbol": "USDG", "address": "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "decimals": 6 },
  "tokens": [
    { "symbol": "AAPLx", "underlying": "AAPL", "address": "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", "decimals": 18,
      "tier": "execute",
      "priceUsd": 339.943919, "execPrice1k": 340.12641, "impact1kBps": 6, "execPrice10k": 340.466027, "impact10kBps": 16,
      "receivedAt": "2026-09-22T09:36:20.978Z",
      "route": ["Uniswap V3", "Uniswap V4", "Caliber propAMM", "xStocks wrap V2"],
      "verifyUrl": "https://verify.chaconne.xyz/new?stock=AAPLx&from=main" },
    { "symbol": "SPCXx", "underlying": "SPCX", "address": "0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28", "decimals": 18,
      "tier": "display",
      "priceUsd": 152.670614, "execPrice1k": null, "impact1kBps": null, "execPrice10k": null, "impact10kBps": null,
      "receivedAt": "2026-09-22T09:36:24.962Z",
      "route": ["Uniswap V3", "xStocks wrap V2"],
      "verifyUrl": null }
  ],
  "errors": []
}
```
- **语义**：`priceUsd` = 100 USDG 买入档成交价（USDG≈USD，≈中间价）；`execPrice1k/10k` = 1,000 / 10,000 USDG 买入档成交价（display 层恒 `null`）；成交价 = 金额 ÷ `toTokenAmount`（按 decimals 换算），保留 6 位小数。`impactNkBps`：OKX `priceImpactPercent` 存在则优先（`parseAdverseImpactBps`：×100、向不利方向取整、取非负），缺失则 `max(0, round((execPriceNk / priceUsd − 1) × 1e4))`；display 层不报 1k/10k，所以不补算，保持 `null`（**不要写 0**，0 会被读成"没有冲击"）。`route` = 报价路由的 DEX 名（去重保序，execute 取 1k 档，display 取 100 档）。`tokens` 顺序 = 先登记表顺序（execute），后展示名单顺序（display）；`input` = 登记表 USDG。`verifyUrl` = `${PUBLIC_BASE_URL || https://verify.chaconne.xyz}/new?stock=<symbol>&from=main`，**仅 execute 层**。
- **去重**：展示名单里若出现已在登记表的地址，以登记表（execute）为准，展示层跳过，不会报两次。
- **错误码** `errors[].code`：`no_route`（OKX 82000 或 `toTokenAmount=0`；只影响该档，其它档与其它代币照报，不算失败）、`rate_limited`（50011/429：至多退避重试一次，仍限流即中止本轮，余下各档也记 rate_limited）、`upstream_error`（5xx / 网络异常 / 其它错误码；5xx 与网络异常中止本轮）。单只代币失败只落一条 `errors`，不影响其余 40 只。
- **缓存与降级**：内存快照 TTL 60 s；过期后并发请求 single-flight；刷新失败（本轮无任何成交价）→ 返回上一份并 `stale:true`（`asOf` 保持旧值），随后 TTL 内**冷却**不再打上游；从未成功 → 503。主站侧：`stale:true` 或 `asOf` 超过 3 分钟一律视为无价。
- **限流预算**：每轮 45 次 quote（execute 2 × 3 档 + display 39 × 1 档），串行、档间 350 ms（260 ms 实测撞 OKX 50011）。实测整轮 ≈ 29 s（含上游 RTT），仍在 60 s TTL 内，限流不是瓶颈；与付费核验共用同一把 OKX key（任务侧报价自带 50011 退避重试）。
- **名单取舍**（2026-09-22 实测 OKX RWA 名录 `category=47, chainIndex=196` 全量 100 只）：49 只在 X Layer 上可被聚合器路由，其余 51 只返回 82000（链上无池）→ 不接（接了只会是空行）。49 只里 41 只是美股/美股 ETF 底层 → 全部接入（execute 2 + display 39）；另 8 只底层是港股数字代码（TCENTx 700、SHEINx 625、XIAOx 1810、KUAIx 1024、MEITx 3690、HKEXCx 388、POPMTx 9992、MIXUx 2097）→ 暂不接：主站参考价管线是美股（`us-equity:` + 纽交所日历），接进来会把交易时段标错且无参考价，需另配港股日历与参考源。
- **健康**：`GET /healthz` 增 `publicMarket: "/pub/market/xlayer" | null`（EVIDENCE_MODE=fixture 或无 OKX 凭据时为 null，端点 503）。
- **发布指纹**：`GET /healthz` 增 `release: { treeHash, exportedAt } | null`——来自 `apps/verify-service/release.json`（私有仓导出公开快照时写入，公开仓库 `docs/RELEASE.json` 同值；评审 clone 公开仓库后 `pnpm release:hash` 复算比对，证明线上运行的就是公开源码）。文件缺失为 null。
- **实现**：`apps/verify-service/src/market/xlayer.ts` + `config/xlayer.display.json`；测试 `test/marketXlayer.test.ts`（13 例）；探针 `pnpm market:probe`（不起 HTTP/DB，直接打印一份快照）。展示名单文件缺失或格式不符时记一条 warn 并退化为"只有 execute 层"，端点不失败。

## 11. v6 增补（Chaconne Agent · 开发计划 v6 §1，2026-09-23 冻结；Lane I）

唯一类型事实来源仍是 `packages/core/src/verify/contracts.ts`（末尾「v6 增补」段，**只追加**；`REASON_CODES` 与 `EvidencePayload` 联合已扩）。本节只冻结约定、命名与路径；字段以代码为准。产品语义以上游 `Chaconne_Verify_升级计划_v6_Agent交易与crowsnest.md` §6 为准，冲突时以上游为准并记 CV-D。金额十进制字符串；链下时间 ISO-8601 UTC；哈希 keccak256（沿用 canonical `canon-1`）。新增子模块：`packages/core/src/verify/{events,context,conditions,tasks,thesis,budget,lab}/`。

### 11.1 时间语义（所有 lane 共同遵守）
- 四个时刻必须分开记：**事件发生时间**（`scheduledAtUtc`）、**观测/统计期**（`observedAt`：定盘日、K 线收盘）、**首次可知**（`firstKnownAt`）、**抓取/打包**（`fetchedAt` / `packagedAt`）。verify-service 另记 `receivedAt`。
- `unfinished`：标签时间晚于打包时刻的未完成区间（如日线未收盘），**不得当已发生观测**。
- 回放只读评估时点已可知的信息：事件按 `firstKnownAt ≤ t` 的版本；数值按 `receivedAt/packagedAt ≤ t`；不用后来修订的事件时间、宏观数值或补齐的财报结果。无档案 → 明确 `gaps`，不伪装。
- 归档文件只能证明过去观测；从 git 读到的 `analyst/state/context.json` fallback **不得标 LIVE**。

### 11.2 事件契约（C6 的根；`MarketEvent`）
- id 稳定：`${source}:${kind}:${YYYY-MM-DD}:${slug}`；改期不换 id，`revision+1` 并保留 `revisedFrom`。
- 来源：宏观/联储由 crowsnest 导出（其队列 `approx` → `datePrecision='estimate'`）；财报由 verify-service 从财报日历源摄入（Lane D，先探针 Finnhub `/calendar/earnings` 再定，源无确认字段一律 `estimated`）；假日/提前收盘来自 `packages/core/src/calendar.ts`（与 crowsnest NYSE 日历对拍一次，差异记 CV-D）。
- **窗口不由 producer 决定**：每个任务按自己的条件参数算窗口；不提供 nextTier1/nextTier2 之类固定窗口字段。
- 修订历史入 `verify_event_revisions`；`firstKnownAt` 取首次入库时刻与 producer 值的较早者。

### 11.3 上下文契约（C1；`MarketContext` / `CtxField<T>`）
- 每个字段 `{value, source, observedAt, fetchedAt, status, purposes, note?}`；取不到 `value=null,status='unavailable'`，**绝不省略、绝不用 0 冒充**。
- **CV-D12**：数值型字段的 `value` 一律十进制字符串（canonical `canon-1` 只允许安全整数，浮点无法签名）；消费方按需解析。**CV-D13**：顶层可选 `provenance.mode ∈ live|backfill|sample`，只有 `live` 可参与 LIVE 判定，其余只用于回放与联调。
- 参考实现与黄金样本：crowsnest 分支 `v6-context-export`（`sentinel/context_sign.py`、`sentinel/tests/golden/context_canon_{1_edge,2_rates,3_event}.json`，各含 input / canonical / sha256 / signature / publicKeyHex）；开发机测试公钥 `31bd65ba3273d04e572b9bc6deaff903b3cbf4d48efc151efd7dc0f1ea0570e4`（`publicKeyId=crowsnest-ctx-k1`），**服务器另生成一对**。
- 签名：Ed25519，`signature` 覆盖 canonical(除 `signature` 外)；canonical 与 TS `canon-1` 对拍，Lane A 提供 3 个黄金样本给 Lane B 互检；公钥来自 env `CROWSNEST_PUBKEY_ED25519`（按 `publicKeyId` 选）。验签失败 → 整份拒收 + `CONTEXT_UNAVAILABLE`。
- staleness 由 verify-service 按字段类判定（不信 producer 自报）：`session` 10 分钟；`events` 60 分钟；日度定盘（`rates.*`、`realYield10`）= 超过下一交易日 18:00 ET 未更新；`risk.vix/nq/es/dxy` 常规时段 20 分钟、休市按最后收盘并标 `observedAt`；`fed.hikeProb` 15 分钟；`crossAsset` 按事件 T+60 分钟内有效。过期 → 该字段 `stale`，只阻塞依赖它的条件（`CONTEXT_STALE`）。
- 用途白名单（D-084 默认）：`agent`/`paid` 只含派生字段（时段、事件、窗口、静默期、曲线形态、漂移判定）与官方公开源数值（FRED/财政部/BLS/联储/Polymarket）；Yahoo（VIX/NQ/ES/DXY）与 Coinglass 派生值只 `internal`/`display`；`analyst/` 私有研究、预测台账、阈值一律不导出。响应按档位裁剪：字段不在档位 → 整个字段 `{status:'unavailable', note:'not_in_tier'}`（`CONTEXT_FIELD_NOT_IN_TIER`），**绝不省略键**。
- 过滤：`GET /v1/context?assetKey=…|owner=…|taskId=…` 只返回相关事件与相关字段。
- crowsnest 发布（Lane A）：`https://<crowsnest-host>/context/latest.json`（`Cache-Control: max-age=60`）、`/context/events.json`、`/context/history/YYYY-MM-DD.jsonl`（每 tick 一行，保留 30 天）；一次性 `backfill_context.py` 回填 30 天（只用当时已有数据）。crowsnest 若 9/24 12:00 仍不可用 → 上下文用 Chaconne 日历出降级版（多数字段 `unavailable`），条件层按「证据不足 = 等待」照常。

### 11.4 条件 DSL（C2；`Condition` / `ConditionSet` / `evaluateConditions`）
- `evaluateConditions(set, evidence, taskState, now) → ConditionEvaluation` **纯函数**；任一 `UNSATISFIED` / `INSUFFICIENT_EVIDENCE` → 不签发证书；`nextCheckAt` 取各项已知恢复点的最小值（事件窗口结束、下一常规时段开盘、下一交易日），未知（如 `cash_floor`）写 null。
- 交易日按 `calendar.ts`（纽约、夏令时、假日、提前收盘）；`min_gap_trading_days` 以上一步 **确认** 的交易日计。
- `ConditionSet.hash = keccak256(canonical({version, items}))`，进入 `effectivePolicyHash` 的展开参数 → 进证书与证据包；验证器用保存的输入复算（K-10）。**链上只约束预算/步序/期限/签名/承诺绑定；市场条件由服务判断。**
- `premium_bps_lte` 的 `official_close` / `close_last_tick` 口径只允许 SIMULATION/观察；UI 与 API 都拒绝用它建 LIVE 执行条件（Y-05）。`not_in_fed_blackout` 默认不进任何模板（K-07）。`require_cross_asset_confirmation` 不接受 `undecided`（K-08）。
- 改条件 = 新授权；新授权不自动使旧授权失效；展示旧授权状态、是否仍有可用证书、撤销确认状态（K-09）。
- 通知只是唤醒（D-087）；执行前重新取证、报价、余额、额度、时效、全部条件。

### 11.5 任务、理由卡、资金组、影响、对照、回放
- `TaskStatus` 12 态（`contracts.ts TASK_STATUSES`）；`Task.blockers` 全量（不止第一个）；`ExecutorPresence` 三态：3 分钟内有心跳 = `online`，浏览器钱包路径 = `awaiting_signature`，都无 = `offline`（信息项，不阻塞签发）。
- 模板（`apps/verify-service/config/playbooks.json` 版本化；`PLAYBOOK_IDS`）：`session_dca`（N 步、`session:[US_REGULAR]`、`min_gap_trading_days:1`、可选 `avoid_event_window`；错过窗口只顺延不合并）、`event_aware_accumulate`（`avoid_event_window(MACRO_TIER1, 30, 20)` + `earnings_window(1, 1, true, true)`）、`discount_watch`（`premium_bps_lte` live 才可执行）、`target_sell`（`target_price_*` 或 `tracked_cost_pnl_pct_gte`，成本覆盖率 <100% → `TRACKED_COST_UNKNOWN` 并建议只用目标价）、`portfolio_rebalance`（Lane C 编排：先卖后买、每腿单独授权、买力重算、允许 `PARTIAL`）。
- 理由卡：machine 前提 = Condition 三态；research 前提只收 `reviewItems`（`sourceUrl` 必填）并保持 `unknown` 直到用户标记；任一机器前提 `invalidated` → `onInvalidation`：`notify` / `pause_issuance`（任务 PAUSED，说明只是停止签发）/ `draft_exit`（生成卖出/调仓草案，等待新授权）；`validUntil` 过期 → `WAITING(THESIS_EXPIRED)`。理由卡进证据包（T-05）。
- 资金组（D-086，服务侧协调）：不变量 **`spentThisPeriod + Σ reservedRaw(可执行授权) ≤ capRaw`**；`pendingRaw` 计入 reserved 不重复；注册授权按 `priority → createdAt` 分配 reserved（全额或 0；0 → `WAITING(BUDGET_GROUP_CONFLICT)`）；步骤确认 → `spent += actual, reserved −= actual`；回滚/过期/撤销 **链上确认后** 才释放；跨周期授权必须指定归属周期；执行前重查链上余额，`cash_floor` 用真实余额。
- 影响（C6）：`impacts(owner, horizon)` = 事件 × 相关资产（`underlyingIds` ↔ registry `underlyingId`）× 持仓 × 任务 → `relation` 三类 → `effect` → `actions`；宏观事件只标 `macro_research`，文案不写涨跌；事件 revision 变化 → 重算受影响任务并发 `event.revised`；`datePrecision='day'` 且用户预选 `wholeDayIfDayPrecision` → 整日等待，未预选 → 提示选择，不补时刻。
- 对照（C9）：固定同一 `evidenceSnapshotId`；同资产/资金基准/费用假设；每个变体跑 `evaluateConditions` + 规划器（同 quote 证据）；`mode: SIMULATION`，不写任何授权。回放：数据源 `verify_evidence`（9/20 起）、`verify_context_snapshots` + crowsnest 30 天回填、`premium_1h`（只作背景不当 quote）；依赖 quote 的条件在无 quote 时点 → `INSUFFICIENT(NO_QUOTE)`；断供清空区间 → `gaps: REFERENCE_PURGED`；**不输出收益**。

### 11.6 停止语义与授权变更（D-088）
- `POST /v1/tasks/:id/{pause,resume,cancel}` = 服务侧停止：只阻止后续签发；已取走且未过期的证书仍可能可执行；响应体必须写明。彻底停止以链上 `revokeMandate` 确认为准（任务 `REVOKE_PENDING → REVOKED`）；UI 不把按钮响应当撤销完成。

### 11.7 HTTP（verify-service 新增；旧接口不变）
| 方法 路径 | 用途 | 状态码 |
|---|---|---|
| `GET /v1/context?tier&assetKey&owner&taskId` | C1；按档位裁剪；按资产/持仓/任务过滤；免费档（D-085） | 200（永远 200，字段级 unavailable） |
| `GET /v1/events?from&to&underlyingId&kind`、`GET /v1/events/:id/revisions` | 事件列表（含修订号）与修订史 | 200 |
| `POST /v1/tasks` | 从 playbook + 参数建任务：返回任务、待签授权草案（typedData）、理由卡草案、资金组分配结果；SIMULATION 立即可用。**CV-D16**：可带 `scope`（授权范围，全部可缺省 = 计划本身，必须包住计划）；响应多 `task.scope` / `task.scopeHash` / `bindingHash` / `scopeBoundary` | 201 / 400（playbook 参数 / `invalid_scope`） / 409（幂等冲突） |
| `GET /v1/tasks/:id`、`GET /v1/tasks?owner` | 详情（阻塞项全量、nextCheckAt、执行器在线态、账目）；owner 鉴权 | 200 / 403 |
| `POST /v1/tasks/:id/{pause,resume,cancel}` | 服务侧停止语义（§11.6） | 200 / 409 |
| `POST /v1/tasks/:id/authorize` | 提交已签 TradeMandate（复用 `/v1/mandates` 逻辑）并挂到任务 | 201 / 422 |
| `POST /v1/tasks/:id/prepare-step` | 前置链 `evaluateConditions` → 资金组/现金下限 → 理由卡 → 现有 prepare-step（证据、报价、证书 TTL 规则不变）；`scope.issuance=agent` 的任务 → 409 `issuance_by_agent`（只跟 agent 提交的交易意图签发） | 200 / 409（WAIT，带全部阻塞项） |
| `POST /v1/tasks/:id/intents`、`GET /v1/tasks/:id/intents`、`GET …/intents/:intentId`、`POST …/intents/:intentId/withdraw` | **CV-D16 批次 2**：agent 提交交易意图 `{clientRequestId, kind: buy\|sell, outputAssetKey, amountInRaw, decision: {rationale, claims[], alternatives?, revisionOf?}}` → 四道核验（facts / scope / execution / binding）→ LIVE 全过才签步骤证书并交出 `guardCall`（体与 prepare-step READY 同形）；SIMULATION 只核验（`simulated`）；任一道不过 → 422 `intent.status=rejected`（决策记录照样存）。计划条件对意图不阻塞，只记 `planDeviations`。撤回：certified 且未提交 → 步骤作废（已取走证书到期前仍可能执行，D-088） | 201 / 200（幂等）/ 422 / 409（未授权、暂停、无 scope） |
| `DELETE /v1/tasks/:id` | **批次 7**：用户删除 = 归档：运行中的先按 D-088 取消（有授权 → REVOKE_PENDING），然后从 `GET /v1/tasks` 与 `GET /v1/records` 消失；行、授权、证书、回执不销毁，详情与证据包仍可读。响应 `{...view, archived: true, cancelled, note}` | 200 / 403 |
| `POST /v1/keys` | **FIX-175 / CV-D17** 钱包签发 API key：body `{ownerAddress,label,nonce(16–64 hex),issuedAt(ISO, 与服务器时钟差 ≤ 10 min),signature}`，signature = 钱包对 core `apiKeyIssueMessage(...)` 文本的 personal_sign；不需要 key（签名就是凭证）。201 `{id,label,hint,ownerAddress,callerId:"agent:<钱包>",apiKey(只此一次),usage,keysUrl}`；401 `bad_signature`；409 `nonce_reused` / `too_many_keys`（每钱包 20 把）；400 `issued_at_out_of_window` | 201 |
| `GET /v1/keys?owner=`、`DELETE /v1/keys/:id` | 列出 / 吊销该钱包的 key（不含明文）；调用方须代表该钱包（网站会话 `web:<钱包>` 或该钱包自己的 key）；吊销即失效。没带 key 的请求一律 401 `missing_api_key`（正文 `keysUrl`），`VERIFY_AUTH_OPEN=true` 仅供本地演示 | 200 |
| `POST /v1/tasks/:id/brief` | **CV-D16 批次 6**：owner 改简报 `{strategy?, watchEvents?: {kinds}, note?}`（签名之外；策略留版本） | 200 / 400 / 409 |
| `POST /v1/tasks/:id/agent-status` | **CV-D16 批次 3 / 6**：agent 回报 `{status: accepted\|declined\|needs_evidence\|plan_revised\|ended, note, agent?: {name}, requestedEvidence?, plan?: {conditions?, text?}, strategy?}`（`accepted` = 接管，须带 `agent.name`，不关闭轮次；`plan.text` → 当前计划；`strategy` → 策略新版本 by agent）；都是正常结果，写进当前轮次 `agentTurn` 与时间线；`plan_revised` 走 `/conditions` 同一套校验（硬约束 → 409 `scope_locked`）；`ended` → 服务侧暂停（不撤销） | 200 / 400 / 409 |
| `POST /v1/tasks/:id/conditions` | 改**计划条件**（CV-D16：在签名之外，不需要新授权，现有授权继续有效）；触碰 `scope.hardConditions` 的同类型 → 409 `scope_locked`；无 scope 的旧任务沿用 K-09（改条件 = 新授权） | 200 / 400 / 409 |
| `POST /v1/mandates/:id/executor/heartbeat` | agent-wallet 执行器心跳（60 s） | 204 |
| `GET /v1/event-impacts?owner&horizonHours=48` | C6 影响清单 | 200 |
| `POST /v1/theses`、`GET /v1/theses/:id`、`POST /v1/theses/:id/review-items` | C7；review-items 只能 owner/agent 追加，不触发执行 | 201/200/201 |
| `POST /v1/budget-groups`、`GET /v1/budget-groups/:id`、`POST /v1/budget-groups/:id/allocations` | C8 | 201/200/201 或 409（冲突 → 分配 `waiting`） |
| `GET /v1/portfolio/:owner`、`POST /v1/portfolio/:owner/cost-overrides` | C4；自报成本标 `user_reported`；owner 鉴权 | 200/201 |
| `POST /v1/notify/webhooks`、`GET/DELETE …/:id`、`POST /v1/notify/telegram/link`、`POST /v1/notify/test` | C4 通知；webhook HMAC-SHA256，3 次重试后停用并写任务时间线 | 201/200/204 |
| `GET /v1/tasks/:id/explain-wait` | C9 等待诊断（全部阻塞项、证据时间、nextCheckAt、userActionRequired） | 200 |
| `POST /v1/tasks/:id/compare-policies` | C9 同输入对照（SIMULATION，不改真实任务） | 201 |
| `POST /v1/replays`、`GET /v1/replays/:id` | C9 决策回放（无前视） | 201/200 |
| `POST /v1/rebalance/preview`、`POST /v1/rebalance/plans`、`GET /v1/rebalance/plans/:id` | C3 调仓编排（多授权协作、部分完成） | 200/201/200 |
| `GET /v1/recaps?owner&date`、`GET /v1/recaps/:id` | C5 夜班日志（纽约实际收盘后 45 分钟生成，时区用 `session.ts`） | 200 |
| `POST /a2mcp/agent-tasks` | OKX AI 服务：输入 owner 或资产集合 → 事件影响 + 任务草案；审核期价格 0；**等 #13803 结果后再提交上架** | 200（`delivered` / `input_required`），沿用 a2mcp 只回 200/402 约定 |

鉴权：组合、任务、回调注册、理由卡与私密复盘一律验 owner（现有 `web:<address>` / API key caller 机制）；单凭钱包地址不能修改任务或获知私密信息。

### 11.8 MCP 工具（verify-mcp 追加；旧工具保留）
`get_market_context`、`get_events`、`create_task`（**CV-D16**：可带 `scope`）、`get_task`、`pause_task` / `resume_task` / `cancel_task`、`authorize_task`（agent-wallet 模式下可代签 TradeMandate，限额内）、`get_my_event_impacts`、`watch_thesis`、`add_thesis_review_item`、`explain_task_wait`、`compare_task_policies`、`replay_policy`、`preview_rebalance`、`create_rebalance_plan`、`get_budget_group`、`create_budget_group`、`get_portfolio`、`report_cost_override`、`register_webhook`、`link_telegram`、`executor_heartbeat`（agent-wallet 模式自动调用）。复用 `plan_trade` / `prepare_mandate` / `execute_next_step` / `get_evidence_bundle` / `verify_evidence_bundle`。
**CV-D16 批次 4（agent 自主决策，5 个）**：调查用现有 `get_market_context` / `get_events` / `get_task`（含 `scope` 与 `agentTurn`）/ `explain_task_wait` / `get_my_event_impacts`；操作：`submit_trade_intent`（意图 + 决策记录 → 四道核验 → 证书；422 = 被拒但记录保存，`isError=false`）、`get_task_intents`（`withStep=true` 在证书有效期内再取 READY 体）、`withdraw_trade_intent`、`report_agent_status`（declined / needs_evidence / plan_revised / ended）、`execute_trade_intent`（agent-wallet 模式：取意图的 READY 体 → 与 `execute_next_step` 同一套本地与链上核对 → 发送）。合计 51 个。

### 11.9 数据表（迁移 0018，Drizzle，Lane C 出迁移；B/D/E 只增列于各自表）
`verify_events`、`verify_event_revisions`、`verify_context_snapshots`（每次摄入全量 + 哈希 + 逐字段 status）、`verify_tasks`、`verify_task_blockers`（每次评估的阻塞快照）、`verify_theses`、`verify_thesis_checks`、`verify_budget_groups`、`verify_budget_allocations`、`verify_budget_ledger`（预留/占用/释放/结算流水）、`verify_cost_overrides`、`verify_notification_channels`、`verify_notification_outbox`（幂等键 `${type}:${entityId}:${version}`）、`verify_executor_heartbeats`、`verify_policy_comparisons`、`verify_replays`、`verify_rebalance_plans`、`verify_rebalance_legs`、`verify_recaps`、`verify_missions`；`verify_mandates` 增列 `task_id`、`conditions_hash`。

### 11.10 原因码（§1.8，已入 `REASON_CODES`）
全部 non-HARD → 任务 `WAITING`：`CONTEXT_UNAVAILABLE`、`CONTEXT_STALE`、`CONTEXT_FIELD_NOT_IN_TIER`、`EVENT_WINDOW_ACTIVE`、`EVENT_DATE_UNCERTAIN`、`EARNINGS_WINDOW_ACTIVE`、`EARNINGS_COVERAGE_UNKNOWN`、`FED_BLACKOUT`（仅用户选择时）、`VOL_REGIME_EXCEEDED`、`SESSION_RULE_BLOCK`、`CROSS_ASSET_UNCONFIRMED`、`STEP_GAP_NOT_ELAPSED`、`DAILY_STEP_CAP_REACHED`、`PREMIUM_CONDITION_NOT_MET`、`TARGET_NOT_REACHED`、`TRACKED_COST_UNKNOWN`、`CASH_FLOOR_BLOCK`、`BUDGET_GROUP_CONFLICT`、`BUDGET_GROUP_EXHAUSTED`、`BUDGET_PENDING_OCCUPIED`、`THESIS_INVALIDATED`、`THESIS_UNKNOWN`、`THESIS_EXPIRED`；信息项（不阻塞签发）：`EXECUTOR_OFFLINE`、`AWAITING_USER_SIGNATURE`。

### 11.11 通知事件（`NOTIFICATION_TYPES`）
`task.status_changed`、`task.step_ready`、`task.step_confirmed`、`task.step_reverted`、`task.blocked`（阻塞集合变化时一次）、`event.revised`、`event.released`、`thesis.invalidated`、`thesis.unknown`、`budget.conflict`、`budget.released`、`task.expiring`（到期前 24 h）、`recap.ready`。载荷只含 id、类型、版本、摘要与链接；**不含任何签名、证书、calldata**；outbox 幂等键 `${type}:${entityId}:${version}`；重复/延迟通知不得导致重复步骤（幂等键 + 步序）。

### 11.12 证据 payload（CV-D）
新增 `market_context`（含 `signatureValid`、`contextHash`、逐字段 `fieldStatus`；全量入 `verify_context_snapshots`）、`market_event`（含 `revision`、`firstKnownAt`）、`portfolio_snapshot`（含区块号与可追溯数量）。`EvidenceMode` 不变；回放产出的评估标 `REPLAY`，对照标 `SIMULATION`。

### 11.13 能力开关
每个能力独立 env flag `AGENT_C1_ENABLED … AGENT_C9_ENABLED`（缺省 true）；9/25 12:00 验收没绿的关 flag 并从材料移除；数据接入失败的字段显示不可用，不用回放伪装实时。

### 11.14 实现增补（各 lane 落地时超出 §11.7 的端点；Lane I 2026-09-23 裁决：**全部收进契约**，理由逐条注明）
| 方法 路径 | 来源 | 理由 |
|---|---|---|
| `POST /v1/event-impacts/actions` | D | 六个动作需要一个执行入口；`effect: invalid → 400 / not_ready → 503`，不越权触发任何执行 |
| `GET /v1/events/earnings/coverage`、`POST /v1/events/earnings/ingest`（运营者 key） | D | 覆盖率给页面「未知」标注；手动摄入只给运营者 |
| `GET /v1/mandates/:id/executor` | C | 与心跳配对的读侧，页面按三态显示 |
| `POST /v1/rebalance/plans/:id/legs/:n/authorize` | C | 每腿单独授权（§11.5 调仓语义） |
| `POST /v1/recaps/:id/share`、`GET /pub/recaps/:shareId` | F | R-04 默认私密、公开可隐藏资产与金额；公开读走 `/pub/` 与既有战报一致 |
| `GET /v1/missions` | F | Missions 从事件日历与资产覆盖生成，无事件时用标注日期的回放任务 |
| `GET /a2mcp/agent-tasks`（与 POST 同体） | F | 沿用 a2mcp GET↔POST 回退约定 |
| `GET /pub/reports/:shareId/bundle` | S（V-39，2026-09-24） | A2MCP 建的 job 交付时自动发布只读战报，响应带绝对 `publicUrl` / `publicBundleUrl` / `publicPageUrl` / `shareId`；免 key 可回查（付费报告未付则 402） |
| `GET /pub/openapi.json`、`GET /pub/llms.txt`、`GET /pub/agent-card.json`（服务别名 `/openapi.json`、`/llms.txt`、`/.well-known/agent-card.json`、`/.well-known/agent.json`；web 域同名路径由 verify-web 代理） | S（V-40） | Agent 可发现性：OpenAPI 3.1（免费端点）、llms.txt、agent card；A2MCP `howToCall` 带链接 |
| `GET /healthz?deep=1`（需 API key） | S（V-43） | 公开 `/healthz` 不再含内网 URL（`contextConfigured` 布尔）与密钥环；treeHash、合约地址与能力开关保留 |
| 免 key 端点限流：`/v1/{assets,policies,products,playbooks,context,events}`、`/a2mcp/*`、`/pub/*`、`/healthz` 按 IP `FREE_RATE_LIMIT_PER_MIN`（默认 30）；头 `RateLimit-Limit/Remaining/Reset`、429 带 `Retry-After`；带合法 key 的请求不计 | S（V-42） | `/a2mcp/verify` 同 (caller, owner, 资产, 金额, 策略) 60 s 内复用 job（`reused`/`reuseNote`），`clientRequestId` 幂等不变 |
| 错误方法 → 405 + `Allow`；`/a2mcp/*` 响应头 `X-A2MCP-Status: input_required|delivered|rate_limited|payment_required`（正文与 200-only 传输不变，CV-D10）；错误体 `{error, message(英文), messageZh?, details?}` | S（V-28 / V-41） | 机器可读；中文文案保留在 `messageZh` |
| 契约增补：`PremiseKind` 加 `timing`（时段/间隔/事件窗口/财报窗口/静默期这类时间门不参与理由卡失效判定）；`ConditionEvidence.theses[].nextCheckAt`；`Mission.draft` = 可直接 `POST /v1/tasks` 的 SIMULATION 任务体，`Mission.replay` 单列 | S（V-25 / V-27） | 休市建任务不再误报 THESIS_INVALIDATED；A2MCP 草案必能 201（有测试） |
前端代理 `apps/verify-web/app/api/verify/[...path]/route.ts` 的放行名单为以上全部 + §11.7 的并集（合并时已对齐）。

**CV-D14**：任务证据包 `TaskEvidenceBundle` = `EvidenceBundle` + 附加段（理由卡、条件集与求值输入），`bundleHash` 覆盖附加段；旧 job/mandate 包不变。**迁移 0018 定稿**：`packages/db/migrations/0018_pink_darwin.sql`，22 张表（§11.9 的 20 张 + Lane D 的 `verify_earnings_ingests` / `verify_earnings_periods`）+ `verify_mandates` 增 `task_id`、`conditions_hash`；各 lane 的临时 0018/0019 已作废。

**CV-D16（2026-09-25，Agent 自主决策批次 1：授权即范围）**：任务的授权对象从「一份计划」改为「一个范围」`TaskScope`（`scope/1`，`packages/core/src/verify/tasks/scope.ts`）= 目标描述 `objective`、资金币种 `inputAssetKey`、允许买入的资产集合 `outputAssetKeys`（1..8）、总额 `budgetCapRaw`、每笔上限 `perStepCapRaw`、`maxSteps`、`deadline`、`allowSell`、信任档位 `trustTier`（`platform_only | agent_data | agent_research`）、签发方式 `issuance`（`auto | agent`）、硬约束 `hardConditions`（条件 DSL 子集，≤ 8，不含 `thesis_holds`）。
- **签名只覆盖范围。** 已核实 `ChaconneVerifyPlanGuard.executeStep` 要求 `c.effectivePolicyHash == m.effectivePolicyHash`（否则 `CertificateBindingMismatch`），因此绑定口径改在服务端：`effectivePolicyHash` 的展开参数 `conditionsHash`（字段名沿用 K-10，语义改为**绑定哈希**）取值 = `scopeHash = keccak256(canonical(scope))`；mandate 的 `budgetCap / perStepCap / maxSteps / deadline / outputSetHash` 全部来自 scope（买入输出集 = 范围内全部资产的代币，`/v1/mandates` 登记体新增 `outputAssetKeys`，须包住 `legs`）。模板参数与计划条件（时段 / 间隔 / 事件窗口 …）在签名之外：`POST /v1/tasks/:id/conditions` 改计划不重签、授权不变（K-09 改写）；硬约束同类型不可被计划条件覆盖（409 `scope_locked`）。**范围本身不可改：放宽 = 建新任务重新签名。** 合约不改。
- **范围必须包住计划**：`outputAssetKeys ∋ params.outputAssetKey`、`budgetCapRaw ≥ 计划总额`、`perStepCapRaw ≥ 计划每笔`、`maxSteps ≥ 计划步数`、`deadline ≥ 计划期限`、卖出模板要求 `allowSell`；不满足 → 400 `invalid_scope`。缺省 scope = 计划本身（旧调用方零改动，签名口径已变：`mandateDraft.scopeHash` = `task.scopeHash` = `bindingHash`）。
- **`issuance=agent`**：monitor 只评估不签发、`prepare-step` 409 `issuance_by_agent`；签发只跟 agent 提交的交易意图走（批次 2 的 `POST /v1/tasks/:id/intents`）。**`trustTier`** 只决定 agent 决策记录里哪些依据可被采信并如何标注；硬约束与四道核验永远由平台做。
- **边界（写进 `scopeBoundary` 与页面）**：PlanGuard 只约束经该合约的交易；agent 持有完整私钥、绕开合约发的交易不在约束内。文案不得宣称「整个钱包无法绕过」。
- **证据包**：`verifyTaskBundleExtras` 对带 scope 的任务复算 `scope_hash`（由包内 `task.scope`）、比对 `scope_hash_in_policy_params`、并检查 `hard_conditions_in_set`；旧任务仍比对 `conditions_hash_in_policy_params`。
- **迁移 0019**：`packages/db/migrations/0019_task_scope.sql`，`verify_tasks` 增 `scope_json`、`scope_hash`（可空；旧行 null = 绑定 `conditions_hash`）。MCP `create_task` 增可选 `scope`；网页表单折叠区「授权范围」发 `scope`（只发用户明确设置的项）。

**CV-D16 批次 2（2026-09-25，交易意图 + 决策记录）**：`packages/core/src/verify/tasks/intents.ts`。agent 提交的是「意图 + 决策记录」，不是「一笔交易」；Chaconne 做四道核验后才签步骤证书：
- **facts 事实分拣**：`decision.claims[]` 每条按 `kind` 分类——`platform_fact`（须带 `source.evidenceId`，与本次核验的证据 id 核对 → `platform_verified` / `platform_unknown_evidence`）、`agent_data`（agent 自带、有来源 → `agent_provided_unverified`）、`agent_research`（研究结论 → 同上）。信任档位决定可采信种类：`platform_only` 只 `platform_fact`；`agent_data` 加 `agent_data`；`agent_research` 全部。出现不可采信的依据 → `DECISION_BASIS_NOT_ADMISSIBLE`，意图拒绝且**不取报价、不签发**。**决策记录不是通行证**：它只被分类、标注、存档，从不放宽任何一道核验。
- **scope 授权**：`kind=sell` → `allowSell` 为假 `INTENT_OUT_OF_SCOPE`，为真 `SELL_MANDATE_REQUIRED`（卖出授权按资产另签，本批不签发）；`outputAssetKey ∈ scope.outputAssetKeys`、`amountInRaw ≤ perStepCapRaw`、≤ 剩余额度、`stepsDone < maxSteps`、未过期、LIVE 有当前授权（否则 `AWAITING_USER_SIGNATURE`）；硬约束 `scope.hardConditions` 用本次报价 / 参考价求值，不满足 → `HARD_CONSTRAINT_BLOCK` + 底层原因码。
- **execution 执行核验**：与工具箱 / 计划签发同一套引擎（`MandatesService.issueIntentStep`：证据采集带 `executorContract`、`buildReport`、`executionEligible`、WAIT / BLOCKED 规则同 `evaluate`），资产与金额由意图给出，不走 legs 计划；同 index 旧 PREPARED 步骤作废重签。
- **binding 绑定**：`certificate.effectivePolicyHash == mandate.effectivePolicyHash`、`mandate.conditionsHash == task.bindingHash`、输出代币在授权输出集内。
- 结果：`certified`（LIVE，返回 `guardCall` / `approval` / 证书，任务 → `STEP_PREPARED`，资金组在途占用）、`simulated`、`rejected`。时间线 `intent_certified` / `intent_rejected` / `intent_withdrawn`；通知 `task.intent_certified` / `task.intent_rejected`。**签证书 ≠ 发交易**：执行仍由 agent 调 `execute_next_step` / 浏览器钱包完成。
- **迁移 0020**：`verify_task_intents`（意图、决策记录、分拣、四道核验结果、计划偏离、步骤引用、本次证据 id）。原因码新增 `INTENT_OUT_OF_SCOPE` / `DECISION_BASIS_NOT_ADMISSIBLE` / `HARD_CONSTRAINT_BLOCK` / `SELL_MANDATE_REQUIRED`。

**CV-D16 批次 3（2026-09-25，唤醒通路）**：`packages/core/src/verify/tasks/agentTurn.ts`。只对 `scope.issuance=agent` 的任务：平台不按计划签发，而是在**观察变化**时开一个轮次 `AgentTurn {version, reason: observation_changed|ready_for_intent|step_confirmed, observationKey, summary, requestedAt, respondBy(+30 min), state, intentId, response}`，发通知 `task.agent_turn`（幂等键 `taskId:version`），然后等 agent。观察键 = 阻塞集合键 / `clear` / `step:<n>`：同键不重复开轮；agent 的回应（提交意图 → `intent_received`；`declined` / `needs_evidence` / `plan_revised` / `ended`）都是正常结果，写进轮次与时间线并发 `task.agent_status` 给 owner；过了 `respondBy` 没回应记 `no_response`（信息项，不做任何动作，下次观察变化再叫）。轮次与 agent 是谁无关：webhook / Telegram / MCP 轮询 `get_task` 都能拿到；平台从不替 agent 做决定。**迁移 0021**：`verify_tasks.agent_turn_json`。视图 `agentTurn`；时间线 `agent_turn` / `agent_<status>` / `agent_no_response`。

**CV-D16 批次 6（2026-09-25，目标式任务与产品结构）**：模板不再是「给 agent 的命令」而是「示例策略」。
- **目标式任务**：`POST /v1/tasks` 不传 `playbookId`（或传 `agent_goal`）= 目标任务：内置模板 `AGENT_GOAL_PLAYBOOK`（无条件、无计划），参数由 `scope` 合成（`inputAssetKey` 缺省登记表第一个资金币种；`outputAssetKey` = 范围第一个资产；`steps = maxSteps`，缺省总额 / 每笔；`perStepAmountRaw` = 每笔上限；`deadline` = 范围期限），`scope.trustTier` 缺省 `agent_data`、`issuance` 缺省 `agent`；缺 `objective / outputAssetKeys / budgetCapRaw / perStepCapRaw` → 400 `required_for_goal_task`。`params` 只透传策略类参数。
- **简报 `TaskBrief`**（`verify_tasks.brief_json`，迁移 0022；签名之外可改）：`strategy`（`StrategyVersion {version, text, by: owner|agent, at, note?}`）+ `strategyHistory`（≤ 50）+ `currentPlan {text, at}` + `watch {kinds}`（agent 签发的任务缺省 MACRO_TIER1 / EARNINGS / FED_SPEECH）+ `agent {name, acceptedAt, lastResponseAt}` + `exampleId`。`POST /v1/tasks/:id/brief` 给 owner；agent 通过 `agent-status`（`accepted` / `plan.text` / `strategy`）写。
- **事件驱动唤醒**：`evaluateTask` 对 agent 签发的任务另算事件观察键（关注种类、`[-6h, +48h]`，`${id}@${revision}:${upcoming|released}`）；键变化而阻塞集合不变 → `reason=event` 的新轮次，摘要区分「upcoming」与「scheduled time passed — verify the actual value yourself」（平台不一定有实际值，不得说成「已根据结果判断」）。`taskState.underlyingIds` 覆盖范围内全部资产。
- **页面结构**：`/agent` 主入口 = 「把目标交给 Agent」（目标 / 策略文本 + 三张示例策略只填文字 / 授权范围），「我的 Agent 任务」，其余（固定自动化工具、第一分钟、Crew、Missions）收进「更多」；旧链接 `?entry=buy|wait|compare` 仍可用。任务详情：授权范围 → 「Agent 正在怎样处理目标」（目标 / 策略版本 / 当前计划 / 最新判断 / 正在调查 / 下一次检查 / 资金进展 / 给 Agent 补充要求）→ 决策时间线 → 执行详情（计划条件折叠）。自主任务入口不显示卖出开关（卖出通路未闭环）。

**CV-D16 批次 7（2026-09-25，产品结构收敛 + 任务级决策记录）**：
- **页面只留三层**：任务层（`/agent` 目标委托、`/agent/tasks` 我的任务与记录、任务详情）；上下文层（事件 `/agent/events`、资金 `/agent/funds`、日志 `/agent/journal`）；核验层（验证决策记录 `/verify-bundle`、市场回放、公开板）。老的单笔核验 `/new`、规划 `/plan` 撤出普通用户入口，只在 `/developers` 留调试入口（能力仍由 agent 在意图核验里调用）；`/play` → `/start`、`/agent/lab` → `/agent/tasks`、`/me` → `/agent/tasks` 转向（旧链接与历史记录可访问，接口不删）。
- **任务证据包升级为决策记录（Task Decision Bundle）**：`TaskBundleExtras` 增 `brief`（策略全部版本、当前计划、关注事件、接管的 agent）、`agentTurn`、`agentIntents`（全部意图：决策记录、依据分拣、四道核验、计划偏离、签发的步骤）、`timeline`；`bundleHash` 覆盖全部键。`verifyTaskBundleExtras` 新增 `intents_belong_to_task`、`certified_intents_have_certificates`（certified 的意图必须在包内找到同 index 的步骤且包内有证书）、`certified_intents_passed_all_checks`、`strategy_versions_contiguous`。任务详情「执行详情」里可导出 JSON 并到 `/verify-bundle` 离线验证。字段名用 `agentIntents`，避开 v1 证据包已有的 `intents`（单笔 TradeIntent 签名）。
- **删除**：`DELETE /v1/tasks/:id`（见 §11.7），迁移 0023 `verify_tasks.archived_at`。
