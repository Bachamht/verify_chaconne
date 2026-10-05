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

---

## 12. v7 增补（Chaconne Agent 决赛升级，2026-10-02 冻结；Lane I）

> 来源：v7 开发计划 §2（2026-10-02 09:00 版）。本节是契约：路由、类型、表、环境变量、状态机以此为准；实现增补追加在本节末尾「12.15 实现增补」。
> 类型已落地 `packages/core/src/verify/contracts.ts` 末尾「v7 增补」区（只类型）；迁移 `packages/db/migrations/0025_v7_delegation_runtime.sql` + `verifySchema.ts` 已落地并由 `apps/verify-service/test/migration0025.test.ts` 验证（回填、部分唯一索引、在途 permit 唯一）。
> 冻结类型的落地差异：`MANDATE_STEP_STATES` 追加 `SUPERSEDED`，另导出 `LIVE_MANDATE_STEP_STATES`；轮次原因的四个新值先以 `V7_AGENT_TURN_REASONS` 导出，由 Lane A 并入 `tasks/agentTurn.ts` 的 `AGENT_TURN_REASONS`；新增通用 `Eip712TypedData`、`PermitDomainsFile`、`FaultSpec`、`StepReconcileVerdict`、`RevertClass`、`MarketEventV7`、`HOSTED_AGENT_MCP_TOOLS`。


约定不变：唯一类型事实来源 `packages/core/src/verify/contracts.ts`（只追加；新子模块只放纯函数、从 contracts 导入类型）；金额一律十进制字符串；链下时间 ISO-8601 UTC；哈希 keccak256 + `canon-1`（CV-D12：签名 / 哈希对象里不得出现浮点数，比例与价格一律十进制字符串）。新增核心子模块：`packages/core/src/verify/{delegation,execution,agent}/`，全部纯函数、带单测。冻结后改类型走 CV-D，由 Lane I 合并。

### 12.1 任务运行态（谁决策、谁执行、在等什么）

```ts
export const AGENT_MODES = ["hosted", "byo"] as const;   // hosted = Chaconne Agent；byo = 用户自带 Agent（MCP / API）
export const EXECUTOR_MODES = ["hosted", "agent_wallet", "browser"] as const;
// hosted = 平台执行身份（作业制）；agent_wallet = 用户 Agent 经 MCP execute_trade_intent 自己发（旧路径，无作业）；
// browser = owner 在网页逐笔发（旧路径，无作业）。「自跑 verify-executor 的自带执行者」移到赛后（勘误 #7）
export type Actor = "owner" | "agent:hosted" | "agent:byo" | "executor:hosted" | "system";

export type HostedAgentState =
  | "starting"         // 已指派，委托未完成或首轮未开始
  | "working"          // 有轮次在跑（currentActivity = 最近一次工具调用的人话）
  | "awaiting_fill"    // 最新意图已认证，执行作业未终结
  | "waiting"          // 在等：waitingFor（阻塞项 / 实际值未到 / 下次检查时刻）
  | "blocked_owner"    // 有阻塞型 needsOwner
  | "blocked_operator" // 模型不可用 / 执行身份 gas 低 / RPC 不可用（页面显示「平台在处理」）
  | "paused" | "ended";  // ended = Agent 报 ended 后的内部暂停（§12.6）
export type AgentPresence =
  | { mode: "hosted"; state: HostedAgentState; currentActivity: string | null; waitingFor: string | null; lastDecisionAt: IsoUtc | null; nextCheckAt: IsoUtc | null }
  | { mode: "byo"; state: "online" | "offline"; lastResponseAt: IsoUtc | null; nextCheckAt: IsoUtc | null }   // online = 10 分钟内有回应
  | { mode: "none"; state: "unassigned" };
export interface ExecutorStatus { mode: ExecutorMode | null; state: "ready" | "busy" | "paused" | "gas_low" | "offline" | "disabled"; address: EvmAddress | null; lastJobAt: IsoUtc | null }

export type NeedsOwnerCode = "delegation_incomplete" | "allowance_low" | "balance_low" | "permit_failed" | "revoke_pending" | "scope_exhausted" | "agent_ended" | "reclaim_allowance";
export interface NeedsOwnerItem { code: NeedsOwnerCode; blocking: boolean; text: { zh: string; en: string }; action: { kind: "sign_delegation" | "sign_permit" | "confirm_revoke" | "reclaim_allowance" | "create_new_task" | "resume_or_cancel" | "top_up"; itemId?: string } }
export type NeedsOperatorCode = "executor_gas_low" | "executor_offline" | "model_unavailable" | "rpc_unavailable" | "agent_budget_exhausted" | "integrity_alert" | "contract_paused";
export interface TaskRuntime { agentMode: AgentMode | null; executorMode: ExecutorMode | null; presence: AgentPresence; executor: ExecutorStatus; needsOwner: NeedsOwnerItem[]; needsOperator: NeedsOperatorCode[] }
```

`GET /v1/tasks/:id` 的视图新增 `runtime: TaskRuntime`、`delegation`（清单摘要）、`positions`（摘要）、`steps: { buy: { planned, confirmed }, sell: { confirmed } }`。`reclaim_allowance` 是非阻塞提醒（任务结束后链上额度 > 需要量时出现）。`scope_exhausted` = 预算 / 步数 / 期限用完，动作只有「建新任务」——范围永远不能放宽。

### 12.2 委托清单（P0-A）

```ts
export type DelegationItemKind = "mandate_buy" | "mandate_sell" | "permit";
export type DelegationItemStatus = "todo" | "submitted" | "confirmed" | "failed" | "not_needed";
export interface DelegationItem {
  id: string;                  // "buy" | "sell:<assetKey>" | "permit:<tokenAddress>"
  kind: DelegationItemKind;
  assetKey: string;            // buy = 资金币种；sell = 股票；permit = 被授权的代币
  title: { zh: string; en: string };
  explain: { zh: string; en: string };   // 这次签名允许什么、不允许什么（金额、合约、期限、能否撤回）
  typedData: Eip712TypedData | null;     // mandate 来自建任务时的草案；permit 在 GET 时按当前 nonce 与账本现算并登记为 ISSUED；failed 时为 null
  permitRequestId?: string;              // permit 项：本次 GET 登记的请求 id（POST 必须引用它）
  status: DelegationItemStatus;
  ref: string | null;          // mandateId / permitId
  txHash?: Hex | null;         // permit 上链交易（执行身份代付 gas）
  error?: { code: string; message: string };
}
export interface DelegationChecklist {
  taskId: string;
  items: DelegationItem[];
  counts: { signaturesNeeded: number; signaturesDone: number; userTransactions: number };   // 正常恒为 0；只有不支持 permit 的回退路径才 > 0，测试断言五个登记代币下为 0
  allowances: Array<{ token: EvmAddress; assetKey: string; onchainRaw: RawAmount; requiredRaw: RawAmount; pendingPermit: boolean }>;
  buyReady: boolean;                      // 本任务事实：买入授权 ACTIVE ∧ 本任务的资金币种 permit 项 confirmed 或 not_needed（不随别的任务登记而翻转）
  sellReady: Record<string, boolean>;     // 每只股票：卖出授权 ACTIVE ∧ 该股票 permit 项 confirmed 或 not_needed
  complete: boolean;                      // 全部项 confirmed 或 not_needed
}
```

- 签名顺序（向导固定）：`buy` → 各 `sell:<asset>` → 各 `permit:<token>`。permit 的 typedData 在 `GET /delegation` 时计算，**把本任务尚未登记的授权草案也计入账本**，向导能一次拿到全部 typedData、连续签完。
- **每一步的实时额度检查**：`buyReady` / `sellReady` 是委托完成的事实，不是额度保证。意图核验时另查 `allowance(owner, PlanGuard) ≥ amountIn`，不足 → `ALLOWANCE_INSUFFICIENT` + `needsOwner: allowance_low`（附一个按账本新算的 permit）。这样另一个任务登记授权不会让本任务停摆。
- LIVE 委托任务在 `buyReady` 之前保持 `AWAITING_AUTHORIZATION`（现有 `authorize` 在 mandate ACTIVE 时就转 ACTIVE——v7 委托任务改为等 permit 确认）；`buyReady` 首次为真 → ACTIVE + 开 `authorized` 轮次；`complete` 首次为真 → `task.delegation_completed`。

### 12.3 permit 与额度账本（D-091，CV-D20）

**域配置**：`apps/verify-service/config/permit-domains.xlayer.json`

```json
{ "version": "permit-domains/1", "chainId": 196,
  "entries": [ { "assetKey": "eip155:196:0x…", "token": "0x…", "name": "<链上 name() 原文>", "version": "<匹配成功的版本串>",
                 "domainSeparator": "0x…", "verifiedBlock": 0, "verifiedAt": "…",
                 "forkAcceptance": { "block": 0, "tx": "0x…" }, "sources": ["eth_call DOMAIN_SEPARATOR()", "eth_call name()", "<第二来源>"] } ] }
```

- 生成方法（Lane X 脚本 `scripts/permitDomains.ts`）：读 `name()`、`DOMAIN_SEPARATOR()`；先试 EIP-5267 `eip712Domain()`（AAPLx / USDG 实测回退，不可依赖）；再按候选（`version ∈ {"1","2"}`、不含 version 的域、官方源码里出现的其它写法）计算域分隔符，**与链上 `DOMAIN_SEPARATOR()` 完全相等才记录**。
- **最终判据 = 分叉上的真实接受**：在 anvil 分叉上用一把随机私钥按候选域签 permit 并调用 `permit(...)`，`allowance` 被设置即通过（permit 不要求余额），交易哈希记入 `forkAcceptance`。2026-10-02 链上预检已确认五个代币都实现了 `permit`（伪签名回「签名无效」而非「函数不存在」），所以域对不上 = 我们推导错了，要继续找候选，**不要**直接回退到 approve；只有分叉接受对所有候选都失败才允许回退（一笔用户 approve，`counts.userTransactions` +1，页面如实说明）。
- verify-service 启动时：对每条配置重算域分隔符，并经 RPC 读一次链上 `DOMAIN_SEPARATOR()` 比对；任一不等即对该代币关闭 permit（`permit_domain_unverified`）并告警。

