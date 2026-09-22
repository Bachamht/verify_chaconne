# Dev Day 2026 · 构建期新增清单（Changes）

> 对照基线 `devday-baseline`（`31b51bc`）。每项附提交、测试证据与状态；未落地的集成不写成已完成。

## Lane A · 规则与证据内核（`packages/core/src/verify/`）— 2026-09-20

| 内容 | 文件 | 证据 |
|---|---|---|
| 冻结契约类型（资产/时间/任务/策略/证据/报告/状态机/EIP-712） | `contracts.ts` | typecheck 5/5 |
| 时间单位换算唯一入口（Pyth 秒 / OKX 毫秒 / ISO / Unix 秒；秒当毫秒拒绝） | `time.ts` | `verify.time.test.ts` |
| 金额定点换算：minOut 向下取整、冲击 null≠0、bps↔百分数、偏差 bps、可执行单价 | `amounts.ts` | `verify.amounts.test.ts` |
| 规范化 JSON + keccak256（与 viem 互检） | `canonical.ts` | `verify.hash.test.ts` |
| 三策略定义 v1.0.0 + 两层哈希 + 参数范围校验（越界不夹紧） | `policy.ts` | `verify.evaluate.test.ts` |
| 资产登记 allowlist 校验与 registryHash | `registry.ts` | `verify.hash.test.ts` |
| EIP-712 独立编码（TradeIntent / VerificationCertificate），与 viem.hashTypedData 双实现互检 | `eip712.ts` | `verify.eip712.test.ts` |
| 规则引擎（纯函数、显式 evaluatedAt；23 原因码；HARD/信息不足 两级判定；禁止自动降级；close_cross_verified；QUOTE_ONLY） | `evaluate.ts` | `verify.evaluate.test.ts` 32 例 |
| 报告组装、evidenceHash / requestHash / reportHash | `report.ts` | 黄金样本 4 份 |
| CreateVerifyJob 运行时校验 | `validate.ts` | `verify.validate.test.ts` |
| 共享 FIXTURE 场景 + 黄金样本 | `fixtures.ts`、`__fixtures__/` | 二次运行比对通过 |

验收映射（FIXTURE 部分）：D-01、D-02、D-03、D-04、D-05、D-07、D-08、D-09、D-10、D-11、D-12、D-13、D-14 有对应用例；D-06（公司行动跨事件混用）待 Lane B 拿到真实 multiplier 语义后补。LIVE 部分待 Lane B/I。

新增依赖：`@noble/hashes ^1.8.0`（core 运行时，keccak256）、`viem ^2.54.1`（core 测试互检）。锁文件仅增 7 行（手工补 importer 条目，`--frozen-lockfile` 校验通过，避免连带升级 Solana 传递依赖）。


## Lane C · 服务、订单与支付（`apps/verify-service/`、`packages/db`）— 2026-09-20

