# 验收记录（Test Results）· 对照《验收与演示清单》58 条

> 更新：2026-09-20。状态：`通过` / `待执行` / `阻塞` / `不适用`。每条注明证据模式（LIVE / REPLAY / FIXTURE / FORK / SIMULATION）与可定位证据。
> 运行环境：macOS，Node 22.22.2，pnpm 11.9.0，Foundry 1.7.1；代码 `devday-2026` 分支。总测试：core 203 · verify-service 52 · verify-mcp 6 · verify-contracts 53（`pnpm -w test`）。

## PRE · 规格与依赖

| ID | 结果 | 证据 |
|---|---|---|
| PRE-01 | 通过 | `baseline.md`（tag `devday-baseline`=31b51bc，工作区干净） |
| PRE-02 | 通过 | `apps/verify-service/config/registry.xlayer.json` + `the address-approval log (internal)`（双来源 + 链上元数据） |
| PRE-03 | 通过 | `packages/core/src/verify/policy.ts`（三策略 v1.0.0、阈值、额度 2 次/300 s） |
| PRE-04 | 通过 | D-080（本地 design log）+ `apps/verify-service/src/attestation/signer.ts`（只签证书）+ 启动护栏 |
| PRE-05 | 通过 | `packages/core/src/verify/eip712.ts`、Guard 合约结构、`config/xlayer.json` |
| PRE-06 | 通过 | x402 SDK 锁版（express 0.1.1 / core 0.1.0 / evm 0.2.1）；官方客户端 SDK ↔ 本服务契约测试 2 例；**1952 真实结算成功（2026-09-21 07:13 布里斯班）**：付款人 0xbacb…0381 经 OKX facilitator 同步结算 $0.01 USD₮0 → 商户 0x5e79…e1bc，A2MCP 路径 tx `0x9a136580…` 与 /v1 report 路径 tx `0x1426fea9…` 均 status 1，订单 SETTLED→DELIVERED（settledAt 早于 deliveredAt） |
| PRE-07 | 通过 | `/v1/policies` 公示价格、退款口径；免费阶段价格 0 |
| PRE-08 | 部分 | 数据来源条款：OKX 开发者门户免费档、Finnhub 免费档；商业转售范围未核实（首版免费） |
| PRE-09 | 通过 | 主网 196 + 真实 xStocks 资产；运营者拍板小额演示 |
| PRE-10 | 部分 | 本地隔离库（pglite）+ 独立 .env；服务器独立库/角色按 deployment runbook 步骤执行中 |

## A · 数据口径与规则（14）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| D-01 | 通过 | FIXTURE | `verify.evaluate.test.ts` "同名代币不同地址 → ASSET_UNSUPPORTED" |
| D-02 | 通过 | FIXTURE + REPLAY | 无源时间 → SOURCE_TIME_MISSING；`live.test.ts` Finnhub 源时间透传 |
| D-03 | 通过 | FIXTURE | 休市/盘后/常规分支；`config.test.ts` lastCompletedTradingDate（假日） |
| D-04 | 通过 | FIXTURE | pyth_provisional → REFERENCE_PROVISIONAL |
| D-05 | 通过 | FIXTURE + LIVE 元数据 | decimals 不符 → REGISTRY_MISMATCH；rebasing 单位口径（registry unitSource） |
| D-06 | 待执行 | — | 公司行动跨事件混用：需真实 multiplier 变更样本 |
| D-07 | 通过 | FIXTURE + REPLAY | USD_CONVERSION_UNKNOWN；LIVE 用 OKX tokenUnitPrice |
| D-08 | 通过 | FIXTURE + REPLAY | 零输出/冲击超限/偏差超限；REPLAY 可执行单价 333.5 vs 336.13 |
| D-09 | 通过 | FIXTURE | SOURCE_CONFLICT（>50bps） |
| D-10 | 通过 | FIXTURE | QUOTE_TOO_OLD、SOURCE_TIME_FUTURE、REFERENCE_STALE |
| D-11 | 通过 | FIXTURE | routeSummary 含指令文本不改结论 |
| D-12 | 通过 | FIXTURE | 黄金样本 4 份、顺序无关、reportHash 可复现 |
| D-13 | 通过 | FIXTURE + REPLAY + **LIVE** | 休市 STRICT_LIVE → rejected(MARKET_OUTSIDE_REGULAR)；常规时段 LIVE 实测 eligible（2026-09-21 13:33Z，见下「STRICT_LIVE LIVE 通过记录」） |
| D-14 | 通过 | FIXTURE + REPLAY | REFERENCE_CONTEXT：official / cross_verified / provisional / missing 四分支 |