**typedData**：`primaryType: "Permit"`，`types.Permit = [owner address, spender address, value uint256, nonce uint256, deadline uint256]`，`spender = PLANGUARD_ADDRESS`，`nonce = token.nonces(owner)`（GET 时读链），`deadline = now + 1800`（秒）。`deadline` 只是签名可提交的截止时间；额度上链后一直有效直到被改写。

**账本**（同一 `(owner, token, spender=PlanGuard)`）：

```
requiredRaw  = Σ_{m ∈ 未终结授权} max(0, budgetCap_m − spent_m)  +  Σ_{d ∈ 本任务未登记草案} budgetCap_d
               （未终结 = DRAFT / ACTIVE / PAUSED；spent 用链上 mandateState 镜像；卖出授权按股票代币单位单独记账）
permitValue  = requiredRaw + ceil(requiredRaw × 50 / 10_000)        // +0.5%：吸收退款与 rebasing 舍入
链上额度已 ≥ requiredRaw  → 该 permit 项 not_needed（省一次签名）
```

**发放与提交**：`GET /delegation` 为每个需要的 permit 登记一条 `verify_permits(state=ISSUED, value, nonce, deadline)` 并返回 `permitRequestId`。`POST /v1/tasks/:id/allowances {permitRequestId, signature}` 的校验（任一不过即拒绝，不入队）：请求存在且属于本任务、状态 ISSUED、未过 `deadline − 120 s`；`recoverTypedDataAddress(ISSUED 的 typedData, signature) == task.owner`；`nonce == 链上 nonces(owner)`（否则 409 `permit_nonce_stale`，向导重取）；同 `(owner, token)` 无在途 permit 作业（否则 409 `permit_pending`）；链上额度此刻仍 < `requiredRaw`（否则 409 `permit_not_needed`）。**value 以 GET 时发放的为准**，GET 与 POST 之间有成交也不会 422；发放值 ≤ `permitValue`，不存在无限额度。〔已由 §12.15「permit 发放值复核」修订：POST 时要求 value ≤ permitValue(当前需要量)，超出 → 422 `permit_value_too_high`〕

**代付限制**（执行身份的 gas 不能被白嫖）：只为 `executor_mode=hosted` 且 owner ∈ `HOSTED_OWNER_ALLOWLIST` 的任务代付；每 owner 每小时 ≤ `PERMIT_RELAY_PER_OWNER_PER_HOUR`(6)，全局每天 ≤ `PERMIT_RELAY_DAILY_MAX`(50)；超限 429。

**收回额度（owner 维度）**：`GET /v1/owners/:owner/allowances`（各代币链上额度、账本需要量、差额）与 `POST /v1/owners/:owner/allowances/reclaim {token}` → 发放一条 `purpose=reclaim` 的 ISSUED permit（value = 其余未终结授权的 `requiredRaw`，有未终结授权时 + 0.5%，没有则为 0），用户签名后同样走 `/allowances` 提交路径（`POST /v1/owners/:owner/allowances/submit`）。任务终结后若链上额度 > 需要量 + 0.5%，出现非阻塞 `reclaim_allowance`。残余额度只能被**仍有效且签过名的** mandate 使用（过期 mandate 合约直接拒绝），所以是低风险项，但要给用户一键清理；用户也可以自己发 `approve(PlanGuard, 0)`。

### 12.4 卖出授权（P1-A，D-092）

- **生成条件**：只对目标式买入任务（`playbookId=agent_goal`、`scope.issuance=agent`、买入方向）且 `scope.allowSell = true`、`AGENT_V7_SELL_ENABLED` 打开时生成；`target_sell` 等模板任务与 `issuance=auto` 任务不生成（避免出现永远不会就绪的清单项）。
- **收款人**：`allowSell` 或托管执行的任务要求 `recipient == owner`（买入送到 recipient、卖出从 owner 拉款；两者不同会让「链上余额」包含 owner 原有持仓）。建任务时校验，不满足 → 400 `recipient_must_be_owner`。
- **草案**：为 `scope.outputAssetKeys` 里每只股票生成一份卖出 TradeMandate：`inputToken = 股票代币`，`outputSetHash = hash([资金币种代币])`，`recipient = owner`，`budgetCap = perStepCap = sellCapRaw`，`maxSteps = scope.maxSteps`，`deadline = scope.deadline`，策略与 `effectivePolicyHash` 同买入授权（`conditionsHash` = `scopeHash`）。
- **上限公式**（股票代币最小单位，向上取整；P6 = 建任务时该股票「100 USDG 档」可执行单价 × 1e6 取整，来源 `/pub/market/xlayer` 快照或证据报价；资金币种按 1 USD 计——这是宽松上界，不是估值）：

```
budgetMicroUsd = budgetCapRaw × 10^(6 − stableDecimals)
sellCapRaw     = ceil( budgetMicroUsd × 2 × 10^tokenDecimals / P6 )     // 预算在「价格腰斩」时能买到的份额
P6 不可得 → 该卖出项 failed{price_unavailable}，POST /v1/tasks/:id/delegation/refresh 重试
```

- 〔本条与上限公式已由 §12.15「D-092 简化」修订：合约上限 = 委托时链上余额 + 公式；服务上限 = 链上余额〕页面同时写两个上限：「合约上限 X 股（你签的）」与「服务上限 = 本任务买入形成的持仓」。服务侧卖出只允许 `amountInRaw ≤ sellableRaw = min(任务净持仓, 链上余额)`；任务净持仓 = 买入 `received` 之和 − 卖出 `spent` 之和（与 `tracedFills` 口径一致）；`< POSITION_DUST_RAW`(1e9) 视为 0。
- **卖出的路由金额**：与现有 `nextStepJob` 一致，报价 / 路由按 `amountIn − SELL_INPUT_TOLERANCE_WEI` 取，步骤 `amountIn` 仍为全额（rebasing 输入少到 1 wei 时路由不会多拉）。
- **mandate nonce**：同一 owner 内唯一；`nonce = BigInt(Date.now()) × 100n + 序号`，登记前查重。`authorize` 的 `clientRequestId` 改为每项固定 `${taskId}:auth:${itemId}`（现有的 `…:auth:${mandateIds.length}` 会让重试变成 409）。
- 登记沿用 9/22 修正后的 `registerBody` 约定（`side=sell` 时 `mandateJson.inputAssetKey` 存资金币种、`legs[0]` 存股票，方向翻转）；新增列 `verify_mandates.side` 与 `asset_key`（**= PlanGuard 实际拉取的代币**：买入为资金币种、卖出为股票），查询不再依赖这个约定。
- **卖出授权从不触碰资金组账目**：不 `reserve`、不 `markPending`、不 `settle`、不 `onStepConfirmed` 记预算（现有代码会把股票单位的数额记进稳定币预算——必须加守卫与测试）。
- **绝不做计划驱动的卖出签发**：卖出授权只按意图签发；`nextStepJob` 对 `side=sell` 且挂在任务上的授权返回 null（否则会按 `sellCapRaw` 一次卖光，绕过 `sellableRaw`）。

### 12.5 执行作业与步骤生命周期（P0-B，D-089，CV-D21，CV-D24）

```ts
export const EXECUTION_JOB_KINDS = ["permit", "execute_step"] as const;
export const EXECUTION_JOB_STATES = ["QUEUED", "CLAIMED", "SENDING", "SENT", "CONFIRMED", "REVERTED", "EXPIRED", "FAILED", "CANCELLED"] as const;
export interface ExecutionJob { id: string; kind: ExecutionJobKind; taskId: string | null; mandateId: string | null; stepId: string | null; stepIndex: number | null; owner: EvmAddress; token: EvmAddress | null; state: ExecutionJobState; attempt: number; leaseUntil: IsoUtc | null; claimedBy: string | null; txHash: Hex | null; txNonce: string | null; validUntil: IsoUtc | null; errorCode: string | null; payload: PermitJobPayload | ExecuteStepJobPayload }
export interface ExecuteStepJobPayload { mandateId: string; stepId: string; stepIndex: number; validUntil: IsoUtc; ready: PreparedStepReady /* = mandates.pullStep 的 READY 体 */; fault?: FaultSpec }
export interface PermitJobPayload { permitId: string; owner: EvmAddress; token: EvmAddress; spender: EvmAddress; value: RawAmount; nonce: RawAmount; deadline: string; signature: Hex; fault?: FaultSpec }
```

**步骤行（`verify_mandate_steps`）规则变更**——这是防重复成交的根：
1. 新状态 `SUPERSEDED`。迁移 0025 把唯一约束 `(mandate_id, step_index)` 改为**部分唯一索引**：只约束「活」状态 `PREPARED / SUBMITTED / REORG_PENDING / CONFIRMED / UNKNOWN`。
2. **被取走过的行（`pulled_at` 非空）永不删除**：重签同一 index 时把它标 `SUPERSEDED`（保留证书、用于回执归因）；只有从未被取走的行可以删除重签（`DELETE … WHERE pulled_at IS NULL`）。
3. **到期判断用证书里签名的 `validUntil`**（`certificate_json.certificate.validUntil`），不用可变的 `valid_until` 列；被取走过的行只有在 `now > 签名 validUntil + EXECUTION_EXPIRY_MARGIN_S` 后才能转 EXPIRED。现有三处要改：`mandates.transition(PAUSED/CANCELLED)` 只作废**未被取走**的 PREPARED 行；`intents.withdraw` 只作废未被取走的行（已取走的：取消未进 SENDING 的作业，行保持在途直到过期）；`expireSteps()` 对已取走的行加上 margin，并跳过有 SENDING / SENT 作业的行。
4. **取走是原子的**：执行者领取时在同一事务里 `UPDATE verify_mandate_steps SET pulled_at = now WHERE id = ? AND pulled_at IS NULL AND state = 'PREPARED' RETURNING`；影响 0 行 → 作业 CANCELLED。
5. **回执归因**：回执核实器与链上回填器拿到 `MandateStep` 事件后，除 `(mandateDigest, stepIndex)` 外还要核对 `evidenceHash`、`amountIn`、`outputToken` 与步骤行一致；不一致 → 在同 index 的 SUPERSEDED 行里找匹配的那条，把成交记到它（及其意图）名下、活行转 SUPERSEDED；都不匹配 → `integrity_alert`。成交永远记在真正被执行的那张证书上。

**作业状态转移（只有这些合法；core `canTransitionJob` + 单测）：**