| 内容 | 文件 | 证据 |
|---|---|---|
| 9 张 `verify_*` 表（jobs/orders/payment_attempts/evidence/reports/entitlements/execution_attempts/payment_events/refunds），额度表带 DB CHECK（非负、不超额） | `packages/db/src/verifySchema.ts`、迁移 `0016_fast_boomerang.sql` | PGlite 全量迁移在测试中执行 |
| 配置护栏（O-01）：生产禁 fixture/mock；真实收费禁 fixture 证据；只允许一把证明签名私钥 | `src/config.ts` | `config.test.ts` |
| 6 个冻结 HTTP 接口 + API key 鉴权 + 每调用方限频 + private/no-store | `src/http/app.ts`、`src/http/auth.ts` | `http.test.ts` |
| x402 付费闸门：包装 SDK `x402HTTPResourceServer`，顺序 验证→登记→结算→落库→交付；402/PAYMENT-REQUIRED、凭证重放不重结算、跨任务凭证拒绝、UNKNOWN 只对账 | `src/http/paywall.ts` | `http.test.ts` P-01/02/04/05/08 |
| 订单/付款尝试/额度状态机；PAID 只由真实结算或对账写入；额度单条原子 UPDATE 预留 | `src/payments/orders.ts` | 并发三次刷新恰两次成功 |
| facilitator 工厂（okx 真实 / mock 注入）+ 异常观察器（区分"拒绝"与"结果未知"） | `src/payments/facilitator.ts` | throw/timeout/pending/failed 四种注入 |
| 对账 worker（按 tx hash 查 facilitator，只推进不重付） | `src/jobs/reconcile.ts` | pending→PAID、timeout→UNKNOWN→PAID |
| 任务用例：幂等创建、报告 v1、准备执行（新证据版本 + 同任务共用执行 nonce + EIP-712 证书签发）、提交记录 | `src/jobs/service.ts` | 证书签名用 viem `verifyTypedData` 独立验证 |
| 证明签名身份（只签 VerificationCertificate，无任意签名接口） | `src/attestation/signer.ts` | — |
| 证据提供者接口 + FIXTURE 提供者（时间平移到 now、场景可注入）；LIVE 提供者留给 Lane B | `src/evidence/provider.ts` | — |
| Guard ABI（与 Lane D 合约对齐的 execute/cancelNonce/nonceUsed/GuardedExecution） | `src/execution/guardAbi.ts` | Lane D 发布后以合约 ABI 为准 |

| 链上回执核实器：按 X Layer RPC 回执推进 SUBMITTED→REORG_PENDING→CONFIRMED / REVERTED / UNKNOWN（回执成功还必须含 Guard `GuardedExecution` 且 intentDigest 与本尝试一致；确认数默认 6；回执消失回 SUBMITTED；终态不复查；48 h 外留人工） | `src/execution/receipts.ts`、`src/jobs/service.ts` pendingExecutionAttempts/applyReceipt | `receipts.test.ts` 5 例 + 主网 tx 实测 CONFIRMED |
| 主网执行脚本（B4 证据）：经 HTTP 走完整链路，演示钱包本地签意图，默认 dry-run，`EXECUTE=1` 才精确 approve + Guard.execute + 提交 hash | `scripts/mainnetExecute.ts` | 2026-09-20 主网成交 tx `0x333a…5449` |
| x402 买家端（官方客户端 SDK `x402Client`/`x402HTTPClient` + `ExactEvmScheme`）：脚本 `scripts/x402Buy.ts`（/v1 或 A2MCP 路径，只签 EIP-3009 授权不广播）+ 契约测试；`SETTLE_SYNC`（默认 true）同步等链上结算——LIVE 发现异步模式会对余额为 0 的付款人先交付后失败 | `scripts/x402Buy.ts`、`test/x402client.test.ts`、`src/config.ts`、`src/payments/facilitator.ts` | 1952 真实结算：注资前两笔 failed（`0x06dd…4618` / `0x1cd2…ca65`），注资后两笔成功（`0x9a13…c0cf` / `0x1426…6b8d`），见 test-results PRE-06/P-08 |
| 退款工单（P-09 人工流程）：`Refunds` 状态机 + 运营者 CLI `pnpm ops`（订单/待核实尝试只读、退款 open/list/set；不发交易、不碰私钥） | `src/payments/refunds.ts`、`scripts/ops.ts` | `refunds.test.ts` 2 例 + LIVE 库演练 |
| A2MCP 单端点 `POST/GET /a2mcp/verify`（平台接入形态：input_required schema / 免费 200 / 收费 402 / 凭证全局唯一） | `src/http/a2mcp.ts` | `a2mcp.test.ts` 5 例 |

测试：52 例（config 8 + http 20 + a2mcp 5 + live 6 + guardAbi 4 + receipts 5 + x402client 2 + refunds 2），全部 FIXTURE + mock 支付；真实 x402 结算（1952 测试网）待运营者凭据到位后作 LIVE 验收（P-06/P-10 的真实部分、V2-10）。