## B · API、MCP 与独立售卖（6）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| I-01 | 通过 | 隔离 HTTP | 缺 key 401、错 key 403、他人任务 404、通配 key 按地址隔离（`http.test.ts`） |
| I-02 | 通过 | HTTP 头 | `Cache-Control: private, no-store` + Vary；网页代理同样 no-store |
| I-03 | 通过 | LIVE 客户端 | 官方 SDK Client：InMemory + 真实 stdio 握手/发现/调用（`verify-mcp/test`） |
| I-04 | 部分 | LIVE 平台 | ASP #13803 首次审核被驳回（2026-09-21 中午查到；根因：OKX 客户端只认 200/402，空探测 400 被判端点不可达）。已修（CV-D10）并重部署；**公网用 OKX CLI 复核通过**（空探测 → input_required；`outputAssetKey=AAPLx amount=100` → delivered/eligible/LIVE）；**2026-09-21 17:04 布里斯班重新提审，平台状态 "Listing under review"**。服务器 nginx 日志佐证：审核方客户端（Java-http-client，阿里云香港）9/20 13:17Z 三次 POST 带参数被旧严格层拒（400）；**v5 上线 64 秒后同客户端再来 → 200 delivered:eligible**，字段为 `ownerAddress/outputAssetKey/amount`（人类金额，宽容层命中）。通过后由运营者从 OKX AI 入口调用一次（B5） |
| I-05 | 通过 | LIVE 1952 | 只买报告不交易：`x402:buy` 用官方客户端 SDK 走 402→签 EIP-3009→重发→200 + PAYMENT-RESPONSE(status success)，两笔真实结算（QUOTE_ONLY 经 A2MCP、REFERENCE_CONTEXT 经 /v1）；未发起任何执行 |
| I-06 | 通过 | FIXTURE | 每调用方限频 429；上游 5xx 抛错不落库 |

## C · 支付、交付与恢复（12）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| P-01 | 通过 | mock | 价格/网络/payTo 由服务端 402 挑战固定；跨任务凭证 → 402 mismatch |
| P-02 | 通过 | 并发 HTTP | 同键 5 并发只建 1 任务；同凭证重放不重结算 |
| P-03 | 通过 | FIXTURE | 同键异体 409 |
| P-04 | 通过 | FIXTURE | 任务 A 凭证 → 任务 B 拒绝；A2MCP 路径凭证全局唯一 |
| P-05 | 通过 | 故障注入 | settle 抛异常 → 202 PAYMENT_UNKNOWN，无 tx 不重付 |
| P-06 | 部分 | 本地 + LIVE | 执行侧：提交 hash 后重启进程，核实器从 SUBMITTED 续跑到 CONFIRMED（主网实测）；付款侧：同步结算下 settledAt 先于 deliveredAt 落库（LIVE 1952 两笔），结算后交付前崩溃可由 `isDeliverable` 重放同凭证交付（测试覆盖）；未做真实进程杀死演练 |
| P-07 | 通过 | FIXTURE | 信息不足报告照常交付（limited） |
| P-08 | 通过 + LIVE 发现 | 故障注入 + LIVE 1952 | pending→PAID、timeout→UNKNOWN→PAID、failed→PAYMENT_REQUIRED。**LIVE 发现（2026-09-20）**：异步结算（syncSettle=false）下 OKX facilitator 对余额为 0 的付款人 verify 通过、settle 返回 `pending`+tx → 服务按"信任 facilitator"交付，3 s 后对账查到链上 failed → 尝试 FAILED(on_chain_failed)、订单 FAILED 留痕（tx `0x06dd…4618`）。**修**：新增 `SETTLE_SYNC`（默认 true）同步等链上结果，再测同一付款人 → SDK 报 settlement_timeout → 202 payment_unknown **不交付**（tx `0x1cd2…ca65` 链上 failed），对账收尾 |
| P-09 | 通过 | 本地 + LIVE 库演练 | 退款工单模块 `payments/refunds.ts`（只对已收款/结算异常订单开单、同 (orderId, requestId) 幂等、金额≤订单价、REQUESTED→APPROVED→PAID(必须附凭证)/REJECTED、终态不可改）+ 运营者 CLI `pnpm ops`（orders / attempts / refund open|list|set）；`refunds.test.ts` 2 例；在 1952 LIVE 失败订单上走完 open→APPROVED→PAID 演练 |
| P-10 | 通过 | FIXTURE | 付款状态与执行状态分离（submissions 不改订单） |
| P-11 | 通过 | 并发 + 可控时钟 | 2 次/5 分钟原子；同键重放不耗额；第三次 409；过期 409 |
| P-12 | 通过 | FIXTURE | 改意图 = 新任务（同键 409 / 新键新任务） |