| 从 → 到 | 触发 | 条件 |
|---|---|---|
| QUEUED → CLAIMED | `POST /v1/executor/claim` | `attempt += 1`，租约 90 s；同时原子取走步骤（上条第 4 点）；同一授权同时最多 1 个 CLAIMED / SENDING / SENT |
| QUEUED → EXPIRED | 清扫器 | execute_step：签名 `validUntil` 剩余 < 20 s 仍未被领取；permit：`deadline` 剩余 < 120 s |
| QUEUED → CANCELLED | 暂停 / 意图撤回 / 被新意图取代 / 接管切换 | 与意图状态变更在同一事务 |
| CLAIMED → QUEUED | 执行者事件 `abandoned`，或清扫器（租约过期） | 未进入 SENDING；证书剩余 ≥ 20 s |
| CLAIMED → SENDING | 执行者事件 `sending {rawTxHash?, nonce?, rawTx?}` | **发送提交点**：服务端复核——任务未暂停、步骤仍是活行且由本作业取走、签名 `validUntil` 剩余 ≥ `EXECUTOR_MIN_CERT_REMAINING_S`(8)、attempt 匹配；任一不满足：回 409 `not_allowed_now` **并当场**把作业转 CANCELLED 或 EXPIRED（不等租约），执行者不得广播。EOA 模式必须带 `rawTxHash / nonce / rawTx`；`okx_agentic` 模式三者可空 |
| CLAIMED → FAILED | 执行者事件 `preflight_failed {code, revert?}` | 本地或链上预检失败（下表失败分类） |
| CLAIMED → EXPIRED | 清扫器 | 租约过期、未进 SENDING、证书剩余 < 20 s（从未广播，安全） |
| SENDING → SENT | 事件 `sent {txHash}` | 广播成功或按哈希查到交易；服务端调用内部 `recordJobSubmission(stepId, txHash)`（**不走**带调用方鉴权、按 index 查找、会对 EXPIRED 抛 409 的 `recordSubmission`）→ 步骤 SUBMITTED |
| SENDING/SENT → CONFIRMED | 回执核实器（execute_step：6 确认 + 事件归因通过）；permit：回执里 `Approval(owner, PlanGuard, value)` | permit 不读余额判定（避免与其它任务的步骤竞争）；若某代币 permit 不发 Approval（分叉上先验证），退回按回执区块号读 `allowance` |
| SENDING/SENT → REVERTED | 回执 status 0 | 解码 revert → 失败分类 |
| SENDING/SENT → EXPIRED | 对账器 | `reconcileStep` 判定 EXPIRED |
| SENDING/SENT → CONFIRMED（permit 被抢跑） | 对账器 | 签名已被他人上链（`nonces` 已前进）且链上存在该 owner、spender、value 的 Approval → 视为确认；否则 FAILED `permit_nonce_consumed` → `needsOwner: permit_failed` |

- execute_step 作业在 `intents.submit` 拿到 `step` 后立即为 `executor_mode=hosted` 的任务创建（`step_id` 唯一）；**清扫器**每 2 s 为「托管执行任务里 PREPARED、未取走、无作业」的步骤补建作业。
- **作业制任务不交出 READY 体**：`intents.submit` 对 `executor_mode=hosted` 的任务不调 `pullStep`、响应改为 `execution: { mode: "hosted", jobId }`；`GET …/intents/:id?withStep=1` 对它们回 409 `platform_executes`；MCP `execute_trade_intent` 回 `not_applicable: platform executes`。`agent_wallet` / `browser` 模式照旧取走 READY 体（签发闸门与链上回填对它们同样生效）。
- **挂在任务上的授权不能绕过任务**：`POST /v1/mandates/:id/prepare-step` 与 `/resume` 对 `task_id` 非空的授权回 409 `task_bound_mandate`（暂停 / 取消仍允许——停止永远可以）。
- **意图被取代**：同一授权的新意图签发时，若旧意图的步骤从未被取走，旧意图转新状态 `superseded`，其作业 CANCELLED——同一事务。
- 领取顺序：permit 作业优先；某 `(owner, token)` 有在途 permit 时，以该代币为输入的 execute_step 暂不领取。

**对账决策（core 纯函数 `reconcileStep`，表驱动单测）：**

```
输入：stepIndex, signedValidUntil, chainHeadTs, chainSteps(mandateState.steps), receipt(null | {status, confirmations}), confirmationsRequired(=6), marginS(=15)
receipt.status == success ∧ confirmations ≥ confirmationsRequired → CONFIRMED_BY_RECEIPT
receipt.status == success ∧ confirmations <  confirmationsRequired → WAIT
receipt.status == reverted                                       → REVERTED
chainSteps  > stepIndex                                          → EXECUTED_ELSEWHERE   // 按 MandateStep 日志回填并归因，绝不重发
chainHeadTs > signedValidUntil + marginS                         → EXPIRED              // 此后任何带该证书的交易必被合约拒绝（CertificateExpired）
其它                                                              → WAIT
```

关键性质：PlanGuard 对 `block.timestamp > validUntil` 一律回退，所以**签名里的证书有效期就是不确定窗口的上界（≤ 120 s）**；过了窗口且链上步序没动，就可以确定这一步没有执行。

**签发闸门（改 `MandatesService`）——给授权 M 的第 n 步签发前，按顺序：**
1. 链上 `mandateState(digest).steps` > 库里 `stepsDone` → 先跑链上回填，再评估。
2. 存在 (M, n) 的活行为 SUBMITTED / REORG_PENDING → WAIT `STEP_AWAITING_CONFIRMATION`（已有）。
3. 存在 (M, n) 的**任意状态**的行满足 `pulled_at` 非空且 `now ≤ 签名 validUntil + marginS` → WAIT `EXECUTION_IN_FLIGHT`（`nextCheckAt = 签名 validUntil + marginS`）。
4. 存在 (M, n) 的作业处于 SENDING / SENT → WAIT `EXECUTION_IN_FLIGHT`。
5. 以上都不成立：未被取走的旧行删除；被取走过的旧行标 SUPERSEDED；然后重签。

**链上回填器**（服务 worker，每 `CHAIN_RECONCILE_INTERVAL_MS`=30 s 扫近 48 h 有活动的授权，签发前也同步跑一次）：读 `mandateState(digest)`；`steps > stepsDone` → `eth_getLogs(MandateStep, topics=[sig, owner, mandateDigest])`，`fromBlock` = 授权登记时记下的区块号（`verify_mandates` 新列 `from_block`），按 2 000 区块分页 → 缺失的 index 按上面第 5 点归因后 upsert 为 CONFIRMED → 更新 `spent / stepsDone` → 走 `withBudgetSettlement` 包装的同一回执路径（结算只发生一次）→ 触发 `onStepConfirmed`。幂等。覆盖浏览器钱包、agent-wallet、执行者漏报等所有情况。

**自动重签（只对时效类失败）**：失败分类为 `retry_new_cert` 时，服务端对同一意图自动重签一次（`AUTO_RECERTIFY_MAX=1`，意图创建后 `AUTO_RECERTIFY_WINDOW_S=300` 内），**新报价重新过四道核验**；仍失败才开 `execution_failed` 轮次交给 Agent。价格类失败从不自动重签——价格变了，要不要换数量是 Agent 的决定。

**失败分类**（core `classifyRevert`：选择器由 `abi/ChaconneVerifyPlanGuard.json` 加上 OZ v5 `ERC20InsufficientAllowance / ERC20InsufficientBalance`、`Error(string)`、`Panic(uint256)` 生成；测试断言 PlanGuard ABI 每个 error 都有归类）：

| 类 | 错误 | 处理 |
|---|---|---|
| `retry_new_cert` | `CertificateExpired`、`StepExpired`、预检「证书剩余不足」、`QUOTE_TOO_OLD` | 自动重签一次 → 再失败开 `execution_failed` 轮次 |
| `wait_clock` | `CertificateNotYetValid` | 时钟偏差：等 10 s 再预检，不重签；三次仍失败 → `integrity_alert` |
| `replan` | `InsufficientOutput`、`RecipientShortfall` | 不重签；`execution_failed` 轮次（附 received / minOut） |
| `liquidity` | `RouterCallFailed` | 退避 60 s；`execution_failed` 轮次 |
| `chain_ahead` | `StepOutOfOrder` | 跑链上回填；不重试 |
| `scope` | `StepsExhausted`、`BudgetExceeded`、`PerStepCapExceeded`、`OutputNotInSet`、`MandateExpired`、`MandateNotYetValid` | 服务侧核验漏网 = 缺陷：`integrity_alert` + 轮次 |
| `terminal` | `MandateRevokedError`、`MandateNonceAlreadyUsed` | 停止该授权；交给撤销流程 |
| `allowance` / `balance` | 预检读到 `allowance < amountIn` / `balanceOf(owner) < amountIn`；OZ `ERC20Insufficient*`；代币的 `Error(string)` 额度 / 余额文案 | `needsOwner: allowance_low / balance_low`；不重试 |
| `paused` | OZ `EnforcedPause` | `needs_operator: contract_paused` |
| `bug` | `InputTransferShortfall`、`InputTransferExcess`、`OverSpent`、签名 / 绑定 / 白名单 / 计算类其余全部 | 停止该授权签发；`integrity_alert`；告警运营者 |
| `unknown` | 解不出 | 不重试；轮次 + 告警 |

**执行身份**：执行者 id = 它的链上地址（EOA 或 Agentic Wallet 地址），跨重启不变；心跳带每次启动随机生成的 `instanceId`，服务端在 `verify_executor_status` 上维持单实例租约（90 s）——同一地址的第二个进程领取时回 409 `executor_instance_conflict`，避免 nonce 打架；崩溃重启后按地址取回自己 SENDING / SENT 的作业。

**故障注入（演练，D-095）**：`POST /v1/ops/faults`（运营者 key，且 `FAULT_INJECTION_ENABLED=true`）给下一个匹配作业挂一次性 `fault`：
- `cert_void`：执行者领取后等到证书剩余 < 8 s 再走发送提交点 → 被拒（作业当场 EXPIRED）→ `retry_new_cert` → 自动重签 → 成交一次。
- `receipt_delay`：执行者广播后 90 s 内不报回执、不查回执 → 服务端闸门 3 / 4 阻止重签 → 回执核实器确认 → 成交一次。
- `rpc_timeout`：执行者广播后、报 `sent` 前人为抛错并重启循环 → 按 `rawTxHash` 找回 → 报 `sent` / `receipt` → 不重发。
- `double_claim`（只在分叉 / 本地）：人为让租约过期，第二个执行者（另一地址）领取 → 旧 attempt 的事件 409；若两者都广播，链上 `StepOutOfOrder` 只让一笔成功，回执归因到真正执行的那张证书。
故障只会造成延迟或过期，**不能绕过任何核验**；生产环境未挂故障时这些分支不可达（测试断言）。