新增依赖：`express ^5.2.1`、`@okxweb3/x402-express 0.1.1`、`@okxweb3/x402-core 0.1.0`、`@okxweb3/x402-evm 0.2.1`、`viem`、`zod`；`pnpm install` 连带把锁文件里 `@solana/web3.js` 1.98.4→1.99.0 等传递依赖重解析（仅在 devday 分支；合并 main 前需服务器 `pnpm install`），已用全仓 typecheck/test/web build 验证。

Lane C 计划项已全部完成（LIVE 证据提供者、链上回执核实器、退款工单入口、MCP 薄封装）。


## Lane D · Guard 合约（`packages/verify-contracts/`，Foundry 1.7.1 + OpenZeppelin 5.4）— 2026-09-20

| 内容 | 文件 | 证据 |
|---|---|---|
| `ChaconneVerifyGuard`：EIP-712 双结构（TradeIntent 用户签 / VerificationCertificate 服务签，不同 typehash 防角色混淆）、9 步执行（校验 → 消耗 nonce → 精确拉入并拒绝转账税 → 单次精确授权 → 调路由 → 清授权 → 只归因本次余额差 → 绝对 minOut → 退未消耗输入给 owner、输出给 recipient 并核对到账） | `src/ChaconneVerifyGuard.sol` | `test/Guard.t.sol` 46 例 |
| allowlist：policyDefinitionHash / registryHash / (router,spender) / 选择器 / 代币；signer 按 epoch 轮换与禁用；证书 TTL 上限；暂停；nonce 取消；`rescue` 只能扫捐赠余额 | 同上 | 权限矩阵、轮换、暂停、捐赠不归因用例 |
| 攻防：伪造/缺失/错身份证书、过期/未生效/超 TTL/证书超期于意图、跨链（vm.chainId 1952）与跨 Guard 重放、篡改 recipient/amount/minOut/token/calldata/policy、用户重签但证书陈旧、非白名单 selector（drain）、转账税输入/输出、路由回滚、重入（RouterCallFailed 包裹）、非零 value、非 owner 调用 | `test/Guard.t.sol` | 全部 revert 且不消耗 nonce、余额完整回滚 |
| 不变量（fuzz 64 轮×32 深度）：Guard 余额恒等于捐赠额；路由授权恒为 0；spent+refunded=amountIn 且用户实付=Σspent、收款人实收=Σreceived | `test/GuardInvariant.t.sol` | 3 invariants |
| EIP-712 双实现互检：typehash / domainSeparator / intent structHash / intentDigest / certDigest 与 TS（core/eip712.ts，viem 互检过）产出的黄金值逐一相等（domain 196 + 0x4444…） | `test/Eip712CrossCheck.t.sol` | 4 例 |
| 部署脚本（构造参数读 env）与配置脚本（读 `config/xlayer.json` 的运营者批准清单） | `script/Deploy.s.sol`、`script/Configure.s.sol` | 主网部署待地址批准 |
| ABI 导出 + verify-service 内置 ABI 一致性测试 | `abi/ChaconneVerifyGuard.json`、`apps/verify-service/test/guardAbi.test.ts` | 选择器/事件签名相等 |

信任边界（写进合约 NatSpec）：合约只强制金额、收款人、路由/选择器/代币白名单、calldata 哈希、期限、nonce、signer epoch；链下股票参考事实的正确性依赖证明服务，通过 evidenceHash/策略哈希绑定。管理员可暂停、轮换 signer、改白名单，**不能**动用户资金（无任意调用、无 delegatecall、无用户代币 sweep）。

gas：`execute` 全额成交约 26 万 gas（mock 路由）。编译：solc 0.8.28，via-IR，optimizer 800，cancun。

**主网部署（2026-09-20 21:00 布里斯班）**：`0x02834e26bbd851eedb888bafba666bc0af72770c`，deploy tx `0x92c08aa2e3bd0967863e7b65ac96614368a936c26c0055fce01e68f396e894d9`（block 71140213），Configure 上链（策略×3、registry、5 代币、路由/spender、选择器×2），Sourcify **exact_match**（matchId 51370154）；两步共 ~0.00015 OKB。广播记录 `packages/verify-contracts/broadcast/`。
未做：主网真实成交（G-01 LIVE，待运营者钱包 B4）、EIP-1271 智能账户（首版仅 EOA）。