## D · Guard 合约与证明攻防（12）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| G-01 | 通过 | FORK + **LIVE 主网 ×2** | ① 2026-09-20 13:12Z 本地 LIVE 服务：5 USDG → 0.014983578 AAPLx，tx `0x333a6e41…5449`；② **2026-09-21 07:2xZ 部署版服务（运营者批准）**：`job_56379f0a…`，REFERENCE_CONTEXT v1.1.0（close_last_tick，偏差 −36 bps）→ v1 Guard tx `0x2f59caa2b6f8591a5245150ff6ae3c3752b9acc57f27d785793b8cf43f394d78`，block 71,206,523，5 USDG → 14929447506450266 AAPLx，refunded 0，gas 516,920，回执核实器自动 CONFIRMED。浏览器钱包版待 B4 |
| G-02 | 通过 | FIXTURE | 伪造/缺失/错身份证书全部 revert，不消耗 nonce |
| G-03 | 通过 | 多部署本地 | 跨链（1952）与跨 Guard 重放 revert |
| G-04 | 通过 | 顺序测试 | 同 nonce 二次 revert；两版本共用 nonce 只成一次；失败重试同包成功 |
| G-05 | 通过 | 参数变异 | recipient/amount/minOut/token/calldata/policy/重签 全部 revert |
| G-06 | 通过 | 边界算例 | minOut 相等通过、少 1 wei 拒；deadline 相等通过、+1 拒 |
| G-07 | 通过 | 恶意 mock | 非白名单 selector(drain)/路由/代币/policy/registry 拒；非零 value 拒 |
| G-08 | 通过 | 攻击合约 | 路由重入 → RouterCallFailed；路由 revert 冒泡；零输出 revert |
| G-09 | 通过 | FIXTURE + FORK | 部分消耗退款；捐赠余额不归因；rebasing 粉尘 ≤1 wei（CV-D05） |
| G-10 | 通过 | FIXTURE | 转账税输入 InputTransferShortfall；转账税输出 RecipientShortfall |
| G-11 | 通过 | 权限矩阵 | epoch 轮换/禁用、暂停/恢复、非管理员拒 |
| G-12 | 通过 | 文案 | 信任边界写入合约 NatSpec 与 README |

不变量（fuzz 64×32）：Guard 余额=捐赠、授权恒 0、spent+refunded=amountIn。

## E · 钱包与端到端（7）

| ID | 结果 | 证据 |
|---|---|---|
| W-01 | 部分 | 前端账户/链校验已做（owner mismatch、switch chain）；公网无钱包路径已自动化验证（W-07）；真机钱包待 B4 |
| W-02 | 待执行 | 拒签/超时终态已实现（4001 映射），真机待 |
| W-03 | 通过（代码） | 精确授权、allowance 显示；无限授权不存在 |
| W-04 | 部分 | 服务端链上核实器已接（`execution/receipts.ts`，主网 tx 实测 SUBMITTED→CONFIRMED，事件 intentDigest 比对）；页面第 6 步显示服务端判定；真机钱包待 |
| W-05 | 待执行 | 主网 E2E 录屏（B4） |
| W-06 | 通过 | 中英文 + 投屏模式；**窄屏实测**（puppeteer + 本机 Chrome，iPhone 390×844 与 1280×800）：首页/新建/开发者/报告/执行页 `scrollWidth == clientWidth`（无横向溢出）；修 nav 按钮换行（`whitespace-nowrap`）。截图 `.screenshots/`（本地） |
| W-07 | 部分 | **干净浏览器上下文**（puppeteer 新 BrowserContext，无 cookie/存储）在公网 https://verify.chaconne.xyz 走通：首页→新建表单→提交（真实任务 `job_f8d75a95…`，REFERENCE_CONTEXT，LIVE，eligible）→报告页→执行页（无钱包时显示"连接钱包"）。钱包段与提交前最终复核仍待人工 |

## F · 生产隔离、恢复与基线回归（7）