### 12.6 Agent 运行时（P0-C，D-090，D-093，CV-D23，CV-D25）

**轮次原因**新增：`assigned`（SIMULATION 观察任务创建时、或对已在运行的任务切换为托管 Agent 时立即开一轮）、`scheduled`（到达 Agent 自定的 `nextCheckAt`）、`data_arrived`（关注事件的实际值入库）、`execution_failed`（作业 EXPIRED / FAILED / REVERTED 且未被自动重签消化）。LIVE 委托任务的第一轮沿用现有 `authorized`（在 `buyReady` 时开）。

**轮次与动作的绑定**：
- 交易意图与状态报告的请求体新增 `turnVersion`；服务端只关闭**同版本**的轮次。若期间已开出更新的轮次，动作照常生效并记在它自己的版本上，新轮次保持打开（不再出现「上一轮的回答把新唤醒吞掉」）。
- 托管轮次每个 `(taskId, turnVersion)` **只接受一个终结动作**；第二个回 409 `turn_already_answered` 并带回已记录的动作。
- `report_agent_status`、`remember_note`、`add_thesis_review_item` 增加 `clientRequestId`（服务端按 `(taskId, clientRequestId)` 去重）；托管 Agent 一律用 `h:<runId>:<seq>`。
- 状态报告可选字段：`nextCheckAt`（ISO，∈ [now+60 s, scope.deadline]）、`invalidation`（≤ 500 字：什么情况会让我改主意）；交易意图体同样可带 `nextCheckAt`。存进 `verify_tasks.next_agent_check_at`；monitor tick 到点开 `scheduled` 轮次（观察键 `sched:<iso>`）。
- **`ended` 的唯一含义**：Agent 认为本任务目标已完成或不值得继续 → 服务端走**内部路径**把任务转 PAUSED（`paused_by = "agent"`，不调用需要 owner 身份的 `transition`），不再开新轮次，presence = `ended`，`needsOwner: agent_ended`（「恢复让它继续」或「取消并收回额度」）。不转 COMPLETED；MCP 工具描述同步改。

**轮次令牌（CV-D25，防跨租户）**：
- `POST /v1/agent/claim` 为每次领取返回一次性 `runToken`（32 字节随机，库里只存 sha256），绑定 `(runId, taskId, attempt, leaseUntil)`。
- verify-agent **每个轮次单独启动一个 verify-mcp 子进程**，env 只有 `VERIFY_SERVICE_URL`、`VERIFY_API_KEY`（托管 Agent key）、`VERIFY_RUN_TOKEN`；verify-mcp 的 `VerifyClient` 在设置了 `VERIFY_RUN_TOKEN` 时附加请求头 `x-agent-run-token`（新增约 10 行，带测试）。
- 服务端：`agent:hosted` 的每个任务类请求都必须带有效令牌；路由里的任务（或理由卡所属任务）≠ 令牌绑定的任务 → 403；attempt 过期或租约过期 → 409。
- verify-agent 在转发工具调用前把参数里的 `taskId` 改写为本轮任务、拒绝不属于本任务的 `thesisId`（纵深防御）。

**轮次记录**：

```ts
export const AGENT_RUN_STATES = ["CLAIMED", "RUNNING", "COMPLETED", "INCOMPLETE", "FAILED", "CANCELLED"] as const;
export interface AgentRunStep { seq: number; kind: "model" | "tool"; name?: string; argsHash?: Bytes32; resultHash?: Bytes32; argsPreview?: string; resultPreview?: string; tokensIn?: number; tokensOut?: number; latencyMs: number; at: IsoUtc; error?: string }
export interface AgentRunSummary {
  runId: string; taskId: string; turnVersion: number; attempt: number; turnReason: AgentTurnReason; mode: "LIVE" | "SIMULATION";
  model: string; promptHash: Bytes32;            // prompts/system.md 的内容哈希
  startedAt: IsoUtc; endedAt: IsoUtc | null; state: AgentRunState;
  action: { kind: "intent" | "status"; ref: string; status: string } | null;
  decisionSummary: string;                        // ≤ 280 字，取自 rationale / note
  nextCheckAt: IsoUtc | null; invalidation: string | null;
  toolCalls: Array<{ name: string; argsHash: Bytes32; resultHash: Bytes32 }>;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsdMicros: string };
  prevRunHash: Bytes32 | null; runHash: Bytes32;
}
// runHash = hashCanonical({ v: "agent-run/1", prevRunHash, taskId, turnVersion, attempt, model, promptHash, toolCalls, action, decisionSummary, nextCheckAt })
```

- 每个 `(taskId, turnVersion)` 一行；模型故障导致的 FAILED 可被再次领取（同一行 `attempt += 1`，最多 3 次）。**哈希链覆盖所有带动作的轮次（COMPLETED 与 INCOMPLETE）**，按完成时间串接。
- 预览（`argsPreview` / `resultPreview`）每条 ≤ 2 KB，写入前过密钥扫描（SEC-05）；完整模型消息只存 `verify_agent_runs.messages_json` 用于续跑（≤ 256 KB，超出截断最旧的工具结果），**不进证据包、不对外**。续跑时先查本轮是否已有记录的终结动作，有就直接收尾。
- 任务记忆：`verify_agent_memory`，≤ 20 条 × 2 KB，先进先出。

**成本与节流（在 verify-service 执行）**：价格与上限变量放在 **verify-service** 的 `.env`（verify-agent 只上报 token 用量，由服务端算成本）；`HOSTED_AGENT_ENABLED=true` 但价格变量缺失 → 托管 Agent 不启用并告警（否则上限形同虚设）。日上限分开：`AGENT_DAILY_USD_CAP_PER_TASK`、`AGENT_DAILY_USD_CAP_LIVE_TOTAL`、`AGENT_DAILY_USD_CAP_SIM_TOTAL`——观察模式花不到 LIVE 的预算。低优先级原因（`observation_changed`、非实际值的 `event`）同一任务两轮间隔 ≥ `AGENT_MIN_RUN_INTERVAL_S`(600)；`assigned / authorized / data_arrived / execution_failed / step_confirmed / scheduled` 不受限。

**决策上下文** `GET /v1/tasks/:id/agent-context`（每轮第一条输入，也是工具 `get_turn_context`）：

```json
{ "now": "…", "session": { "label": "US_REGULAR|PRE|POST|CLOSED", "nextOpen": "…", "nextClose": "…" },
  "task": { "id": "…", "mode": "LIVE|SIMULATION", "status": "…", "objective": "…", "strategy": { "version": 3, "text": "…", "by": "owner|agent" },
            "scope": { "inputAssetKey": "…", "outputAssetKeys": ["…"], "budgetCapRaw": "…", "perStepCapRaw": "…", "maxSteps": 5, "deadline": "…", "allowSell": true, "trustTier": "agent_data", "hardConditions": [] } },
  "turn": { "version": 7, "reason": "data_arrived", "summary": "…", "blockers": [ { "code": "…", "text": "…" } ] },
  "budget": { "buyRemainingRaw": "…", "buyStepsLeft": 3, "allowanceRaw": { "<token>": "…" }, "sellReady": { "<assetKey>": true } },
  "positions": [ { "assetKey": "…", "netRaw": "…", "sellableRaw": "…", "avgCostUsd": "…" } ],
  "lastIntent": { "id": "…", "status": "…", "job": { "state": "…", "errorCode": null } },
  "recentRuns": [ { "at": "…", "action": "…", "decisionSummary": "…", "nextCheckAt": "…" } ],
  "memory": [ { "at": "…", "text": "…" } ],
  "thesis": { "id": "…", "status": "holds|invalidated|unknown", "premises": [ { "id": "…", "kind": "machine|research|timing", "text": "…", "status": "…" } ] },
  "events": [ { "id": "…", "name": "…", "dataStatus": "…", "outcome": { "…": "…" } } ],
  "evidence": [ { "evidenceId": "…", "kind": "market_context|market_event|…", "observedAt": "…", "summary": "…" } ] }
```

`evidence[]` 与 `POST /v1/tasks/:id/quotes` 返回的证据写入 `verify_task_evidence`（15 分钟内有效）。**事实分拣扩展（CV-D23）**：`triageClaims` 在本次核验证据之外，也承认该任务 15 分钟内 `verify_task_evidence` 里的 evidenceId（标签仍是 `platform_verified`，附 `observedAt` 与年龄）——Agent 自然会引用它刚看过的报价与上下文，这些引用应当可核。

**报价** `POST /v1/tasks/:id/quotes`：`items ≤ 3`，每项 `{side: buy|sell, assetKey ∈ scope, amountInRaw ≤ 对应每笔上限}`；复用证据提供者取证但**不签发、不落授权评估**（卖出按 `amountIn − SELL_INPUT_TOLERANCE_WEI` 询价）；串行 + 30 s 缓存 + 每任务每小时 ≤ 20 次（OKX 报价限流）；返回 `{ executableUsdPerShare, priceImpactBps, minOutRaw, reference: {priceUsd, kind, ageS}, deviationBps, session, evidenceIds }`。

### 12.7 事件实际值（P0-D，CV-D22）

```ts
export interface EventOutcomeMetric {
  key: string;                 // 例："payrolls_change"、"unemployment_rate"、"ahe_mom"
  label: string;
  actual: string;              // 十进制字符串（canon-1 不允许浮点）
  unit: string;                // "thousands" | "percent" | "percent_mom" | "usd" …
  period: string;              // "2026-09"
  previous?: string;           // 本次发布里给出的上期值
  revisedPrevious?: string;    // 本次发布对上期值的官方修订（统计机构的修订，不是我们对自己采集值的更正）
  expectation?: { value: string; kind: "survey" | "market_implied"; source: string; at: IsoUtc };   // 没有就不写；没有预期值不得生成「超预期 / 不及预期」
}
export interface EventOutcome { metrics: EventOutcomeMetric[]; source: string; sourceUrl?: string; publishedAt: IsoUtc; fetchedAt: IsoUtc; provider: "crowsnest" | "finnhub" }
// MarketEvent 追加：outcome?: EventOutcome；服务端派生 outcomeRevision（不由 producer 给）
export type EventDataStatus = "upcoming" | "due_pending_data" | "data_arrived" | "revised";
export function eventDataStatus(ev: MarketEvent & { outcomeRevision?: number }, nowMs: number): EventDataStatus;
// 预定时刻未到 → upcoming；已过且无 outcome → due_pending_data；有 outcome 且 outcomeRevision = 0 → data_arrived；≥ 1 → revised
```