## Lane B · 数据适配与资产登记（`apps/verify-service/src/adapters`、`evidence/live.ts`、`config/registry.xlayer.json`）— 2026-09-20

| 内容 | 文件 | 证据 |
|---|---|---|
| OKX Onchain OS 签名客户端（与官方 SDK 同款 HMAC 规则）+ RWA 列表 / quote / swap / approve 端点封装 | `adapters/okx/client.ts` | 探针 P1–P3 真实响应（`.probes/`） |
| 路由 calldata 解码器：`dagSwapByOrderId` / `dagSwapTo`，校验 from/to/amount/deadline/receiver=Guard；未知选择器拒绝 | `adapters/okx/calldata.ts` | REPLAY 测试；4byte + openchain 双源 |
| Finnhub 参考价适配（源时间 `t`）+ 实时/收盘分类（CV-D02） | `adapters/finnhub.ts`、`evidence/live.ts` | REPLAY 测试 |
| LIVE 证据提供者：quote、swap(Guard 为收款)、稳定币美元单价、链上代币元数据（带区块）、RWA 条目、Finnhub tick/close | `evidence/live.ts` | 8 例 REPLAY（真实录制响应 + 假 RPC/Finnhub） |
| X Layer 资产登记 v1：USDG/USDC/USD₮0（输入）+ AAPLx/NVDAx（输出，rebasing，1 单位=1 股）；SPYx 登记未启用 | `config/registry.xlayer.json` | `docs/the address-approval log (internal)` 双来源 + 链上元数据 |
| Guard 白名单配置（策略哈希 ×3、registryHash、代币、路由/spender、两个选择器） | `packages/verify-contracts/config/xlayer.json` | 由 registry 生成 |
| **G-01 FORK**：anvil 分叉 X Layer 主网 → 部署 Guard → 白名单 → 真实 OKX 路由 calldata → 双签名 → `execute` 成功（5 USDG → 0.01499 AAPLx，≥minOut，Guard 无残留输入、授权清零） | `scripts/forkExecute.ts` | `.probes/*_FORK_execute.json`（block 71135641） |
| 探针脚本（P1–P4：RWA 列表、三稳定币报价、swap/approve、Pyth/Finnhub 可用性） | `scripts/probe.ts` | 摘要 JSON |

事实与决策：Pyth equity 授权失效（公开 401/带 key 403）→ Finnhub 为参考源（CV-D02）；OKX RWA 列表在 X Layer `stockPrice` 为空；`priceImpactPercent` 正值为有利（CV-D03）；rebasing 输出代币舍入粉尘 ≤ 数 wei（CV-D05）。

未做：SPYx 第二来源；主网真实成交（等 Guard 主网部署 + 演示钱包稳定币）；链上回执核实器（SUBMITTED → CONFIRMED）留 Lane I 集成。


## Lane E · 独立入口（`apps/verify-web/`，Next 15 + Tailwind 4）— 2026-09-20

