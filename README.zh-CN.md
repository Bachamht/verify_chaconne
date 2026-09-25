# Chaconne Verify

[English](README.md) | **中文**

**OKX Dev Day 2026 · 赛道：Build a Company · 在已有的 Chaconne 项目之上构建**

Chaconne Verify 是一项面向 AI Agent 的链上美股交易核验与受约束执行服务，运行在 X Layer 上。你的 Agent 用自己的策略做决定；Chaconne 用证据核验每一笔交易，把执行限制在持有人签过的范围之内，并留下任何人都能在浏览器里离线复核的决策记录。

线上网站叫 **Chaconne Agent**，因为用户在那里做的事就是把目标交给 AI Agent。项目、OKX AI 上架和代码沿用 **Chaconne Verify** 这个名字。两者是同一个产品，同一个域名，同一套合约。

## 链接

| 内容 | 地址 |
|---|---|
| 线上产品 | https://verify.chaconne.xyz/ |
| OKX AI 上架 | 服务商 #13803「Chaconne Verify」：https://www.okx.ai/agents/13803 |
| 上架的 A2MCP 服务 | 交易核验服务 `POST https://verify.chaconne.xyz/a2mcp/verify`，任务草案服务 `POST https://verify.chaconne.xyz/a2mcp/agent-tasks`，两项都免费 |
| Guard 合约（X Layer 主网，链编号 196） | [`0x02834e26bbd851eedb888bafba666bc0af72770c`](https://www.okx.com/web3/explorer/xlayer/address/0x02834e26bbd851eedb888bafba666bc0af72770c)，Sourcify 精确匹配 |
| PlanGuard 合约（X Layer 主网，链编号 196） | [`0xE8517f296211F4b9175796bAAB47979FB14Fd2F0`](https://www.okx.com/web3/explorer/xlayer/address/0xE8517f296211F4b9175796bAAB47979FB14Fd2F0)，Sourcify 精确匹配 |
| 开发者文档 | https://verify.chaconne.xyz/developers，以及给程序读取的 `/openapi.json`、`/llms.txt`、`/.well-known/agent-card.json` |
| 部署记录、哈希与证据 | `docs/deployments.json` |
| 构建期内完成的工作 | `docs/changes.md` |

X Layer 主网上的真实成交：

* 第一笔经 Guard 合约的买入，用 5 USDG 买到 0.01498 AAPLx：[`0x333a…5449`](https://www.okx.com/web3/explorer/xlayer/tx/0x333a6e41742f046d478e6a074f80d148d678e5baf8ab7f0c0736041c20245449)
* 第一笔经 PlanGuard 合约的卖出，把 AAPLx 换回 USDG：[`0xee9d…2180`](https://www.okx.com/web3/explorer/xlayer/tx/0xee9dce5e931974c2b9ef8cc593ad9871e1da906010bf9415651bc8cfb7e22180)
* 付费核验在 X Layer 测试网（链编号 1952）上的 x402 结算：见 `docs/deployments.json` 中的 `x402Evidence`

## 要解决的问题

在链上买代币化美股的 Agent，常犯三个不易察觉的错误：只认股票代码，不核对链和合约地址；拿链上报价去比一个其实是过期收盘价、甚至没有来源时间的“股价”；把未知的价格冲击当成零。更进一步，一旦 Agent 掌握了钱包私钥，持有人就无法设定“只买这几只、最多这么多钱、只到周五为止”这样的规则，并让它真正被执行。

Chaconne Verify 同时解决这两件事。Agent 保留自己的判断，平台负责核对事实，合约负责守住边界。

## 工作原理

产品分三层，网站也按这三层组织。

### 一、任务：目标、策略和你签的范围

一个任务由三部分组成：一段大白话写的目标（例如“未来五个交易日，按市场对每次宏观数据的反应，把预算分配到 AAPLx 和 NVDAx 上”），一段交给 Agent 执行的策略，以及一个授权范围。

* **目标和策略不在签名之内。** 持有人随时可以修改，每次修改都保留为新版本，不需要重新签名。Agent 在下一轮读取最新版本。
* **授权范围是持有人签名的内容，只签一次，格式是 EIP 712 的 `TradeMandate`。** 它写明 Agent 可以买哪些股票、总预算、每笔上限、最多几笔、截止时间、是否允许卖出、Agent 所提供依据的信任档位，以及可选的硬约束，例如“只在美股常规交易时段”。范围签好后不能放宽，要放宽只能新建任务并重新签名。

### 二、上下文：Agent 用什么做判断

* **事件日历。** CPI、非农、议息会议、联储官员讲话、其他宏观数据、每只支持股票的财报、美国假日与提前收盘。每个事件都有固定编号，并如实标注时间精度：精确到分钟、只到日期，或只是估计。
* **市场上下文。** 交易时段、联储静默期、利率、VIX，以及上一次重要数据发布后的跨资产反应（缓和、传导或背离）。上下文来自我们的 Crowsnest 数据管道，带 Ed25519 签名；每个字段都有自己的状态，缺失的值标为不可用，绝不猜测。
* **叫醒机制。** 任务关注的事件临近、到点或改期时，平台为 Agent 开启新的一轮。Agent 有三十分钟回应；没有回应也会记录在案，但不会触发任何动作。

### 三、核验：平台保证什么

每一轮里，Agent 可以提交交易意图，可以先持币并要求更多证据，可以修订自己的计划，也可以结束任务。持币同样是一个完整的决定，而不是失败。

交易意图包括“买什么、买多少”，以及一份决策记录，写明理由和所依据的来源。任何交易执行之前，平台都要做四道核验：

1. **依据分拣。** 每条依据被归为平台核验过的事实、Agent 自带的数据，或 Agent 自己的研究结论。持有人设定的信任档位决定哪些类别可以采信。平台没有核验过的内容，一律标注为“Agent 提供，未核验”。
2. **授权范围与硬约束。** 股票必须在签名的名单里，金额不能超过每笔上限和剩余预算，笔数和期限必须仍然允许，所有硬约束在最新报价下都必须成立。
3. **执行核验。** 使用与单笔交易核验相同的引擎：对照精选名录核对代币身份，检查参考价及其时效，获取 OKX DEX 报价与路由，计算价格冲击。
4. **证书绑定。** 步骤证书必须与持有人签过的那份授权严格对应。

四道核验全部通过，真实任务才会拿到一张步骤证书。证书最长有效六十秒，通常约三十秒。随后由 Agent 的钱包或持有人的浏览器钱包把这一步发给 PlanGuard 合约。合约会核对证书、授权签名、各项上限、白名单和调用数据哈希，只把资产付给指定的收款地址，并在同一笔交易里退回没有用完的输入。被拒绝的意图同样会连同原因一起保存。

### 决策记录

每个任务都保留一条时间线，依次记录每次叫醒、每个决定、每个意图、四道核验的结果、证书和成交。持有人可以在任务页把它导出为 JSON，粘贴到 `/verify-bundle` 页面。页面在浏览器本地重新计算每一个哈希、每一个 EIP 712 摘要和每一个签名，并重新执行规则。改动其中任何一个数字，核验就会失败。同一个验证器也以命令行工具的形式放在 `packages/verify-mcp` 里。

## 五分钟上手

你需要一个浏览器钱包，OKX Wallet 即可。模拟不会动用任何资金。

1. 打开 https://verify.chaconne.xyz/ ，点击「免费体验一个任务」。连接钱包，并对登录消息签名。登录签名不花 gas，也不授予任何权限，只用来证明地址属于你。
2. 从五个示例任务中选一个，例如“宏观数据驱动的双标的分配”，点击「建模拟任务，我来扮演 Agent」。
3. 现在由你扮演这一轮的 Agent。三种决定都试一次：先持币并要求证据，再修订计划，最后提交一笔买入意图。时间线会逐条记录，意图下方会显示四道核验的结果。
4. 打开任务详情页，可以看到签过的授权范围、带版本的策略、一个无需重新签名就能补充要求的输入框，以及决策时间线。
5. 展开「执行详情」，点击「导出决策记录（JSON）」并复制全部内容，再点击「离线验证」，粘贴后运行检查。然后改动一个数字，再运行一次。

如果想像其他 Agent 那样调用本服务，可以打开 OKX AI 上架页，点击「Use now」，把弹窗里给出的提示词交给任何安装了 Onchain OS 的 Agent。

## 面向 Agent 与开发者

* **OKX AI（A2MCP）。** 服务商 #13803 上有两项免费服务。缺少参数或参数错误时，一律返回 HTTP 200，`status` 为 `"input_required"`，并附上缺失的字段、数据结构和示例；成功时 `status` 为 `"delivered"`。付费档位返回 HTTP 402 和 x402 付款要求。
* **MCP。** `packages/verify-mcp` 提供 51 个工具，从 `get_market_context`、`get_events`、`create_task`，到 `submit_trade_intent`、`report_agent_status`、`execute_trade_intent` 和 `verify_evidence_bundle`。Agent 钱包模式可以在其本地配置的限额内执行已获证书的步骤。
* **SDK 与 HTTP。** `packages/verify-sdk`，以及 `/openapi.json` 中描述的 REST 接口。
* **API 密钥。** 市场上下文、资产名录、核验策略和 A2MCP 接口都不需要密钥。凡是代表某个钱包行事的操作都需要密钥，用户在 `/agent/keys` 用一次钱包签名即可自行签发。密钥与该钱包绑定，也可以在同一页面吊销。

## 安全模型与信任边界

* 服务端只持有一把私钥，即证明签名者，用来签发证书和证据包哈希，无法动用用户资金。
* 资金只能经由 Guard 或 PlanGuard 合约流动，只能在签过的授权范围之内，也只能付给授权里写明的收款地址。
* PlanGuard 只约束经过它的交易。持有完整私钥的 Agent 仍然可以从钱包直接发出其他交易，本产品从未宣称可以阻止这一点。
* 合约管理员可以暂停合约、轮换签名者、修改白名单。这是公开说明的信任边界，而不是“完全无需信任”的承诺。
* 网站只代表已签名登录的钱包行事；通过接口进行的每一次写操作，都需要与所代表钱包绑定的密钥。

## 代码结构

| 路径 | 内容 |
|---|---|
| `apps/verify-service` | 服务端：证据采集、规则引擎接入、规划器、任务、交易意图、授权、x402 支付、回执核验、A2MCP 接口 |
| `apps/verify-web` | 网站，包括离线决策记录验证器 |
| `packages/core/src/verify` | 纯逻辑：规则、策略、资产名录、哈希、EIP 712、规划器、授权范围、交易意图、证据包验证 |
| `packages/verify-contracts` | `ChaconneVerifyGuard`（单笔交易）和 `ChaconneVerifyPlanGuard`（授权计划），附 Foundry 测试 |
| `packages/verify-mcp` | MCP 服务、Agent 钱包执行器和证据包验证命令行工具 |
| `packages/verify-sdk` | TypeScript 客户端 |
| `packages/db` | `verify_*` 数据表与 SQL 迁移 |
| `docs` | 接口约定、部署记录、变更清单、测试结果、演示脚本 |

## 本地复现

下面的样例数据模式不需要任何密钥。

```bash
pnpm install
pnpm typecheck
pnpm test                                             # 单元测试与集成测试
(cd packages/verify-contracts && forge build && forge test)
pnpm --filter @chaconne/verify-web build
```

以样例数据模式启动服务，不会访问任何外部接口。下面的证明私钥是 Anvil 公开的 0 号测试账户，切勿用于任何真实用途。

```bash
cd packages/db && DATABASE_URL=pglite://../../.pgdata-verify pnpm db:migrate && cd ../..
cd apps/verify-service && DATABASE_URL=pglite://../../.pgdata-verify NODE_ENV=test PAYMENT_MODE=mock \
  EVIDENCE_MODE=fixture REGISTRY_MODE=fixture GUARD_ADDRESS=0x4444444444444444444444444444444444444444 \
  ATTESTATION_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  VERIFY_API_KEYS="dev:web:*" pnpm start
# 另开一个终端
curl -s -X POST http://127.0.0.1:8790/a2mcp/verify -H 'content-type: application/json' -d '{}' | head -c 400
```

最后一条命令会返回 `status: "input_required"`，并附上数据结构和示例。真实数据模式需要 OKX Onchain OS 凭据和 Finnhub 密钥，所需变量列在 `apps/verify-service/.env.example`。逐项测试结果见 `docs/test-results.md`。

## 确认线上运行的就是这份代码

`docs/RELEASE.json` 记录了本快照全部文件的树哈希。克隆后运行 `pnpm release:hash`，把结果与 https://verify.chaconne.xyz/healthz 返回的 `release.treeHash` 对比即可。两个合约都可以用 `packages/verify-contracts` 重新编译，并在 Sourcify 上比对。

## 证据模式

每个页面、每条记录都标明数据来源：`LIVE` 表示真实的上游调用，`REPLAY` 表示录制下来的真实响应，`FIXTURE` 表示构造的样例输入，`FORK` 表示本地主网分叉，`SIMULATION` 表示执行前的估算。

## 构建期内的新增工作

Chaconne 在活动之前已经存在，当时是一个基于 Solana 和 Jupiter 的交易网站，带有参考价数据管道和溢价计算引擎。本仓库中的全部内容都在构建期内完成：核验引擎与证据模型，带签名范围的任务，交易意图与四道核验，Agent 叫醒机制，事件日历与市场上下文接入，A2MCP 服务与 x402 支付，两个合约及其测试，X Layer 资产名录与 OKX 接口适配，MCP 服务，SDK，以及网站本身。`docs/changes.md` 逐项列出了这些工作。

## 已知局限

* 股票参考价来自 Finnhub，因为 Pyth 的股票行情在 2026 年 8 月 26 日失去授权。来源时间取最后一笔成交；取自美东时间 16:00 最后一笔成交的收盘价，在得到次日数据确认之前，一直标注为“尚未确认”。
* 目前只支持一家发行方（xStocks），约四十只股票，只支持固定输入金额的兑换，也只支持普通外部账户钱包。
* 卖出必须经由 PlanGuard。股票代币按份额记账，每次转账实际到账会比请求少约一个最小单位。PlanGuard 允许这点误差并退回余量；单笔交易的 Guard 不允许，因此在那里卖出会失败回滚。
* 两项 A2MCP 服务都以免费形式上架。基于 x402 的付费 A2MCP 已经实现，并在 X Layer 测试网上完成过真实结算，但还没有在上架服务中启用。
* 规划器只对它实际询过价的候选方案排序；OKX 对并发询价有频率限制，因此它从不宣称搜索过整个市场。
* 授权计划把多次签名变成一次，但它仍然是一项持续有效的许可。持有人可以在服务中暂停，也可以在链上撤销；每一步仍然受上限约束，并重新核验。
* 回执核验器在 X Layer 上获得六个区块确认后即标记为已确认，这并不等于结算层的最终性证明。

## 团队

单人开发，即 Chaconne 的运营者。

## 许可证

MIT，见 `LICENSE`。