- **修订号规则**：现有 `mergeEventRevision` 丢弃 `revision` 不递增的更新，`verify_event_revisions` 按 `(id, revision)` 去重——所以 **crowsnest 每次改动 outcome（包括第一次附上）都必须 `revision + 1`**。服务端按 outcome 的规范化哈希派生 `outcomeRevision`：第一次出现 = 0（变更类型 `data_arrived`，发 `event.data_arrived`，**不**发 `event.revised`），之后哈希每变一次 +1（变更类型 `revised`）。`events/store.ts` 的变更分类增加 `data_arrived`。
- `validateMarketEvent` 扩展校验 `outcome`：metrics 1..12、`actual` 匹配 `^-?\d+(\.\d+)?$`、`unit` / `period` 必填。
- 任务的事件观察键从「按时间 upcoming / released」改为 `${id}@${revision}:${dataStatus}`：到点开「去核实」轮次（`due_pending_data`），实际值入库开 `data_arrived` 轮次，修订开 `event` 轮次并重评理由卡。
- Agent 自己抓到的外部资料只出现在它的决策依据里（`agent_data`，标「未核验」）；平台事件库只收 crowsnest / finnhub。

### 12.8 HTTP（verify-service；旧接口不变）

鉴权列：**O** = 代表 owner 的调用方（网站登录会话 `web:<owner>` 或该钱包签发的 key）；**H** = `agent:hosted` + 有效轮次令牌（只限令牌绑定的、`agent_mode=hosted` 的任务）；**E** = `executor:hosted`；**OP** = 运营者 key；**P** = 公开。新路由放在各 lane 的路由模块 `apps/verify-service/src/http/routes/v7<lane>.ts`（导出 `registerV7…(app, deps)`），`http/app.ts` 只由 Lane I 加一行挂载。

| 方法 路径 | 鉴权 | 用途 | 状态码 |
|---|---|---|---|
| `GET /v1/tasks/:id/delegation` | O, H(读) | 委托清单（§12.2）；为需要的 permit 登记 ISSUED 请求 | 200 / 403 |
| `POST /v1/tasks/:id/authorize`（改） | O | body 增 `itemId`（缺省 `buy`；`sell:<assetKey>`） | 201 / 409 / 422 |
| `POST /v1/tasks/:id/allowances` | O | `{permitRequestId, signature}`（§12.3） | 202 / 409 / 422 / 429 |
| `POST /v1/tasks/:id/delegation/refresh` | O | 重建失败的卖出草案 | 200 |
| `GET /v1/owners/:owner/allowances`、`POST …/allowances/reclaim`、`POST …/allowances/submit` | O | owner 维度的额度视图与收回（§12.3） | 200 / 202 / 409 |
| `POST /v1/tasks/:id/handover` | O | `{agent?: "hosted"\|"byo"\|null, executor?: "hosted"\|"agent_wallet"\|"browser"}`；不改范围、不需签名；只对 `scope.issuance=agent` 的任务；切换时取消 QUEUED / CLAIMED 作业，有 SENDING / SENT 作业时 409 | 200 / 403 `hosted_not_allowed` / 409 `issuance_not_agent` `execution_in_flight` / 503 `hosted_disabled` |
| `GET /v1/tasks/:id/activity?since&limit` | O, H | 增量活动流 `{items, nextCursor, runtime}` | 200 |
| `GET /v1/tasks/:id/timeline?cursor&limit` | O, H | 分页全量时间线 | 200 |
| `GET /v1/tasks/:id/runs`、`GET …/runs/:runId` | O, H | 轮次摘要 / 详情（工具调用只给预览与哈希） | 200 |
| `GET /v1/tasks/:id/positions` | O, H | 任务持仓（`boughtRaw, soldRaw, netRaw, onchainRaw, sellableRaw, avgCostUsd, coverage`） | 200 |
| `GET /v1/tasks/:id/agent-context` | O, H | 决策上下文（§12.6） | 200 |
| `POST /v1/tasks/:id/quotes` | O, H | 可执行报价（§12.6） | 200 / 429 |
| `POST /v1/tasks/:id/memory`、`GET …/memory` | O, H | 任务记忆（带 `clientRequestId`） | 201 / 200 |
| `POST /v1/executor/claim` | E | `{executor, instanceId, kinds?, max?=1}` → `{jobs}`（含本执行者未终结的 SENDING / SENT 作业，`recover:true`） | 200 / 204 / 409 `executor_instance_conflict` |
| `POST /v1/executor/jobs/:id/events` | E | `{attempt, type: sending\|sent\|preflight_failed\|receipt\|abandoned, …}` | 200 / 409 `stale_attempt` `not_allowed_now` |
| `POST /v1/executor/heartbeat` | E | `{executor, instanceId, mode, gasBalanceWei, chainHead, version}` | 204 / 409 |
| `POST /v1/agent/claim` | H（不需令牌） | `{worker, max?=1}` → `{runs: [{runId, runToken, taskId, turnVersion, reason, attempt, leaseUntil, resume?}]}` | 200 / 204 |
| `POST /v1/agent/runs/:runId/checkpoint`、`…/complete` | H | `{attempt, steps[], messages?, usage}` / `{attempt, state, action, decisionSummary, nextCheckAt, invalidation, usage}`；服务端算 runHash 链 | 200 / 409 |
| `POST /v1/agent/heartbeat` | H（不需令牌） | `{worker, version, model}`，供 `/v1/ops/status` 与 healthz 显示 | 204 |
| `POST /v1/ops/faults` | OP | 一次性故障（§12.5） | 201 / 403 |
| `GET /v1/ops/status` | OP | 执行身份 gas、作业队列、今日轮次与成本、模型可达、Agent 心跳 | 200 |
| `POST /v1/tasks/:id/share-activity`、`GET /pub/tasks/:shareId/activity` | O / P | 公开值守看板（复用 `verify_shares`，kind 增 `task_activity`；**只输出类别与时间，不含任何金额、数量、地址、自由文本**；服务端缓存 5 s） | 201 / 200 |

改动的旧接口：
- `POST /v1/tasks`：body 增 `agent: {mode}`、`executor: {mode}`；目标式买入任务 + `allowSell` 生成卖出草案；响应增 `delegation`。托管 Agent 或托管执行的 LIVE 任务要求 owner ∈ `HOSTED_OWNER_ALLOWLIST`；SIMULATION 托管任务对所有已登录钱包开放，但每钱包每天 ≤ `HOSTED_SIM_PER_OWNER_PER_DAY`(3)。服务 key **不能**建任务（现有 `ownerOf` 对无地址调用方信任 body 里的 owner——服务 key 被默认拒绝中间件挡在外面）。
- `POST /v1/tasks/:id/intents`：增 `turnVersion`；卖出体 `{kind: "sell", assetKey, amountInRaw}`（`outputAssetKey` 可省，给了必须等于资金币种）；可带 `nextCheckAt`；委托未完成 → `DELEGATION_INCOMPLETE`；额度不足 → `ALLOWANCE_INSUFFICIENT`；托管执行任务响应为 `execution: { mode, jobId }`。
- `POST /v1/tasks/:id/agent-status`：增 `turnVersion`、`clientRequestId`、`nextCheckAt`、`invalidation`；`ended` 按 §12.6 走内部暂停。
- `POST /v1/tasks/:id/pause`：托管执行任务的未进 SENDING 作业即时取消，响应 note：「托管执行：暂停在发送前生效；已广播的交易以链上为准」。
- `POST /v1/tasks/:id/resume`：**修复现有缺陷**——恢复授权时比较的是 `row.conditionsHash`，但 scope 任务的授权存的是 `scopeHash`，导致 scope 任务暂停后授权永远停在 PAUSED；改为比较 `bindingHashOf(row)`，补回归测试。
- `POST /v1/mandates/:id/prepare-step`、`/resume`：挂在任务上的授权 409 `task_bound_mandate`。
- `GET /v1/tasks/:id/intents/:intentId?withStep=1`：托管执行任务 409 `platform_executes`。
- `GET /v1/events`、`GET /v1/events/:id/revisions`：事件带 `outcome`、`outcomeRevision`、`dataStatus`。
- `/healthz`：增 `executor {enabled, address, gasOk, lastHeartbeatAt}`、`agent {enabled, lastHeartbeatAt, lastRunAt, costTodayUsdMicros}`。
- 网站代理 `apps/verify-web/app/api/verify/[...path]/route.ts` 的 `ALLOWED` 加入上表全部 O 路由；`/v1/executor/*`、`/v1/agent/*`、`/v1/ops/*` **不得**放行。代理的每 owner 限频（现为 60/min）对 `/activity` 单列 120/min；免费限流器的 `validKeys` 认得服务 key 的哈希。

### 12.9 鉴权模型（D-093，CV-D25，SEC 组验收）