| 内容 | 文件 | 证据 |
|---|---|---|
| 六页/状态：首页、创建任务、核验报告、执行确认、任务记录（并入报告页）、开发者页 | `app/*` | `next build` 6 路由；本地冒烟 6 页 200 |
| 服务端代理 `/api/verify/*`：API key 只在服务端；`x-verify-caller` = 任务 owner 地址（创建时取 body 并写 httpOnly cookie）；透传 x402 头；路径白名单 | `app/api/verify/[...path]/route.ts` | 冒烟：无 cookie 400、他人钱包 404 |
| verify-service 鉴权扩展：`key:web:*` 通配调用方按 `x-verify-caller` 隔离任务（I-01） | `apps/verify-service/src/http/auth.ts` | `http.test.ts` 新用例 |
| 钱包流程：注入钱包连接、切链 196（缺链自动 add）、**精确 approve**、EIP-712 签 TradeIntent、发 Guard `execute`、等回执、提交 hash；拒签/过期/回滚/pending 各有终态 | `components/ExecuteClient.tsx`、`lib/wallet.ts` | 与 core `EIP712_TYPES` 同源；主网真实操作待 B4 |
| 中英双语字典、投屏模式（大字 + 隐藏工程细节）、LIVE/FIXTURE 与网络角标、原因码人话 | `lib/i18n.tsx`、`lib/reasons.ts`、`components/Header.tsx` | — |
| 报告页：结论、理由、参考价时点/来源/可比性、报价与硬边界、任务记录（付款/版本/额度/执行）、证据列表（模式+源时间+接收时间）、开发者详情（全部哈希 + JSON） | `components/JobClient.tsx` | 冒烟 |
| 严格 CSP（只连自身与 X Layer RPC）、standalone 输出、端口 3110 | `next.config.ts` | build 通过 |

未做：网页内置 x402 付款（免费阶段不需要；付费由 Agent/OKX AI 或 API 侧完成）；真实钱包浏览器验收 W-01～W-05 待主网 Guard 部署后由运营者操作。


## Lane F · Agent 接入（`packages/verify-mcp/`）— 2026-09-20

| 内容 | 文件 | 证据 |
|---|---|---|
| 标准 MCP 服务器（官方 SDK 1.30，stdio）：7 个薄工具，全部只调 verify-service HTTP；无私钥、无签名、无代付；环境含私钥形态变量即拒启 | `src/server.ts`、`src/stdio.ts` | `test/mcp.test.ts`、`test/stdio.test.ts` |
| 402 语义：`purchase_verification` 未付返回 x402 挑战（`paymentRequired`，非错误），host 付款后带 `paymentSignature` 再调；已付不重扣 | `src/server.ts` | 测试 |
| `get_execution_status` 用 RPC 取回执并解码 `GuardedExecution`（提交 ≠ 成交） | `src/server.ts` | — |
| I-03：官方 `Client` 经 InMemoryTransport 与真实 StdioClientTransport（spawn 进程）完成 initialize / 能力协商 / listTools(7) / callTool / 错误映射 | `test/*.test.ts` | 6 例 |
| README（MCP 客户端配置片段：Claude Desktop / Cursor / 通用 stdio） | `README.md` | — |

A2MCP 平台接入端点在 Lane C（`POST /a2mcp/verify`）；ASP #13803 已创建，上架审核待端点部署。


## Lane G · 运维、验收与提交材料（`docs/`）— 2026-09-20

| 内容 | 文件 | 状态 |
|---|---|---|
| 评审 README（问题/产品/架构/复现/证据模式/新增 vs 既有/诚实限制） | `README.md` | 完成 |
| 58 条验收记录（通过 40 · 部分 5 · 待执行 13） | `test-results.md` | 随 LIVE 项更新 |
| 演示脚本（视频 3:00 分镜 + 现场休市预案 + 录制清单） | `demo-script.md` | 完成 |
| 提交表草稿 + 冻结记录模板 | `submission.md` | 视频/链接待填 |
| 部署与版本记录（角色地址、网络、Guard、registry、ASP、工具链） | `deployments.json` | 完成 |
| 服务器部署步骤（verify-service + verify-web，独立进程/库/.env，nginx 分流，证书） | `the deployment runbook` 📌 区 | 服务器运维 执行中 |
| 密钥扫描：每次提交 `git diff --cached` 正则扫描 + `pnpm lint:copy`；仓库只含公开地址；anvil 公开测试私钥仅在测试/脚本 | — | 持续 |

未做：视频录制（依赖主网成交与上架）、干净浏览器复核（提交前）、服务器侧回滚演练（服务器运维）。

## 里程碑（2026-09-20 晚）
- Guard 主网首笔真实成交（LIVE，REFERENCE_CONTEXT，5 USDG → AAPLx，tx `0x333a…5449`），服务端核实器判定 CONFIRMED；公网 `https://verify.chaconne.xyz/a2mcp/verify` 真实调用 200；ASP #13803 已提交审核。