| ID | 结果 | 证据 |
|---|---|---|
| O-01 | 通过 | `config.test.ts`：生产禁 fixture/mock；真实收费禁 fixture；只允许一把私钥 |
| O-02 | 通过 | 服务器侧：verify 独立 clone/库/角色/进程，主树 `/opt/chaconne` 与 main 三服务未动（deployment runbook 2026-09-20 服务器回执）；本地公网回归 `https://chaconne.xyz/`、`/api/market-overview` 均 200（2026-09-20 23:25 布里斯班） |
| O-03 | 通过 | 迁移重跑演练：同一 pglite 库连续两次 `db:migrate` 均"迁移完成"无报错（drizzle journal 幂等）；服务器 0000–0016 一次跑全绿 |
| O-04 | 通过 | 每次提交前密钥扫描 + copy-lint；文档只含公开地址 |
| O-05 | 部分 | 核实器 `receipts.test.ts` 5 例：回执缺失→UNKNOWN→找回→CONFIRMED、reverted、确认数不足 REORG_PENDING→回执消失回 SUBMITTED、事件缺失/摘要不符不记 CONFIRMED；真实重组未诱发（X Layer 未遇） |
| O-06 | 通过 | 全仓既有测试仍绿（poller 39、bot 17、core 128 旧用例） |
| O-07 | 部分 | 上游 429/超时：quote 5xx 抛错不落库；负载未系统测 |