- 新增 `authKind: "service"`：verify-service `.env` 只存 `VERIFY_EXECUTOR_KEY_SHA256`、`VERIFY_HOSTED_AGENT_KEY_SHA256`；请求 key 做 SHA-256 后常量时间比较 → `callerId = "executor:hosted" | "agent:hosted"`。`isOperator()` 对 `service` 恒为 false。服务 key 单独限频（agent 300/min，executor 600/min）。
- **默认拒绝中间件**：`authKind=service` 的请求先过显式路由白名单（`agent:hosted` → §12.8 中标 H 的路由 + 免费端点 + `/v1/agent/*`；`executor:hosted` → 只有 `/v1/executor/*`），不在白名单 → 403，**根本到不了各服务自己的鉴权**（建任务、事件影响动作、授权计划、组合、通知、资金组、调仓、key、理由卡创建、Lab 都在这里被挡）。SEC-02 / SEC-03 枚举 express 上注册的**全部**路由逐一断言。
- `TasksService.requireTask(callerId, id, op)`，`op ∈ {"read", "agent_write", "owner_write"}`：现有调用点**逐个**标注 op（缺省 `owner_write`）。`agent:hosted` 只在 `row.agentMode === "hosted"` 且轮次令牌绑定本任务时允许 `read` / `agent_write`。
- `agent_write` 只有：意图（提交 / 撤回）、agent-status（策略与计划修订都经它，走现有校验）、memory、quotes、理由卡 review-items。**不含** `/brief`、`/conditions`、compare-policies（owner 的配置面）。`owner_write`：authorize、allowances、delegation/refresh、owner 额度路由、handover、pause / resume / cancel、DELETE、share-activity。
- 白名单工具背后的其它服务（`ThesesService` 的 review-items、`LabService` 的 explain-wait、`/v1/context?taskId=`）同样接入令牌与 op 检查；每个工具在 SEC-02 有一例。

### 12.10 MCP 工具（verify-mcp 追加，51 → 58）

新增：`get_turn_context`、`get_executable_quotes`、`get_task_activity`、`get_task_positions`、`get_task_runs`、`get_delegation_status`、`remember_note`。改：`submit_trade_intent`（`turnVersion`、卖出 `assetKey`、`nextCheckAt`）、`report_agent_status`（`turnVersion`、`clientRequestId`、`nextCheckAt`、`invalidation`；`ended` 描述按 §12.6）、`add_thesis_review_item`（`clientRequestId`）、`execute_trade_intent`（托管执行任务回 `not_applicable`）。`VerifyClient` 支持 `VERIFY_RUN_TOKEN`。

**托管 Agent 暴露给模型的工具（13 个 = 12 个 verify-mcp 工具 + 本地 `fetch_source`）**：`get_turn_context`（含理由卡与相关事件）、`get_executable_quotes`、`get_market_context`、`get_events`、`explain_task_wait`、`get_task_positions`、`get_task_activity`、`add_thesis_review_item`、`submit_trade_intent`、`withdraw_trade_intent`、`report_agent_status`、`remember_note`，加本地 `fetch_source`。**不暴露**：建任务、授权、暂停 / 取消、执行、`watch_thesis`（新建理由卡与失效动作是 owner 的配置）、`get_my_event_impacts`（按 owner 鉴权，相关事件已在决策上下文里）、key、通知、资金组、调仓。工具列表做快照测试（A-15）。

### 12.11 数据表（迁移 `0025_v7_delegation_runtime.sql`，手写 SQL + `verifySchema.ts` + `meta/_journal.json`，沿用 0019～0024 的做法）

| 表 / 列 | 内容 |
|---|---|
| `verify_execution_jobs` | `id`(exj_) · `kind` · `task_id` · `mandate_id` · `step_id` UNIQUE · `step_index` · `owner_address` · `token_address` · `payload_json` · `state` · `attempt` · `lease_until` · `claimed_by`（执行者地址）· `instance_id` · `raw_tx` · `raw_tx_hash` · `tx_hash` · `tx_nonce` · `valid_until` · `fault_json` · `result_json` · `error_code` · `error_detail` · 时间戳；索引 `(state, lease_until)`、`(task_id)`、`(mandate_id, step_index)`；**部分唯一** `(owner_address, token_address) WHERE kind='permit' AND state IN ('QUEUED','CLAIMED','SENDING','SENT')` |
| `verify_permits` | `id`(prm_) · `task_id` · `item_id` · `owner_address` · `token_address` · `spender` · `value` · `nonce` · `deadline` · `typed_data_json` · `signature` · `purpose`(delegation\|reclaim) · `job_id` · `state`(ISSUED\|SUBMITTED\|CONFIRMED\|FAILED\|SUPERSEDED) · `tx_hash` · `allowance_after` · 时间戳 |
| `verify_agent_runs` | `id`(run_) · `task_id` · `turn_version` · `reason` · `mode` · `state` · `attempt` · `run_token_hash` · `lease_until` · `worker` · `model` · `prompt_hash` · `messages_json` · `action_json` · `decision_summary` · `next_check_at` · `invalidation` · `usage_json` · `cost_usd_micros` · `prev_run_hash` · `run_hash` · `started_at` · `ended_at` · 时间戳；UNIQUE `(task_id, turn_version)` |
| `verify_agent_run_steps` | `id` bigserial · `run_id` · `attempt` · `seq` · `kind` · `name` · `args_hash` · `result_hash` · `args_preview` · `result_preview` · `tokens_in` · `tokens_out` · `latency_ms` · `error` · `at`；UNIQUE `(run_id, attempt, seq)` |
| `verify_agent_memory` | `task_id` PK · `notes_json` · `updated_at` |
| `verify_agent_workers` | `worker` PK · `version` · `model` · `last_heartbeat_at` |
| `verify_task_timeline` | `id` bigserial · `task_id` · `at` · `actor` · `type` · `ref` · `note` · `data_json`；索引 `(task_id, id)`；迁移内用 `jsonb_array_elements(timeline_json)` 回填旧条目（actor = `system`） |
| `verify_task_evidence` | `task_id` · `evidence_id` · `kind` · `source`(agent_context\|quotes) · `record_json` · `created_at`；UNIQUE `(task_id, evidence_id)` |
| `verify_executor_status` | `executor` PK（地址）· `mode` · `active_instance` · `instance_lease_until` · `last_heartbeat_at` · `gas_balance_wei` · `chain_head` · `version` · `updated_at` |
| `verify_mandate_steps` 改 | 去掉 `verify_mandate_steps_mandate_step_uq`，改为部分唯一索引 `(mandate_id, step_index) WHERE state IN ('PREPARED','SUBMITTED','REORG_PENDING','CONFIRMED','UNKNOWN')`；状态新增 `SUPERSEDED`（列是 text，无需改类型） |
| `verify_tasks` +列 | `agent_mode` · `executor_mode` · `next_agent_check_at` · `delegation_json`（卖出草案与各项状态）· `sell_steps_confirmed` int default 0 · `paused_by` |
| `verify_mandates` +列 | `side` text not null default `'buy'` · `asset_key`（= PlanGuard 拉取的代币）· `from_block`；迁移内回填：`side` 取 `mandate_json->>'side'`；`asset_key` 买入取 `mandate_json->>'inputAssetKey'`、卖出取 `mandate_json->'legs'->0->>'outputAssetKey'` |
| `verify_task_intents` +列 | `asset_key` · `turn_version` · `attempts` int default 1 · `job_id` · `next_check_at`；状态新增 `superseded` |
| `verify_events` +列 | `outcome_json` · `outcome_hash` · `outcome_revision` int default 0 · `outcome_received_at` |

### 12.12 环境变量（所有新开关缺省关闭，部署验收后由运营者打开）

| 进程 | 变量（缺省） |
|---|---|
| verify-service（新增） | 开关：`HOSTED_EXECUTOR_ENABLED=false` · `HOSTED_AGENT_ENABLED=false` · `AGENT_V7_DELEGATION_ENABLED=false` · `AGENT_V7_SELL_ENABLED=false` · `AGENT_V7_OUTCOMES_ENABLED=false` · `AGENT_V7_COMPARE_ENABLED=false` · `FAULT_INJECTION_ENABLED=false`。准入：`HOSTED_OWNER_ALLOWLIST=`（逗号分隔小写地址；空 = 无人；`*` = 所有人）· `HOSTED_SIM_PER_OWNER_PER_DAY=3` · `PERMIT_RELAY_PER_OWNER_PER_HOUR=6` · `PERMIT_RELAY_DAILY_MAX=50`。服务 key：`VERIFY_EXECUTOR_KEY_SHA256=` · `VERIFY_HOSTED_AGENT_KEY_SHA256=`。执行：`PERMIT_DOMAINS_FILE=config/permit-domains.xlayer.json` · `EXECUTION_EXPIRY_MARGIN_S=15` · `EXECUTOR_MIN_CERT_REMAINING_S=8` · `CHAIN_RECONCILE_INTERVAL_MS=30000` · `AUTO_RECERTIFY_MAX=1` · `AUTO_RECERTIFY_WINDOW_S=300` · `POSITION_DUST_RAW=1000000000`。Agent 成本：`AGENT_PRICE_INPUT_PER_MTOK_USD` / `AGENT_PRICE_OUTPUT_PER_MTOK_USD` / `AGENT_PRICE_CACHE_READ_PER_MTOK_USD`（按官方价目填，不写死）· `AGENT_DAILY_USD_CAP_PER_TASK=2` · `AGENT_DAILY_USD_CAP_LIVE_TOTAL=15` · `AGENT_DAILY_USD_CAP_SIM_TOTAL=5` · `AGENT_MIN_RUN_INTERVAL_S=600`。告警：`OPERATOR_TELEGRAM_CHAT_ID=` |
| verify-executor（新进程） | `VERIFY_SERVICE_URL=http://127.0.0.1:8790` · `VERIFY_EXECUTOR_API_KEY` · `EXECUTOR_MODE=eoa\|okx_agentic` · `EXECUTOR_PRIVATE_KEY`（eoa）· `XLAYER_RPC_URL` · `EXECUTION_CHAIN_ID=196` · `PLANGUARD_ADDRESS` · `REGISTRY_FILE` · `EXECUTOR_MIN_OKB_WEI` · `EXECUTOR_POLL_MS=1000` · `EXECUTOR_MIN_CERT_REMAINING_S=8` · `FORBIDDEN_EXECUTOR_ADDRESSES` · `OKX_AGENTIC_CLI`（okx_agentic 模式） |
| verify-agent（新进程） | `VERIFY_SERVICE_URL` · `VERIFY_HOSTED_AGENT_API_KEY` · `ANTHROPIC_API_KEY` · `AGENT_MODEL`（运营者设，不写死）· `AGENT_MAX_TOOL_CALLS=12` · `AGENT_MAX_OUTPUT_TOKENS=4000` · `AGENT_RUN_TIMEOUT_MS=180000` · `AGENT_POLL_MS=2000` · `AGENT_FETCH_ALLOWLIST`（逗号分隔主机名）· `VERIFY_MCP_BIN=../../packages/verify-mcp/bin/chaconne-verify-mcp.mjs` |
| verify-web | `NEXT_PUBLIC_V7_UI=0`（构建期变量，改动需重建网页） |