## 待做（提交前）
- 视频录制（B4 浏览器钱包版主网成交 + 上架后平台调用）；干净浏览器复核；提交表填写。

## v5 升级（2026-09-21 起，执行计划 v5；接口冻结 interfaces §10）

| Lane | 内容 | 文件 | 证据 |
|---|---|---|---|
| I2 | 接口冻结：v2 类型（规划/授权计划/证据包/账单/Club）、PlanGuard EIP-712 编码、CV-D06–09、D-081/082/083；LIVE 窗口脚本 | `packages/core/src/verify/{contracts,eip712}.ts`、`docs/interfaces.md` §10、`apps/verify-service/scripts/liveStrict.ts` | `verify.eip712v2.test.ts` 4 例（viem 互检） |
| A2 | 规划引擎（阶梯、评分、推荐、下一步）、delta 解释器、证据包哈希与离线验证器、收盘分类 `close_last_tick` + 策略 v1.1.0、卖出方向（CV-D09） | `packages/core/src/verify/{plan/,delta,bundle,closeClassify,policy,evaluate}.ts`、`__fixtures__/v2/` | core 207→236 测；v1.0.0 哈希钉住不变 |
| B2 | `quoteLadder`（串行+限频退避）、卖出报价与解码、乘数证据（链上 `getCurrentMultiplier()` / OKX ratio / xStocks API 三源）、Finnhub candle 探针（免费档 403）、收盘分类接 core、公司行动 REPLAY 样本、registry v1.1.0 | `apps/verify-service/src/{evidence/live.ts,adapters/xlayer/multiplier.ts,adapters/xstocks.ts,adapters/finnhub.ts}`、`config/registry.xlayer.v1.1.json` | `liveV5.test.ts` 17 例 + LIVE 探针 |
| D2 | `GuardCore` 抽取（v1 不动）+ `ChaconneVerifyPlanGuard` v2（一次签授权、逐步证书、无门槛执行者、rebasing 输入容差、撤销）、部署/配置脚本、ABI、fork 联调两买一卖 | `packages/verify-contracts/{src/GuardCore.sol,src/ChaconneVerifyPlanGuard.sol,test/PlanGuard*.t.sol,script/*PlanGuard*.s.sol,config/xlayer.planguard.json,abi/}`、`apps/verify-service/scripts/forkMandate.ts` | forge 114 测（v2 51 + 不变量 4 + 互检 6）；fork 证据 `probes/*_FORK_mandate.json` |
| F2 | verify-mcp 新增 13 工具（plan_trade / simulations / products / prepare+register+get+pause+resume+cancel mandate / execute_next_step / bundle get+verify / share card）、agent-wallet 模式（CV-D08：三变量齐备才启用，护栏拒绝其它私钥；自动 x402 付款带花费上限；步前读链上 stepIndex、精确授权、估气 ×1.3）、`verify-bundle` CLI、新包 `@chaconne/verify-sdk`（x402 自动付款） | `packages/verify-mcp/src/{toolsV2,wallet,bundleVerify,verifyBundleCli,planGuardAbi}.ts`、`bin/verify-bundle.mjs`、`packages/verify-sdk/` | mcp 19 测 + sdk 6 测；`docs/agent-run.md` 模板 |
| C2 | 迁移 0017（8 张 v2 表）、`/v1/plans`+候选转任务、`/v1/mandates`(登记/暂停/恢复/取消/prepare-step/submissions)、monitor worker、证据包与 EIP-191 签名、商品目录与账单、模拟/角色/模板/战报后端、第二个 A2MCP 端点；**FIX-087** 支付并发（同单串行化，交付前必有结算落库）、**FIX-088** 证书有效期受报价与参考时效约束 | `apps/verify-service/src/{plans,mandates,bundle,products,club,http}/`、`packages/db` 0017 | verify-service 57→106 测 |
| E2 | `/plan`（三问式表单 + 候选表 + 三策略对照）、`/tasks/[id]`（进度/时间线/暂停恢复取消/链上撤销/我来执行这一步/账单）、授权签署流程、`/verify-bundle`（纯客户端 + 篡改实验）、Club（`/play`、`/r/[shareId]`+OG、`/live`、翻创模板、三个原创形象）、`/replay/[assetKey]` | `apps/verify-web/`（16 路由） | build 绿；干净浏览器 12 视口零横向溢出；API 不可达时 6 页仍 200 |
| I2 互通 | 两站互通：Verify 头部产品切换胶囊（← 主站 行情比价）、报告页「在主站看各版本比价」深链、`/new` 支持 `?stock=&amount=&input=&policy=` 预填（主站资产页深链的落点） | `apps/verify-web/{components/Header,JobClient,NewJobForm}.tsx`、`lib/productSwitch.ts` | build 绿 |
| I2 集成 | **ASP 驳回修复（CV-D10）**：复现 OKX 客户端只认 200/402 → A2MCP 三端点缺参数改 200 input_required + 宽容输入层（符号/代码/别名/人类金额/默认值）+ summary + 请求日志 + 描述重写；PlanGuard 主网部署/配置/Sourcify；v1 Guard 白名单补 v1.1.0；规划器×真实 OKX 阶梯验证并修推荐并列规则；ABI 漂移核对工具（6 处手写 ABI 全匹配）；主网分叉验证部署配置脚本；**端到端集成（真实服务+分叉+PlanGuard）并修两个真实缺陷**（步骤路由收款人写成 v1 Guard；已提交步骤仍返回 READY） | `apps/verify-service/scripts/{planLive,e2eMandate,abiDrift,rotateOwner}.ts`、`src/evidence/{provider,live}.ts`、`src/mandates/service.ts`、`packages/core/.../contracts.ts` | `probes/*_LIVE_plan.json`、`probes/*_E2E_mandate.json`（24/24 离线校验） |
| I2 行情 | **公开行情端点 `GET /pub/market/xlayer`**（主站接入 X Layer 的数据源）：OKX 聚合器三档买入报价（100/1k/10k USDG → AAPLx/NVDAx）、30 s 缓存 + single-flight、上游失败回上一份 `stale:true` + TTL 冷却、限流至多重试一次不风暴、从未成功 503；契约冻结 interfaces §10.16；healthz `publicMarket`；`pnpm market:probe` 探针 | `apps/verify-service/src/market/xlayer.ts`、`src/http/app.ts`、`src/index.ts`、`scripts/marketProbe.ts` | `test/marketXlayer.test.ts` 8 例；LIVE 探针 2026-09-21 12:10Z：AAPLx 335.86（10k 档 52 bps）、NVDAx 224.47（10k 档 21 bps），2.35 s |

## 真实链路测试与卖出方向修复（2026-09-22）

| 项 | 位置 | 证据 |
|---|---|---|
| 卖出授权计划的链上方向修正（卖出时 `mandate.inputToken` = 股票代币、输出集 = `[资金币种]`，只允许一条腿）+ 3 条单测 | `apps/verify-service/src/mandates/service.ts`、`test/mandates.test.ts` | 主网 `executeStep` tx `0xee9dce5e…`（received 2.996952 USDG、refunded 1e6 wei） |
| `mainnet:execute` 支持卖出方向（`SIDE=sell`、`INPUT_ASSET`/`OUTPUT_ASSET`、`AMOUNT_RAW=all`），并修正授权的代币 | `apps/verify-service/scripts/mainnetExecute.ts` | 同上 |
| 真实链路测试装备（puppeteer-core + 注入式 Wallet Standard / EIP-6963 钱包，签名在 Node 端，证据自动打码） | `qa/real-path/` | W / VW / VJ / VP 系列证据 |
| 链上对抗 12 组全部 revert（含主网 3 笔真实广播）、分叉不变量 4 项 | `packages/verify-contracts`、脚本 `fork:execute` / `fork:mandate` | `test-results.md` 真实链路一节 |