## H · v2 验收（升级执行计划 v5 §7，新增 38 + 3 条；2026-09-21 起）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| PL-01 | 通过 | FIXTURE + **LIVE** | 内核测试 + `plan:live` 真实 OKX 阶梯：同证据集合重算 planHash 一致（三个场景均 true） |
| PL-02 | 通过 | FIXTURE + **LIVE** | recommended 只取 eligible 且完成比例最大；**并列改按到手数量**（I2 修：多币种场景原推荐 USDC 29877536，修后推荐 USDG 29879082），`verify.plan.test.ts` 新增 2 例 |
| PL-03 | 通过 | **LIVE** | 真实行情 2026-09-21：20 万 USDG 买 AAPLx → OKX 无路由（QUOTE_UNAVAILABLE→PROVIDE_DATA）；10 万 → 838 bps；5 万 → 119 bps（均 USER_MUST_RELAX_LIMIT）；2 万 → 26 bps eligible → 推荐 10% 候选。证据 `probes/*_LIVE_plan.json` |
| PL-04 | 通过 | **LIVE** | 同目标下 USDG/USDC 双候选并排，价差可见（29879082 vs 29877536），推荐到手多者 |
| PL-05 | 通过 | **LIVE** | 篮子 AAPLx 60% / NVDAx 40%：预算 20 USDG 正确切成 12/8，两腿各自候选与完成比例 |
| PL-06 | 通过 | FIXTURE + LIVE | 卖出内核（A2）+ 卖出 quote/单位换算（B2，LIVE 探针 AAPLx→USDG 0.005，`liveV5.test.ts`） |
| PL-07 | 通过 | FIXTURE + **LIVE** | 内核 ≤8 探针；`quoteLadder` 实测 5 候选 = 5 次调用、串行 250 ms（OKX 并发 2 即 50011） |
| PL-08 | 通过（内核） | FIXTURE | 候选转 job 后 requestHash 链一致：`packages/core/test/verify.plan.test.ts`（A2，2026-09-21）；服务/LIVE 层待 C2/B2 |
| M-01 | 通过 | FORK + 真实服务 | 端到端（真实服务 + 主网分叉 + PlanGuard，I2 2026-09-21，`e2e:mandate`）：规划→一次签署授权→两步各 3 USDG 买入→两次 `MandateStep` 成功（gas 592k/510k，received 0.008964/0.008964 AAPLx）→ 授权计划 COMPLETED（6/6 预算、2/2 步）|
| M-16 | 通过 | FORK + 真实服务 | **I2 端到端发现并修复**：授权计划步骤的路由 calldata 收款人原写成 v1 Guard 地址（证据提供者固定用 `GUARD_ADDRESS`），主网上每一步都会因 `InsufficientOutput(0, minOut)` 回滚；改为按执行合约注入（`CollectOptions.executorContract`）|
| M-15 | 通过 | FORK | 主网分叉上跑**真实部署+配置脚本**与生产配置（I2 2026-09-21）：PlanGuard 部署、6 策略哈希/2 登记表哈希/5 代币/路由+选择器/AAPLx·NVDAx 容差 1e6 全部按 config 上链并读回核对；分叉广播产物已删除以免与主网记录混淆 |
| M-02 | 待执行 | LIVE | PlanGuard 已上主网 `0xE8517f29…d2F0`（配置/Sourcify 齐）；主网真实一步或两步待 9/22 晚（agent-wallet 自驱） |
| M-03 | 通过 | FORK / Foundry | 篡改 mandate/step/cert 任一字段 revert：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-04 | 通过 | FORK / Foundry | 步骤乱序/重放 revert：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-05 | 通过 | FORK / Foundry | 预算越界 1 wei / 单步越界 / 步数耗尽：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-06 | 通过 | FORK / Foundry | validFrom/deadline/validUntil 边界：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-07 | 部分 | Foundry | 撤销后拒绝（合约）；链下 cancel 同步待 C2 |
| M-08 | 通过 | FORK / Foundry | 非白名单 outputToken / 未排序集合：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-09 | 通过 | FORK / Foundry | rebasing 输入短缺容差内通过/超容差拒绝：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-10 | 通过 | FORK / Foundry | 卖出方向 fork 成交（4.994981 USDG）与 minOut 回滚：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-11 | 通过 | FORK / Foundry | 第三方执行者提交：输出到 recipient、退款到 owner、执行者余额差 0：`PlanGuard.t.sol`（51）+ `forkMandate.ts`（D2，2026-09-21） |
| M-12 | 通过 | FIXTURE + FORK | monitor 可控时钟测试（C2）+ 端到端：步骤间服务端回执核实推进 stepsDone 后才发下一步 |
| M-13 | 通过 | FIXTURE + FORK | 过期步骤作废（C2 测）；**I2 端到端发现并修复**：同一步已提交时 prepare-step 原返回 READY，诱导重复提交被合约 `StepOutOfOrder` 回滚 → 改为 WAIT + 新原因码 `STEP_AWAITING_CONFIRMATION` |
| M-14 | 待执行 | — | 暂停期间不签发步骤 |
| V-01 | 通过 | FORK + 真实服务 | 端到端（真实服务 + 主网分叉 + PlanGuard，I2 2026-09-21，`e2e:mandate`）：离线哈希重算 24 项全过（bundle/registry/policy/report/plan/cert/step/mandate） |
| V-02 | 通过 | FORK + 真实服务 | 篡改 `minOutRaw` → 新增失败项恰为 `bundle_hash` 与 `report_v2_rules`，定位到"哈希层 + 规则层" |
| V-03 | 通过 | FORK + 真实服务 | 端到端（真实服务 + 主网分叉 + PlanGuard，I2 2026-09-21，`e2e:mandate`）：证书/授权/步骤签名验证：证明身份 0x757f…e615、用户 0xbacb…0381 全部验签通过 |
| V-04 | 通过 | FORK + 真实服务 | 端到端（真实服务 + 主网分叉 + PlanGuard，I2 2026-09-21，`e2e:mandate`）：规则重算与报告一致（report_v2_rules 重算 eligible） |
| V-05 | 通过 | FORK | 联网回执解码：两步 `MandateStep` 事件经服务端核实器比对 stepDigest 后推进（executor = 提交者，收款人 = owner） |
| V-06 | 部分 | 本地 | 离线 CLI `verify-bundle`（F2，篡改层级/退出码测试）不依赖 API；页面版待 E2 |
| U-01 | 待执行 | — | products 与 A2MCP 文案一致 |
| U-02 | 待执行 | — | 账单服务费/本金/gas 分列，自付标记 |
| U-03 | 待执行 | — | AI agent 自驱全程（MCP 客户端）转录 |
| U-04 | 部分 | 本地 | SDK 6 测（进程内假服务、真实 EIP-3009 签名 viem 验签）；干净环境跑通待集成后 |
| U-05 | 待执行 | — | 平台入口调用（ASP 通过后） |
| T-01 | 通过 | FIXTURE + REPLAY + **LIVE** | 内核 `classifyLastTrade` + live.ts 接入 + 9/18 REPLAY；**LIVE 复核 2026-09-21**：真实 Finnhub 收盘经 v2 分类 → 报告带 `CLOSE_UNCONFIRMED`(info)，REFERENCE_CONTEXT v1.1.0 判 eligible（v1.0.0 同数据为 limited），证据 `probes/*_LIVE_plan.json` |
| T-02 | 通过（实现） | FIXTURE | 次日 pc 确认路径（A2 + B2 `priorLastTick` 钩子）；LIVE 次日样本待 9/22 |
| T-03 | 通过 | LIVE | 乘数三源一致：链上 `getCurrentMultiplier()` = OKX ratio = xStocks API（AAPLx 1.003269…，NVDAx/SPYx 同），B2 探针 2026-09-21；不一致路径 REPLAY 测 |
| T-04 | 通过（内核） | FIXTURE | 同源 ratio 变化 → UNIT_CHANGED(warning)（A2）|
| T-05 | 部分 | REPLAY(构造) | xStocks 公司行动端点需 API key；事件前后样本为构造（before=1.0, after=真实观测）并标注；页面待 E2 |
| C-01 | 待执行 | — | 角色不改变报告哈希 |
| C-02 | 待执行 | — | 战报默认私密、公开时金额可隐藏 |
| C-03 | 待执行 | — | 翻创不复制金额/钱包/旧报价/授权 |
| C-04 | 待执行 | — | 模拟任务不签证书不执行 |
| C-05 | 待执行 | — | OG 图生成 |
| C-06 | 通过（代码级） | FIXTURE | `GET /pub/reports` 只含 public=true、最新在前、不排名（I2 补路由）；页面 `/live` 经 normalizePublicReport 渲染；真机页面待服务器重部署 |
| P-13 | 待执行 | — | 同凭证 10 并发只结算一次且交付前已落库 |
| G-13 | 待执行 | — | 证书 validUntil 受 quote/参考时效约束 |
| O-08 | 待执行 | — | 文案与许可说明核对 |