### 12.13 原因码与通知

原因码新增（进 `REASON_CODES`）：`EXECUTION_IN_FLIGHT`（non-HARD，等到签名 `validUntil + margin`）、`DELEGATION_INCOMPLETE`（阻塞，`userActionRequired`）、`ALLOWANCE_INSUFFICIENT`（阻塞，`userActionRequired`）、`BALANCE_INSUFFICIENT`（阻塞，`userActionRequired`）、`SELL_NOT_DELEGATED`（阻塞）、`SELL_EXCEEDS_TASK_POSITION`（阻塞）、`EXECUTOR_UNAVAILABLE`（信息项）、`AGENT_LIMIT_REACHED`（信息项）、`EVENT_DATA_PENDING`（信息项）。`SELL_MANDATE_REQUIRED` 保留给没有卖出草案的旧任务。

通知新增（进 `NOTIFICATION_TYPES`，幂等键规则不变）：`task.delegation_completed`、`task.needs_owner`、`task.execution_failed`、`task.recertified`、`event.data_arrived`、`agent.run_completed`（缺省不推送，只进夜班日志）、`ops.alert`（只发运营者频道）。载荷照旧不含签名、证书、calldata、原始交易。

### 12.14 决策条目（已追加 the design log；运营者确认前相关开关保持关闭）

| 编号 | 决策 | 默认 |
|---|---|---|
| **D-089** | 平台执行身份：新进程 `apps/verify-executor` 持一把只装 gas 的密钥，交易白名单 `(to, selector)`，永不持用户资产；**修订 D-081「不做服务端 relayer」**；用户侧执行（MCP agent-wallet、浏览器逐笔）全部保留 | 采纳；`HOSTED_EXECUTOR_ENABLED` 在运营者确认前为 false |
| **D-090** | 托管 Chaconne Agent：新进程 `apps/verify-agent` 持模型 API 密钥与受限服务 key；型号由 `AGENT_MODEL` 决定；每轮记录型号、提示词哈希与成本；通过 verify-mcp 使用与自带 Agent 完全相同的工具；成本上限在 verify-service 执行 | 采纳 |
| **D-091** | 额度 = EIP-2612 permit 签名（执行身份代付上链，有准入与限频）；服务端额度账本；发放值 ≤ 需要量 + 0.5%；不做 approve 交易、不做无限额度；分叉接受失败的代币才回退为一笔用户 approve 并如实计数 | 采纳 |
| **D-092** | 卖出授权只对目标式买入任务、在委托时按资产各签一份；`recipient == owner`；合约上限 = 预算在价格腰斩时可买份额；服务上限 = 本任务持仓；不卖委托前已有持仓；不做计划驱动的卖出签发；卖出从不触碰资金组账目 | 采纳 |
| **D-093** | 服务 key 独立鉴权类型 + 默认拒绝路由白名单；托管 Agent 只对令牌绑定的托管任务做 read / agent_write；执行者 key 只访问 `/v1/executor/*`；`isOperator` 不认服务 key；三个进程三个系统用户 | 采纳 |
| **D-094** | Agent 外部抓取只允许 allowlist 官方源（https、解析后固定 IP 且非私网、无越界跳转、≤ 1 MB、≤ 10 s），正文标 `agent_provided` 并带抓取时间与 sha256；抓到的内容是数据不是指令 | 采纳 |
| **D-095** | 决赛演示：主网小额真金（演示钱包）；托管能力只对 `HOSTED_OWNER_ALLOWLIST` 开放；故障注入只在运营者 key + `FAULT_INJECTION_ENABLED` 下可用；OKX Agentic Wallet 执行模式跑通主网一笔才展示 | 采纳 |
| CV-D18 | 任务证据包 v3：多授权 + permit 记录 + 轮次哈希链 + 时间线摘要；v2 包照旧可验 | 记录 |
| CV-D19 | 事实更新：X Layer 自 2025-10-27 为 OP Stack（op-reth，Prague / Isthmus 创世激活，Jovian 2025-12-02），EIP-7702 协议层可用但无钱包入口；EntryPoint v0.6/0.7/0.8、Safe、Permit2 已部署，无公开 bundler | 记录 |
| CV-D20 | permit 域配置、分叉接受判据、启动双重比对（§12.3） | 记录 |
| CV-D21 | 签发闸门 + 链上回填 + `reconcileStep` + 发送提交点 + 作业制任务不交出 READY 体 + 挂任务授权不可绕过（§12.5） | 记录 |
| CV-D22 | `MarketEvent.outcome` / `dataStatus` 契约与修订号规则（§12.7） | 记录 |
| CV-D23 | 事实分拣承认任务 15 分钟内的 `verify_task_evidence`（§12.6） | 记录 |
| CV-D24 | 步骤行 `SUPERSEDED`、部分唯一索引、签名 `validUntil` 判到期、原子取走、回执按证书字段归因（§12.5） | 记录 |
| CV-D25 | 托管 Agent 轮次令牌、轮次与动作按 `turnVersion` 绑定、每轮一个终结动作、`ended` 内部暂停（§12.6） | 记录 |

### 12.15 实现增补

（各 lane 落地时超出本节的端点与字段，由 Lane I 裁决后追加在这里。）

**2026-10-02 · Lane I 汇总（Lane X / A / R / P 合并时报告的实现增补；以代码为准）**

1. **执行者心跳 `gasLow`**：`POST /v1/executor/heartbeat` 体 `{ executor, instanceId, mode, gasBalanceWei, chainHead, version, gasLow? }`。gas 阈值 `EXECUTOR_MIN_OKB_WEI` 只在执行进程里；`gasLow: true` → 服务端记入内存并在运行态给 `needsOperator: executor_gas_low`；执行进程同时停止领取。响应 204；同地址另一实例 → 409 `executor_instance_conflict`。
2. **`/healthz` 的 `executor` 段**：`executor: { enabled, address, gasOk, lastHeartbeatAt }`——`enabled = HOSTED_EXECUTOR_ENABLED ∧ PLANGUARD_ADDRESS`；`address` = 最近一次心跳的执行身份地址（链上公开）；`gasOk` = 该地址最近心跳未报 `gasLow`（无心跳为 `null`）；30 s 刷新。托管 Agent 段沿用 `agentHosted`。
3. **permit 提交的 409 码**（网页向导遇到即自动重新 GET）：`permit_request_expired`（请求状态 ≠ ISSUED，或已到 `deadline − 120 s`）、`permit_nonce_stale`、`permit_pending`、`permit_not_needed`；请求不属于本任务 / owner → 404 `permit_request_not_found`。
4. **owner 维度额度的响应形状**：`GET /v1/owners/:owner/allowances` → `{ owner, spender, allowances: [{ token, assetKey, symbol, decimals, onchainRaw, requiredRaw, excessRaw, reclaimSuggested, pendingPermit, permitSupported }], note }`；`POST /v1/owners/:owner/allowances/reclaim {token}` → `{ permitRequestId, token, value, valueRaw, typedData, requiredRaw, onchainRaw, note }`（签名后走 `POST /v1/owners/:owner/allowances/submit`，202）。只有该钱包本人（调用方代表该 owner）可读写，否则 403 `owner_forbidden`。
5. **任务视图 `steps` 形状**（v7 委托任务）：`steps: { planned, confirmed, lastConfirmedAt, buy: { planned, confirmed }, sell: { confirmed } }`；旧任务只有前三个字段。
6. **建任务的托管准入**：托管 Agent 或平台执行的 LIVE 任务，owner 不在 `HOSTED_OWNER_ALLOWLIST` → 403 `hosted_not_allowed`（接管切换同码）；观察模式（SIMULATION）托管任务每钱包每天 > `HOSTED_SIM_PER_OWNER_PER_DAY` → 429 `hosted_sim_limit`。
7. **任务证据包 v3 新字段**：`bundleVersion: "task/3"`、`mandates[]`（本任务全部授权段：买 + 各卖，含 SUPERSEDED 步骤与其证书）、`permits[]`（`{ id, itemId, owner, token, spender, value, nonce, deadline, typedData, signature, purpose, state, txHash, allowanceAfter }`）、`agentRuns[]`（轮次摘要，runHash 链；不含 messages）、`timelineDigest: { v: "timeline/1", count, hash }`（覆盖 `verify_task_timeline` 全部行）。v2 字段保留，v2 包照旧可验。
8. **夜班日志 Recap 的 `agent` 字段**：`recap.agent = { date, tz, window, taskIds, runs{total, byState, byReason, byMode, items}, actions, waits, fills, cost{totalUsdMicros, byMode, inputTokens, outputTokens, cacheReadTokens, runsWithoutCost}, faults, recoveries }`；当天没有托管轮次时不出现。
9. **活动流限频**：`GET /v1/tasks/:id/activity` 单独计数，每调用方 120 次 / 分钟，不占普通 60 次 / 分钟额度。
10. **MCP `execute_trade_intent`**：托管执行任务（服务端 `?step=1` 回 409 `platform_executes`）→ 返回 `not_applicable: platform executes`（结构化 `{ status: "not_applicable", reason: "platform executes" }`），不要求 agent-wallet 模式。

#### 12.15.1 执行身份费用预算（D-089 修订，运营者确认 2026-10-02 14:00；分支 v7/fees）

主要保护是**费用（OKB）**而不是笔数。成功、链上回退、permit 代付**全部计入**。verify-service 是权威方；verify-executor 另有每笔上限作为签名前的第一道闸。

**每笔上限（verify-executor，签名前强制）**：`packages/verify-exec/src/fees.ts` `assertFeeCaps`，在 `ExecSender.sign()` 里预估 gas（×1.3）与读费率之后、取 nonce 之前执行；任一超限 → `ExecTxError("fee_cap_exceeded")`，执行者上报 `preflight_failed {code: "fee_cap_exceeded", detail: "<gas_limit|max_fee_per_gas|max_priority_fee_per_gas|tx_fee> … > cap …"}`，不签名、不广播、不消耗 nonce。`SignedTx` 增 `maxFeeWei = gas × maxFeePerGas`（legacy = gasPrice）。

