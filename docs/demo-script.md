# 演示脚本 v2（2–4 分钟视频 + 现场 3 分钟）

> 原则：成功流程用 LIVE + 主网；异常片段标 REPLAY / FIXTURE / FORK；不倒带行情、不伪造实时。
> 录制窗口（布里斯班）：美股常规时段 23:30–06:00，9/21（一）～9/24（四）。休市片段可随时录。
> v5 的故事主线从"核验一笔"升级为"办成一件事"：**规划 → 一次授权 → 逐步执行 → 证据可复核**。

## 视频（目标 3:20）

| 时间 | 画面 | 旁白要点 | 证明什么 |
|---|---|---|---|
| 0:00–0:20 | 首页（投屏模式，EN） | 「Agent 买链上美股常犯三个错：认 symbol 不认合约、拿陈旧收盘当实时、把未知冲击当 0。更麻烦的是：它只会问"能不能买"，不会问"到底能买成多少"。」 | 问题具体 |
| 0:20–0:55 | OKX AI 里调用 Chaconne Verify（A2MCP）→ 返回规划候选表（真实行情，9/21 实测数字见下） | 「服务已在 OKX AI 上架（ASP #13803）。你说要买 20 万美元的 AAPLx——诚实的答案是：20 万这条链上根本没有路由，10 万的冲击是 838 个基点，5 万还是 119 个，能落进你 30 基点限额的只有 2 万。它不替你降级，它告诉你是哪条限额在挡、下一步能做什么。」角标 LIVE | 通过 OKX AI 可用（Company 最低要求）+ 规划的真实价值 |
| 0:55–1:25 | 报告页：eligible/理由/参考价 kind+源时间+来源/证据列表；展开开发者详情看哈希 | 「每条证据有源时间和接收时间；收盘价若来自 16:00 最后一笔且未经次日确认，页面直说。报告不可变、带 evidenceHash。」 | 时点诚实、独立客户价值 |
| 1:25–2:10 | 授权计划：用户**签一次** TradeMandate（预算上限/单步上限/步数/资产集合/期限）→ 任务页时间线 → 「执行这一步」→ 钱包精确授权 + 发交易 → 回执 + 服务端链上核实 | 「签一次，之后每一步都重新核验、重新签发 60 秒证书；合约强制顺序、预算、单步上限、收款人。执行者可以是任何人——他拿不到资产。」 | 持续办事 + X Layer 深度集成 |
| 2:10–2:40 | 证据包页：下载 bundle → **关掉网络/API** → 验证器逐项打勾 → 在篡改框里改一个数字 → 立刻指出是哪一层失败 | 「不用信我们：哈希、签名、规则重算都能离线复核；改任何一个字段，它会告诉你坏在哪一层。」 | 可检查、不自证 |
| 2:40–3:05 | 两个异常：① 休市时 STRICT_LIVE → rejected(MARKET_OUTSIDE_REGULAR)（LIVE）；② FORK 片段：篡改 minOut / 步骤乱序 → revert | 「拒绝是正确答案，不自动降级；篡改和乱序在合约层被拦。」 | 阻断位置可见 |
| 3:05–3:20 | 任务记录三栏 + changes.md + 两个合约地址 | 「付款、报告版本、执行三类状态独立；构建期新增清单可核。」 | 新增可核查 |

### 0:20–0:55 的真实数据（2026-09-21 LIVE，可复跑 `pnpm --filter @chaconne/verify-service plan:live`）

| 预算 | OKX 报价 | 不利冲击 | 判定 | 下一步 |
|---|---|---|---|---|
| 200,000 USDG | 无路由（upstream 82000） | 未知 | rejected `QUOTE_UNAVAILABLE` | PROVIDE_DATA |
| 150,000 USDG | 无路由 | 未知 | rejected | PROVIDE_DATA |
| 100,000 USDG | 273.9 AAPLx | 838 bps | rejected `PRICE_IMPACT_EXCEEDED` + `REFERENCE_DEVIATION_EXCEEDED` | USER_MUST_RELAX_LIMIT |
| 50,000 USDG | 147.7 AAPLx | 119 bps | rejected `PRICE_IMPACT_EXCEEDED` | USER_MUST_RELAX_LIMIT |
| **20,000 USDG** | **59.6 AAPLx** | **26 bps** | **eligible** | **ACCEPT_PARTIAL（推荐）** |

> 限额 `maxPriceImpactBps=30`。同一份证据重算 planHash 一致（确定性）。缩小金额**不算**完成原目标，页面与报告都按"部分完成"表述。

## 现场（10/7 新加坡，美股休市）

1. 实时创建 STRICT_LIVE 任务 → 拒绝（正确）。
2. 用户显式改选 REFERENCE_CONTEXT → 规划给出可行候选 → 走 PlanGuard 执行一步（若运营者允许现场小额真金；否则播放 9/22–24 录制的 LIVE 片段并标注日期）。
3. 证据包验证器现场篡改实验（不需要网络，最适合现场）。
4. 模拟模式给观众玩（无需入金）。

## 录制清单

- [x] 主网 Guard 一笔真实成交（脚本版，2026-09-20）：tx `0x333a…5449`，事件与余额变化在 `deployments.json`。
- [x] FORK 授权计划两买一卖（2026-09-21，第三方执行者）：`.probes/*_FORK_mandate.json`。
- [x] **主网买入 + 卖出（2026-09-22）**：买入走单笔任务 `job_2bf82025…`（tx `0x086691dd…`），卖出走授权计划 PlanGuard `mnd_517dcbdb…`（`executeStep` tx `0xee9dce5e…`，received 2.996952 USDG、refunded 1e6 wei 容差余量）。**录像时卖出请走授权计划页面，不要用单笔任务的卖出**（股票代币是 share 记账，v1 Guard 无容差会 revert；见 `deployments.json → mainnetEvidence3`）。
- [ ] 主网 Guard 浏览器钱包版成交（B4 录屏用，运营者）。
- [ ] 主网 PlanGuard 授权计划 2 步买入（9/22 晚，agent-wallet 自驱）。
- [ ] STRICT_LIVE 真实通过一次（9/21 晚 23:30 后，定时脚本已就绪）。
- [ ] 休市拒绝片段（随时）。
- [ ] FORK 篡改/乱序 revert 片段（`forge test -vvv --match-contract PlanGuard`）。
- [ ] 证据包离线验证 + 篡改实验片段（随时，不需要网络）。
- [ ] OKX AI 平台入口调用片段（上架通过后）。
- [ ] 所有片段角标：LIVE / REPLAY / FIXTURE / FORK / SIMULATION，网络 196。

## 不说的话

「100% 安全」「防止所有 agent 失误」「官方认证行情」「付款与成交原子完成」「已有客户收入」「全市场最优价」「自动帮你赚钱」（自付演示只标 demo_self_payment；规划只覆盖它真实询过价的候选）。
