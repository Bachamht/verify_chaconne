/** 首页四入口与示例任务（纯数据，页面与测试共用）。条件写法 = core contracts §1.3；不含金额/钱包。 */
import type { Condition, PlaybookId } from "@chaconne/core/verify";

export type EntryId = "goal" | "buy" | "wait" | "compare";
export const ENTRIES: Array<{ id: EntryId; key: "ag_entry_goal" | "ag_entry_buy" | "ag_entry_impact" | "ag_entry_wait" | "ag_entry_compare"; blurb: { en: string; zh: string } }> = [
  { id: "goal", key: "ag_entry_goal", blurb: { en: "Objective, your own strategy, a signed scope. The agent decides when, which asset and how much.", zh: "目标、你自己的策略、签过的范围。何时买、买哪个、买多少由 agent 决定。" } },
  { id: "buy", key: "ag_entry_buy", blurb: { en: "Fixed automation: a rule-based plan the platform issues by itself (DCA, event windows, price watch).", zh: "固定自动化：按规则由平台自己签发的计划（定投、避开事件、价格观察）。" } },
  { id: "wait", key: "ag_entry_wait", blurb: { en: "Why hasn't a task bought yet? All blockers, next check.", zh: "任务为什么还没买？全部阻塞项与下次检查点。" } },
  { id: "compare", key: "ag_entry_compare", blurb: { en: "Two condition sets, one evidence snapshot, no execution.", zh: "两套条件、同一份证据快照、不执行。" } },
];

export interface SamplePlaybook {
  /** 模板 id（页面用它选模板；同一个 playbook 可以有多套条件） */
  id: string;
  playbookId: PlaybookId;
  title: { en: string; zh: string };
  /** 一句话说明：它会怎么做 */
  what: { en: string; zh: string };
  /** 默认步数 */
  steps: number;
  conditions: Condition[];
  /** 用哪一类事件解释这个模板 */
  eventKinds: string[];
  /** 每步核验策略；缺省 QUOTE_ONLY。价格类条件（premium_bps_lte / target_price）要参考价，QUOTE_ONLY 不产出参考价会永远等待（V-49），这类模板固定 STRICT_LIVE */
  policyId?: "QUOTE_ONLY" | "REFERENCE_CONTEXT" | "STRICT_LIVE";
}
/** 这些条件类型的判断需要参考价：核验策略不能选 QUOTE_ONLY（V-49） */
export const REFERENCE_CONDITION_TYPES = new Set(["premium_bps_lte", "target_price_gte", "target_price_lte", "tracked_cost_pnl_pct_gte"]);
export const needsReference = (items: Condition[]) => items.some((c) => REFERENCE_CONDITION_TYPES.has(c.type));

/**
 * 网页模板 = playbook + 一套条件。链上股票 24 小时可交易：不再默认限制美股常规时段（表单里可勾选）。
 * 需要实时参考价的条件（折价观察）在盘外没有判断依据，会等到常规时段——模板说明里写明。
 */