| verify-executor 变量 | 缺省 | 依据 |
|---|---|---|
| `EXECUTOR_MAX_GAS_LIMIT` | `1500000` | executeStep ≈ 61 万 gas（运营者简报 / 分叉口径）× 1.3 估算余量后再留约 2 倍 |
| `EXECUTOR_MAX_FEE_PER_GAS_WEI` | `200000000`（0.2 gwei） | 2026-10-02 只读 RPC 实测 baseFee 0.02 gwei（区块 72145255）的 10 倍 |
| `EXECUTOR_MAX_PRIORITY_FEE_PER_GAS_WEI` | `20000000` | 实测 `eth_maxPriorityFeePerGas` = 1 wei |
| `EXECUTOR_MAX_FEE_PER_TX_WEI` | `200000000000000`（0.0002 OKB） | 正常一笔 ≈ 79 万 gas × 0.024 gwei ≈ 0.000019 OKB；OP Stack 回执 `l1Fee` 实测 0 |
| `EXECUTOR_MIN_OKB_WEI` | **必填**（eoa 模式） | 未配置 / 0 / 非整数 → 拒绝启动 |

**OKB 预算（verify-service）**：

| verify-service 变量 | 缺省 | 含义 |
|---|---|---|
| `FEE_BUDGET_PER_OWNER_DAY_WEI` | `5000000000000000`（0.005 OKB） | 每个 owner 每个 UTC 日 |
| `FEE_BUDGET_PER_TASK_WEI` | `2000000000000000`（0.002 OKB） | 每个任务累计（含该任务的 permit 代付） |
| `FEE_BUDGET_PLATFORM_DAY_WEI` | `20000000000000000`（0.02 OKB） | 全平台每个 UTC 日 |
| `FEE_MAX_PER_TX_WEI` | `200000000000000` | 服务侧每笔上限；签名交易解析不了（如 okx_agentic 模式不带 rawTx）时按它预留 |
| `EXECUTION_PAID_FAILURE_PAUSE_N` | `2` | 连续付费失败暂停阈值（见下） |

四个金额必须 > 0（预算不能关闭；`loadConfig` 拒启）。`GET /v1/ops/status` 增 `feeBudget {day, limits, platformToday {usedWei, usedOkb, limitWei, remainingWei}, todayByState, ownersToday[≤20], pauseAfterPaidFailures}`（只给运营者）。

**账本表（迁移 `0026_v7_fee_budget.sql`，手写 SQL + `verifySchema.ts` + `meta/_journal.json`）**：

| 表 / 列 | 内容 |
|---|---|
| `verify_fee_ledger` | `id`(fee_) · `job_id` UNIQUE · `kind`(permit\|execute_step) · `task_id` · `owner_address` · `mandate_id` · `step_index` · `executor` · `day`（预留时的 UTC 日期 YYYY-MM-DD）· `state`(RESERVED\|SETTLED\|HELD\|RELEASED) · `reserved_wei` numeric(78,0) · `actual_wei` numeric(78,0) · `reserve_basis`(raw_tx\|per_tx_cap) · `gas_limit` · `max_fee_per_gas` · `raw_tx_hash` · `tx_hash` · `gas_used` · `effective_gas_price` · `l1_fee` · `outcome`(confirmed\|reverted\|unknown_after_send) · `created_at` · `settled_at` · `updated_at`；索引 `(owner_address, day)`、`(task_id)`、`(day)`、`(state)` |
| `verify_permits` +列 | `submitted_at`（ISSUED → SUBMITTED 的时刻，代付限频按它计数；迁移内对已有签名的行回填 `updated_at`） |

计入口径：RESERVED / HELD 按 `reserved_wei`，SETTLED 按 `actual_wei`，RELEASED 为 0。

**生命周期**：
- **预留**＝发送提交点（`CLAIMED → SENDING`）。在原有五项复核通过后，**同一个数据库事务**里：`pg_advisory_xact_lock(726100089)` → 解析 `rawTx`（`maxFeeOfRawTx`：gas × maxFeePerGas）→ 超 `FEE_MAX_PER_TX_WEI` → `fee_cap_exceeded` → 按 owner/日、任务累计、平台/日核对（已用 + 本笔最大费用 ≤ 上限）→ 写 RESERVED → 作业转 SENDING。另外 `rawTxHash` 必须等于 `keccak256(rawTx)`（否则 400 `raw_tx_hash_mismatch`）。崩溃恢复对同一 `rawTxHash` 再发 `sending`（SENDING → SENDING）不新增预留。
- **结算**：作业从 SENDING / SENT 进入 CONFIRMED / REVERTED → 服务端自己读回执：`gasUsed × effectiveGasPrice + l1Fee` → SETTLED（回执缺 `effectiveGasPrice` 时按预留额结算）。回执暂不可读 → 保持 RESERVED，清扫器（2 s）重试。
- **结果不明继续占用**：SENDING / SENT 期间保持 RESERVED；广播后被对账判 EXPIRED（或其它非确认终态）→ HELD，按预留额继续计入；48 h 内读到回执（交易后来上链）→ 按实际 SETTLED。
- **释放**：预留只发生在发送提交点，提交点之前的过期 / 取消（`EXPIRED-before-broadcast` / `CANCELLED`）本来就没有记录、不占预算；已广播的预留不会被自动释放。
- **超限**：发送提交点回 **409 `fee_budget_exhausted`**（`details: {scope: owner_day|task_total|platform_day, usedWei, limitWei, needWei, jobState: "FAILED"}`）或 **409 `fee_cap_exceeded`**（`scope: per_tx`）；作业当场 FAILED（`error_code` 同名），执行者不得广播（与其它 409 一样退回 nonce）。permit 作业同时把 permit 记录置 FAILED。

**permit 代付受理（`POST /v1/tasks/:id/allowances`、`POST /v1/owners/:owner/allowances/submit`）**：限频计数（每 owner 每小时 `PERMIT_RELAY_PER_OWNER_PER_HOUR`、全局每天 `PERMIT_RELAY_DAILY_MAX`，改按 `submitted_at` 计数）、费用预检（三个预算各留出一笔 `FEE_MAX_PER_TX_WEI` 的余量，否则 409 `fee_budget_exhausted`，owner 无需重签）、permit `ISSUED → SUBMITTED`、建作业，**在同一事务、同一把咨询锁下**完成——修正原来「先查后写」并发可越限的漏洞；任一步失败整笔回滚，permit 保持 ISSUED。

**费用护栏挡下时的表现**（`fee_budget_exhausted` / `fee_cap_exceeded`，含执行者预检报的 `fee_cap_exceeded`）：交易没有发出 → 不开 Agent 轮次、不让 owner 签名；`runtime.needsOperator` 增对应代码（core `NEEDS_OPERATOR_CODES` 追加 `fee_budget_exhausted`、`fee_cap_exceeded`；托管 presence 因此为 `blocked_operator`）；时间线 `execution_blocked_fee`（「没有发出、没有花 gas、你不需要签名，运营者已收到通知；签名范围不变」）；owner 通知 `task.execution_failed`（同样措辞）；运营者频道 `ops.alert`（`NotifyService.operatorAlert`）。这两个代码不再触发 `integrity_alert`。

**连续付费失败暂停**：同一 `(mandateId, stepIndex)` 在**当前意图**创建以来，「到过发送提交点（`raw_tx_hash` / `tx_hash` 非空）且以 REVERTED / EXPIRED / FAILED 结束」的作业数 ≥ `EXECUTION_PAID_FAILURE_PAUSE_N` → 不再自动重签换新交易（`AUTO_RECERTIFY` 不再排队），时间线 `execution_retry_paused`，开 `execution_failed` 轮次（`onExecutionFailed` 的 info 增 `consecutivePaidFailures`、`autoRetryPaused`，轮次摘要写明「自动重试已暂停，先复查报价 / 额度 / 策略」）。Agent 提交新意图即重新计数。网络超时后**查询或原样重播同一笔已签名交易**（执行者 `recover`）不产生新作业、不新增预留、不计入失败次数（测试覆盖）。

#### 12.15.2 permit 发放值复核修正（运营者确认 2026-10-02）

`submitPermit` 原比较 `value > permitValue(max(required, value))` 永不成立。改为 **`value ≤ permitValue(当前需要量)`**（当前需要量 + 0.5%），超出 → **422 `permit_value_too_high`**（`details: {valueRaw, requiredRaw, maxRaw}`），向导重新 GET 取一份按当前账本算的请求。需要量不变或变大时照常 202。

#### 12.15.3 D-092 简化：可卖出全部持仓（运营者确认 2026-10-02）

- 硬边界不变：签名里的 `scope.allowSell` 与可卖股票集合；`recipient == owner` 仍强制。取消「只卖本任务买入的部分」的服务侧限制，无额外开关。
- **合约上限**：`sellCapRaw = 委托时 owner 链上该股票余额 + ceil(budgetMicroUsd × 2 × 10^tokenDecimals / P6)`（core `sellCapRaw({…, holdingsRaw})`，返回另含 `boughtCapRaw` / `holdingsRaw`）。生成卖出草案时经 RPC 读余额；读不到 → 该项 `failed{balance_unavailable}`，`POST /v1/tasks/:id/delegation/refresh` 重试。permit 额度账本按新的 `budgetCap` 计（卖出 permit 的发放值相应变大）。
- **服务上限**：`amountInRaw ≤ 链上余额`（以及 ≤ 卖出授权每笔上限 / 剩余 / 步数 / 期限）。超出链上余额 → **`BALANCE_INSUFFICIENT`**（`detail.side = "sell"`、`balanceRaw`、`sellableRaw`）；链上余额读不到 → `SELL_EXCEEDS_TASK_POSITION`（`detail.note = "balance_unavailable…"`）。`SELL_EXCEEDS_TASK_POSITION` 码名保留兼容，**不再因「超出本任务净持仓」出现**。
- `GET /v1/tasks/:id/positions`：`netRaw`（本任务买入 − 卖出）照旧，仅供参考；**`sellableRaw` = 链上余额**（< `POSITION_DUST_RAW` 视为 0）。完成规则不变（买入授权 COMPLETED 且本任务净持仓 < dust）。
- 文案：卖出项说明「允许在到期前按策略把 AAPLx 换回 USDG，最多可卖出你的全部持仓；换回的 USDG 只进你的钱包」+ 期限 / 合约上限 / PlanGuard / 可撤销；托管 Agent 提示词第 8 条改为「按策略在签名范围内卖出，最多到全部持仓，绝不超过链上余额 / `sellableRaw`」。