## UX 组（UX 评审表 2026-09-21 · Verify 部分）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| V-01 | 通过 | 服务器真浏览器 | 报告页白屏：账单 `{bill}` 解包（591ef53，服务器 Playwright 验过） |
| V-02 | 通过 | 服务器真浏览器 | 规划页 `plan`→`report` 归一 + 评估时刻取在采证之后（591ef53） |
| V-03 | 通过 | 服务器真浏览器 | 试玩 `owner_required`：服务端收嵌套/平铺两种形态（591ef53） |
| V-04 | 通过 | 服务器真实调用 | 多腿篮子 `SOURCE_TIME_FUTURE`：`evaluatedAfter()`（591ef53），10 候选全 eligible |
| V-05 | 通过 | 线上 | 执行页先授权再核验（c3fbfce），服务器 09:45Z 部署确认 |
| V-06 | 通过（代码） | 本地 | EIP-6963 多钱包发现 + 选择框（OKX Wallet 推荐、记住选择、可更换）+ 连接中/60 s 无响应提示；`no_wallet` 文案不再只推 MetaMask（`lib/wallet.ts`、`components/WalletChooser.tsx`）；真机多钱包待复测 |
| V-07 | 通过 | FIXTURE | 证据包携带 `attestationSigner/attestationEpoch`（core 类型 + 服务端）；验证器无 signer 时记 ⚪ 未校验而非 ❌；页面默认从 healthz 取期望签名者并可手填；core 新增 1 测（错 signer → ❌，对 signer → ✅） |
| V-15 | 通过 | 展示层 | 证据列表显示 `stock_reference (finnhub)` / `stock_close (finnhub)`（悬停显示原始 kind；冻结的 kind 值不改，CV-D01） |
| CSP | 通过（代码） | — | 放行 Cloudflare 自动注入的 Web Analytics beacon，消除每页控制台 CSP 报错（服务器反馈） |
## UX 组 · 扣分表 Verify 侧（`UX 评审表（内部）` §3.6；分支 devday/v5-ux，2026-09-21）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| V-08 | 通过 | 本地构建 + 截图 | /plan：候选表**始终**渲染（无推荐时显示 `plan_no_reco_why` + 阻塞摘要 `blockingSummary`：前两大阻塞码 + 下一步提示）；每个候选加 `nextStepText`（READY/ACCEPT_PARTIAL/SWITCH_INPUT/WAIT_CONDITION/PROVIDE_DATA/USER_MUST_RELAX_LIMIT 六种人话）与逐条原因码；提交失败或无推荐时表单**不重置**（资产/模板加载改为函数式 setState，仅在空表时填默认）；校验文案改 i18n（`plan_row_no_asset`/`plan_weights_sum`/`why_*`） |
| V-09 | 通过 | 本地构建 + 截图 | 权重输入改百分比（`weightBps/100`，回写 `round(v*100)`）；授权额度改人类单位（`mandate_budget_human`/`mandate_per_step_human`，`humanToRaw`/`rawToHuman` 按代币 decimals 换算），原始最小单位与 ISO 时间移入 `<details class="demo-hide">`（`dev_raw_note`）；时间统一 `fmtLocal`（本地时区 + 时区缩写，`tz_note`）：计划截止、评估时刻、证书有效期、授权 validFrom→deadline、回放观测时刻 |
| V-10 | 通过 | 本地构建 + 截图 | `lib/history.ts`（localStorage `verify_history_v1`，job/plan/mandate/simulation，上限 200，事件 `verify:history`）；创建任务/计划/接受部分/注册授权/创建模拟后 `remember()`；新页 `/me`（`MyTasks`：类型徽标、链接、本地时间、删除、清空）；头部钱包状态（`eth_accounts` 静默读取 + `accountsChanged`，未连接显示"连接钱包"）；导航加"我的任务"，页脚加链接 |
| V-11 | 通过 | 本地构建 + 截图 | /developers 重写：A2MCP（200 `input_required` / 200 `delivered` / 402 三态 + 符号与人类金额 curl）；地址表 Guard `0x0283…770c` / PlanGuard `0xE851…d2F0` / 证明签名者 `0x757f…e615`（OKX 浏览器 + Sourcify 链接 + 复制）；HTTP v1/v5 端点表；20 个 MCP 工具分组；SDK 片段 + 方法清单；信任边界（含 `pyth_reference` 命名说明）；API key 说明；手机 390px 无横向溢出（SDK 方法段落加 `overflow-wrap:anywhere`） |
| V-12 | 通过 | 本地构建 | 证书时效统一口径"最长 60 秒、不超过报价有效期——通常约 30 秒"（`cert_ttl_line`/`mandate_p`/`approve_first_hint`）；`lib/errors.ts` 25 个错误码→人话（owner_required/asset_unsupported/entitlement_exhausted/mandate_not_active/planguard_not_configured/rate_limited/payment_*/service_unreachable/step_expired…，404/429/502-503 兜底），Plan/Mandate/New/Play/Execute/Task/Share 全部改 `apiError`；页脚/返回报告/未启用/自付演示/粘贴证据包文案改 i18n（`footer_*`/`back_report`/`not_enabled`/`bill_self`/`vb_paste`） |
| V-13 | 通过 | 本地构建 + 截图 | /replay/AAPLx：`aaplx.json` 改人类字段（before = 发行初值（构造）`ratio 1.000000`、after = 2026-09-21T02:20:41Z 实测 `1.003269`，双语 `unitNote`，`reasonCodes [UNIT_CHANGED]`）；`ReplayClient` 重写为人话标签（观测时刻/乘数/股票/投入/到手/单价）+ "构造样本"提示 + 结论行（`replay_*`）；去掉开发者注释 |
| V-14 | 通过 | 截图实测 | 头部改单行紧凑：容器 `max-w-6xl py-2`，桌面导航 `lg:` 起、按钮 `whitespace-nowrap`、链徽标仅 ≥1400px 显示、手机端"钱包 + 菜单"折叠（2 列网格，切页自动收起）；**实测头部高度 55px（手机 390×844 与桌面 1280×800 均为 55px，目标手机 ≤ 90px）**；首页加人话导语（`human_intro`）；默认语言改浏览器语言（`navigator.language` zh* → zh，已存储的 `verify-locale` 优先）；8 条路由（/、/plan、/developers、/me、/new、/play、/replay/AAPLx、404）两种视口 `scrollWidth == clientWidth`（无横向溢出） |
| V-16 | 通过 | 本地构建 + 截图 | 内联校验：owner/recipient/钱包地址实时 `addressProblem`（空/非法/未连接三种提示），授权额度 `amountProblem`（非法/单步 > 总额）；提交按钮禁用时显示**原因**（`why_owner`/`why_assets`/`why_inputs`/`why_budget`/`why_wallet`/`why_not_deployed`）而非静默禁用；资产下拉显示 `(ticker)` 与"未启用"标记；地址非法时不写入 profile |
| X-01 | 通过 | 截图实测 | 新增 `app/not-found.tsx`（双语 404 + 首页/我的任务链接，实测 `/nope-404` 返回 HTTP 404、h1 "Page not found"）与 `app/error.tsx`（可复制的错误摘要 + 重试 + 返回首页） |