export const SAMPLES: SamplePlaybook[] = [
  { id: "dca", playbookId: "session_dca", title: { en: "Buy in three steps", zh: "分三次买入" }, what: { en: "Three steps at least one trading day apart, any hour; a missed window is deferred, never merged.", zh: "分三次买，每次至少隔一个交易日，24 小时都可以执行；错过就顺延，不合并。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }], eventKinds: [] },
  { id: "avoid_events", playbookId: "event_aware_accumulate", title: { en: "Avoid major events", zh: "避开重要事件" }, what: { en: "Waits 30 min before and 20 min after tier-1 macro releases and around the company's earnings, then buys.", zh: "一级宏观数据前 30 分钟、后 20 分钟，以及财报前后先等一等，再买。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }], eventKinds: ["EARNINGS", "MACRO_TIER1"] },
  { id: "calm", playbookId: "session_dca", title: { en: "Buy in calm markets", zh: "市场平静时再买" }, what: { en: "Buys only outside the Fed blackout period, when VIX is at or below 25, and away from tier-1 releases and Fed speeches.", zh: "只在联储静默期之外、VIX 不高于 25、且避开一级数据与联储讲话前后时买入。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }, { type: "not_in_fed_blackout" }, { type: "max_vix", value: 25 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1", "FED_SPEECH"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }], eventKinds: ["MACRO_TIER1", "FED_SPEECH"] },
  { id: "after_data", playbookId: "session_dca", title: { en: "Buy after data confirms", zh: "数据公布后确认再买" }, what: { en: "Stays out of the hour around tier-1 releases (CPI, jobs, FOMC); after a release, buys only once the cross-asset reaction reads as relief or transmission, not divergence.", zh: "一级数据（CPI、非农、FOMC）前后一小时不动；数据公布后，跨资产反应是「缓和」或「传导」才买，「背离」不买。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 60, afterMin: 60, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "require_cross_asset_confirmation", acceptStates: ["relief", "transmission"] }], eventKinds: ["MACRO_TIER1"] },
  { id: "discount", playbookId: "discount_watch", title: { en: "Watch a price condition", zh: "观察价格条件" }, what: { en: "Buys only when the on-chain price is at most 0.3% above the live reference. Needs a live reference, so it decides during US regular hours and waits otherwise.", zh: "链上价不高于实时参考价 0.3% 溢价时才买。需要实时参考价，所以只在美股常规时段有判断，其它时间等待。" }, steps: 2, conditions: [{ type: "premium_bps_lte", value: 30, referenceKind: "live", liveOnlyForExecution: true }], eventKinds: [], policyId: "STRICT_LIVE" },
];
export const sampleById = (id: string | null | undefined) => SAMPLES.find((s) => s.id === id) ?? null;
/** 草案只带 playbookId 时，取该 playbook 的第一套模板 */
export const sampleForPlaybook = (playbookId: string | null | undefined) => SAMPLES.find((s) => s.playbookId === playbookId) ?? null;

export interface CompareVariant {
  label: string;
  items: Condition[];
}
export const COMPARE_PRESETS: Array<{ id: string; title: { en: string; zh: string }; variants: [CompareVariant, CompareVariant] }> = [
  { id: "session", title: { en: "Regular US session only vs. 24 hours", zh: "只在美股常规时段 vs 24 小时" }, variants: [{ label: "regular_only", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }] }, { label: "any_hour", items: [{ type: "min_gap_trading_days", days: 1 }] }] },
  { id: "event_window", title: { en: "Avoid the event window vs. don't", zh: "避开事件窗口 vs 不避" }, variants: [{ label: "avoid_window", items: [{ type: "min_gap_trading_days", days: 1 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }] }, { label: "no_window", items: [{ type: "min_gap_trading_days", days: 1 }] }] },
  { id: "gap", title: { en: "1 trading day apart vs. 3", zh: "隔 1 个交易日 vs 隔 3 个" }, variants: [{ label: "gap_1", items: [{ type: "min_gap_trading_days", days: 1 }] }, { label: "gap_3", items: [{ type: "min_gap_trading_days", days: 3 }] }] },
];

/**
 * 示例任务（/start 与 /agent 共用）：都是目标式任务——没有条件规则，只有目标、策略文本和授权范围。
 * 策略文本按平台真实提供的东西写：事件日历（一级/二级宏观、联储讲话、财报与财报覆盖）、上下文（时段、VIX、联储静默期、跨资产反应）、
 * 每笔的链上报价 / 参考价溢价 / 价格冲击、持仓与成本、资金组与现金下限、四道核验与信任档位。何时买、买哪只、买多少由 agent 决定。
 */
export interface ComplexTask {
  id: string;
  title: { en: string; zh: string };
  /** agent 的决策空间（卡片副标题） */
  space: { en: string; zh: string };
  objective: { en: string; zh: string };
  strategy: { en: string; zh: string };
  /** 建议允许几只资产（从登记表前几只取） */
  assets: number;
  steps: number;
  days: number;
  watch: string[];
  trustTier: "platform_only" | "agent_data" | "agent_research";
  regularSessionOnly?: boolean;
  /** 扮演 agent 时预填的一笔意图理由与依据 */
  sampleIntent: { rationale: { en: string; zh: string }; claim: { en: string; zh: string } };
}
export const COMPLEX_TASKS: ComplexTask[] = [
  {
    id: "macro_allocation", title: { en: "Macro-driven allocation across two names", zh: "宏观数据驱动的双标的分配" },
    space: { en: "Reads each tier-1 release and the cross-asset reaction from the context, then decides which name gets the next tranche, how large, or whether to keep cash.", zh: "读每次一级数据与上下文里的跨资产反应，决定下一笔给哪只、多大，或者继续持币。" },
    objective: { en: "Over the next five trading days, deploy the budget across the two names I allowed according to how macro data lands, keeping cash whenever the reaction is unclear.", zh: "未来五个交易日，按宏观数据的落地情况把预算分配到我允许的两只股票上；反应不明就持币。" },
    strategy: { en: "Before each tranche read the event calendar (get_events) and the context (get_market_context): session, VIX, Fed blackout and the cross-asset state after the last tier-1 release (relief / transmission / divergence). No tranche within an hour of CPI, payrolls or FOMC. After a release: relief or orderly transmission → add to the name with the smaller reference premium and price impact in the Chaconne quote; divergence → keep cash and say so. Halve the next tranche after a hawkish surprise, and never let one name take more than two thirds of the budget. Every intent must cite the release and the cross-asset state it relied on.", zh: "每笔前先读事件日历（get_events）和上下文（get_market_context）：时段、VIX、联储静默期、上一次一级数据后的跨资产状态（缓和 / 传导 / 背离）。CPI、非农、FOMC 前后一小时不下单。数据公布后：反应是「缓和」或「有序传导」→ 把这一笔给 Chaconne 报价里参考价溢价和价格冲击更小的那只；「背离」→ 持币并说明。数据偏鹰就把下一笔减半；任何一只不得占预算超过三分之二。每条意图都要引用它依据的那次数据和跨资产状态。" },
    assets: 2, steps: 6, days: 7, watch: ["MACRO_TIER1", "MACRO_TIER2", "FED_SPEECH"], trustTier: "agent_data",
    sampleIntent: { rationale: { en: "CPI printed below expectations and the context reads the cross-asset state as relief; the first name has the smaller premium. Take one tranche there.", zh: "CPI 低于预期，上下文里的跨资产状态是「缓和」；第一只溢价更小，先给它一笔。" }, claim: { en: "CPI 3.1% vs 3.2% expected (bls.gov)", zh: "CPI 3.1%，预期 3.2%（bls.gov）" } },
  },
  {
    id: "earnings_ladder", title: { en: "Earnings-season ladder across three names", zh: "财报季三标的阶梯建仓" },
    space: { en: "Uses earnings coverage and each report's reaction to decide which name to add, how much, and which to drop; keeps a reserve for the last report.", zh: "用财报覆盖和每份财报后的反应决定加哪只、加多少、放弃哪只；给最后一份财报留预算。" },
    objective: { en: "Over the next three weeks, build positions in the three names I allowed one earnings report at a time, dropping any name whose guidance is cut.", zh: "未来三周，围绕我允许的三只股票的财报逐份建仓；下调指引的那只直接放弃。" },
    strategy: { en: "Use the calendar's EARNINGS events and the earnings-coverage flag for each name; if coverage is unknown for a name, do not touch it until it is known. Nothing the trading day before a report. After a report, judge beat/miss, guidance and the first regular session's reaction from the context; a clean beat with raised guidance gets a full tranche, an in-line print half a tranche, a guidance cut removes the name for the rest of the task. Check the reference premium per tranche and skip when the on-chain price is clearly above the live reference. Reserve at least a third of the budget until the last report; if it is unused at the end, say why.", zh: "用日历里的 EARNINGS 事件和每只股票的财报覆盖标记；某只覆盖未知就先不碰它。财报前一个交易日不动。财报后从上下文看超预期与否、指引、以及第一个常规时段的反应：干净超预期且上调指引给一整笔，符合预期给半笔，下调指引的那只这个任务里不再买。每笔查参考价溢价，链上价明显高于实时参考价就跳过。至少留三分之一预算到最后一份财报；最后没用完要说明原因。" },
    assets: 3, steps: 6, days: 21, watch: ["EARNINGS", "MACRO_TIER1"], trustTier: "agent_data",
    sampleIntent: { rationale: { en: "First report beat with guidance raised, and the first regular session held the gap; full tranche on that name.", zh: "第一份财报超预期且上调指引，第一个常规时段守住跳空，给这只一整笔。" }, claim: { en: "EPS 1.52 vs 1.40 est.; FY guide raised (company IR)", zh: "EPS 1.52，预期 1.40；全年指引上调（公司 IR）" } },
  },
  {
    id: "entry_quality", title: { en: "Entry quality: premium, impact and the calendar", zh: "按入场质量分批：溢价、冲击与日历" },
    space: { en: "Every round compares the allowed names on reference premium, price impact and upcoming releases; buys the best entry in tranches, or ends the task if none qualifies.", zh: "每一轮比较允许的股票的参考价溢价、价格冲击和临近的数据发布，分批买入场最好的那只；都不合格就结束任务。" },
    objective: { en: "Over the next ten days, buy only when the entry is good — small premium, low impact, no release in the hour — and give up if it never is.", zh: "未来十天，只在入场质量好的时候买——溢价小、冲击低、一小时内没有数据发布；一直不好就放弃。" },
    strategy: { en: "Each round pull the Chaconne quote for one tranche of each allowed name: executable price versus reference, premium in bps and adverse price impact. Only platform-verified facts count here. Qualify a name when the premium is not clearly positive against the live reference, the impact is under the task cap and no MACRO_TIER1 release falls within the next hour; among qualified names take the one with the lower premium. Wait at least one trading day between tranches. After three consecutive rounds with no qualified name, end the task and keep the cash, listing the premiums you saw.", zh: "每一轮取允许的每只股票一笔的 Chaconne 报价：可执行价对参考价、溢价 bps、不利价格冲击。这里只采信平台核验过的事实。溢价对实时参考价不明显为正、冲击低于任务上限、未来一小时没有一级数据发布的才算合格；合格的里买溢价更低的那只。两笔之间至少隔一个交易日。连续三轮都没有合格的就结束任务、保留现金，并列出你看到的溢价。" },
    assets: 2, steps: 4, days: 10, watch: ["MACRO_TIER1"], trustTier: "platform_only",
    sampleIntent: { rationale: { en: "The first name trades closest to reference with the lower impact and nothing is due this hour; one tranche now.", zh: "第一只最接近参考价、冲击更低，这一小时没有数据发布，现在买一笔。" }, claim: { en: "premium 0.1% vs 0.6% for the other name (Chaconne quote)", zh: "溢价 0.1%，另一只 0.6%（Chaconne 报价）" } },
  },
  {
    id: "thesis_and_cost", title: { en: "Thesis-tracked adds with a cost discipline", zh: "跟踪投资理由的加仓，兼顾成本与现金下限" },
    space: { en: "Re-tests my thesis against new earnings and macro data, sizes each add against my tracked cost and the budget group's cash floor, and stops with reasons when the thesis weakens.", zh: "用新的财报与宏观数据检验我的理由，按持仓成本和资金组现金下限决定每笔大小，理由变弱就停下来说明。" },
    objective: { en: "Over the next month, keep adding to one name while my investment thesis holds, without breaching my cash floor; stop and explain when it weakens.", zh: "未来一个月，只要我的投资理由仍成立就持续加仓一只股票，不能击穿现金下限；理由变弱就停下来解释。" },
    strategy: { en: "My thesis: (write it here). Before each tranche: read the portfolio (get_portfolio) for the current holding and tracked cost, the budget group for the cash floor, and the latest EARNINGS / MACRO_TIER1 events. Add one tranche per week while the thesis holds; if the on-chain price is more than 10% above my tracked cost, halve the tranche; if a datapoint contradicts the thesis, halve again and log it in the thesis review; after two contradictions stop and end the task. Never propose a tranche that would take cash below the floor. Research conclusions are allowed as a basis in this task, but label them.", zh: "我的理由是：（写在这里）。每笔前：读组合（get_portfolio）拿当前持仓与跟踪成本，读资金组拿现金下限，读最新的财报与一级宏观事件。理由成立就每周加一笔；链上价高于我的跟踪成本 10% 以上就把这笔减半；有一条数据与理由矛盾再减半并写进理由卡复核；两条矛盾就停止并结束任务。任何一笔都不能让现金低于下限。这个任务允许以研究结论为依据，但要标注。" },
    assets: 1, steps: 8, days: 30, watch: ["EARNINGS", "MACRO_TIER1", "FED_SPEECH"], trustTier: "agent_research",
    sampleIntent: { rationale: { en: "No datapoint contradicts the thesis this week, price is within 10% of tracked cost and cash stays above the floor; weekly tranche.", zh: "本周没有数据与理由矛盾，价格在跟踪成本 10% 以内，现金仍高于下限，按计划加本周的一笔。" }, claim: { en: "Channel checks still show growing demand (own research)", zh: "渠道调研仍显示需求在增长（自己的研究）" } },
  },
  {
    id: "calm_regime", title: { en: "Build only in a calm regime, regular hours signed", zh: "只在平静时建仓，常规时段写进签名" },
    space: { en: "Judges VIX, Fed blackout, drift verdict and the calendar itself; the only hard rule is US regular hours, signed into the scope.", zh: "VIX、联储静默期、上下文的漂移判断、事件日历都由 agent 自己权衡；唯一硬约束是美股常规时段，写进签名。" },
    objective: { en: "Over the next two weeks, build a position slowly and only while markets are calm; stop when stress persists.", zh: "未来两周，只在市场平静时慢慢建仓；压力持续就停。" },
    strategy: { en: "Read the context each round: VIX (treat above 25 as not calm), Fed blackout (wait), drift verdict (skip when it reads risk-off) and any tier-1 release or Fed speech within two hours (wait). When calm, buy one tranche at most every other trading day; when the quote's price impact is above half the task cap, halve the tranche. If markets stay stressed for five consecutive rounds, end the task and keep the cash. Regular hours are enforced by the signed scope, so do not spend rounds arguing about the session.", zh: "每一轮读上下文：VIX（高于 25 算不平静）、联储静默期（等）、漂移判断（读作 risk-off 就跳过）、两小时内的一级数据或联储讲话（等）。平静时最多每隔一个交易日买一笔；报价的价格冲击超过任务上限一半时把这笔减半。连续五轮都不平静就结束任务、保留现金。常规时段由签过的范围强制，不用在轮次里反复讨论时段。" },
    assets: 1, steps: 6, days: 14, watch: ["MACRO_TIER1", "FED_SPEECH"], trustTier: "platform_only", regularSessionOnly: true,
    sampleIntent: { rationale: { en: "Calm regime: VIX below 25, no blackout, drift neutral, nothing due for two hours. One tranche.", zh: "平静：VIX 低于 25、不在静默期、漂移中性、两小时内没有数据，买一笔。" }, claim: { en: "VIX 17.8 from the Chaconne context snapshot", zh: "Chaconne 上下文快照 VIX 17.8" } },
  },
];

/** /agent 目标表单里的示例策略 = 同一套示例任务：点一下只往策略框里填文字（目标为空时也填目标、并带上关注事件与信任档位），随便改 */
export interface ExampleStrategy { id: string; title: { en: string; zh: string }; space: { en: string; zh: string }; text: { en: string; zh: string }; objective: { en: string; zh: string }; watch: string[]; trustTier: ComplexTask["trustTier"] }
export const EXAMPLE_STRATEGIES: ExampleStrategy[] = COMPLEX_TASKS.map((t) => ({ id: t.id, title: t.title, space: t.space, text: t.strategy, objective: t.objective, watch: t.watch, trustTier: t.trustTier }));