门禁（2026-09-21，devday/v5-ux）：`npx tsc --noEmit -p apps/verify-web` 通过；`pnpm --filter @chaconne/verify-web build` 通过（✓ Compiled successfully）；puppeteer 截图（Chrome headless，`VERIFY_SERVICE_URL` 指向不可达地址以测离线态）：

| 路由 | 手机 390×844 头部 / 溢出 | 桌面 1280×800 头部 / 溢出 |
|---|---|---|
| / | 55px / 无 | 55px / 无 |
| /plan | 55px / 无 | 55px / 无 |
| /developers | 55px / 无 | 55px / 无 |
| /me | 55px / 无 | 55px / 无 |
| /new、/play、/replay/AAPLx | 55px / 无 | 55px / 无 |
| /nope-404（X-01） | HTTP 404，55px / 无 | HTTP 404，55px / 无 |

未覆盖：V-06/V-07/V-15（钱包库、证据包验证页、next.config 由主线另改）；真实服务联调（候选表/错误码映射的线上样本）待服务器重部署后补。

## X Layer 公开行情（`GET /pub/market/xlayer`，interfaces §10.16；2026-09-21）

| ID | 结果 | 模式 | 证据 |
|---|---|---|---|
| MX-01 | 通过 | FIXTURE | 三档正常：两只允许执行的代币按登记表顺序（SPYx 不在列）、快照/代币键集合与契约完全一致、冲击优先取 OKX `priceImpactPercent`（`marketXlayer.test.ts`） |
| MX-02 | 通过 | FIXTURE | OKX 不给 `priceImpactPercent` → 按执行价相对 100 档中间价计算，取非负 |
| MX-03 | 通过 | FIXTURE | 某档 82000 无路由 → 该档 null + `errors{no_route,size}`，其它档照报，不算失败 |
| MX-04 | 通过 | FIXTURE | TTL 内命中不打上游；过期后并发请求 single-flight 只刷新一次（6 → 12 次调用，非 18） |
| MX-05 | 通过 | FIXTURE | 限流 50011：至多退避重试一次即中止本轮（6+2 次调用），返回上一份 `stale:true`（`asOf` 不变）；TTL 内冷却零上游调用；恢复后重新新鲜 |
| MX-06 | 通过 | FIXTURE | 上游 502 / 网络异常 → 中止本轮（各 +1 次调用），返回上一份 `stale:true` |
| MX-07 | 通过 | FIXTURE | 从未成功 → 503 `{error:"unavailable"}` + `no-store`；未接行情（fixture 模式）的服务同样 503 |
| MX-08 | 通过 | FIXTURE | HTTP 200：`Cache-Control: public, max-age=15, s-maxage=30`，正文无任何凭据字样，无鉴权可访问 |
| MX-09 | 通过 | **LIVE** | 本地 `pnpm market:probe`（真实 OKX，2026-09-21 12:10:29Z，耗时 2.35 s）：AAPLx priceUsd 335.86、1k 335.97（0 bps）、10k 337.81（52 bps）；NVDAx 224.47、1k 224.50（3 bps）、10k 224.89（21 bps）；路由 Uniswap V3 → xStocks wrap V2；`errors: []`。服务器公网验收待部署 |

## STRICT_LIVE LIVE 通过记录（美股常规时段，公网服务 A2MCP 免费端点；脚本 `scripts/liveStrict.ts`）

| 时间（UTC） | 策略 / 版本 | jobId | 结论 | 参考 | 偏差 / 冲击 | reportHash | evidenceHash |
|---|---|---|---|---|---|---|---|
| 2026-09-21 13:33:18 | STRICT_LIVE / 1.1.0 | `job_b85b3e38146a542cc7f4db58` | **eligible**（REGULAR，comparison=live，reasons 空） | finnhub AAPL live 334.00，sourcePublishedAt 13:32:57Z（21 s 前） | +28 bps / 4 bps | `0xdfd4078d7f5652f6ca1db1d6261a61b9e45a0228b11313b3a058c4a71d2ea33a` | `0x6cc6be780bd39e0758c6ad3a1a3b13541fc0b52762defa44f622e4df5c5256f7` |
| 2026-09-21 13:33:32 | REFERENCE_CONTEXT / 1.1.0 | `job_6470d58b53aee4da7171bce6` | **eligible**（REGULAR，comparison=official_close） | 09-18 官方收盘 336.13 | −35 bps / 0 bps | `0x690d3b7ed25f5a7cab99c5a264c0eb3ca5db328e59acbf2902650a5b1d4316ef` | `0xb56321929239a3fa4fb75b69c1c1f419cb09964fd522913d7bb62beb751cf937` |

- 两次均 5 USDG → AAPLx（`amountInRaw=5000000`），HTTP 200，evidenceMode LIVE，任务归演示钱包 `0xbacb…0381`；原始响应存本地 `probes/2026-09-21T13-33-*_LIVE_*.json`（不入库）。
- 同一分钟内两策略结论一致但参考口径不同（live 334.00 vs 官方收盘 336.13），偏差符号相反，说明参考选择逻辑按策略分流正确。
- W-05（浏览器钱包主网成交录屏）：截至 13:35Z 演示钱包 nonce 仍为 4、余额未变，运营者尚未执行；完成后补记 tx。

## 汇总

- v1 68 条（PRE 10 + 清单 58）中：通过 56（含代码级通过 2）、部分 9、待执行 3、阻塞 0、不适用 0。
- 待执行/部分项集中在：真实付款（1952 测试网，需 faucet）、平台入口调用（上架审核后）、真机浏览器钱包（B4 录屏/B5）、服务器侧回归。
- v2 新增 49 条（H 组，含 I2 集成追加 M-15/M-16）：见上表。
- X Layer 公开行情 MX 组 9 条（8 FIXTURE + 1 LIVE 探针）全部通过；公网验收待服务器部署。
- **合计 117 条（v1 68 + v2 49）：通过 86、部分 13、待执行 18**（2026-09-21 六 lane 合并 + 端到端集成后）。待执行集中在：U 组（平台调用/SDK 干净环境/自驱转录）、C 组（Club 页面级）、主网 PlanGuard 相关（M-02）与录屏项。
