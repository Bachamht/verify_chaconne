/**
 * 规划引擎 × 真实 OKX 阶梯报价（PL-01..PL-05 的 LIVE 证据，I2 集成验证）。
 * 只读：拉阶梯报价与共享证据 → core buildPlanReport → 打印候选表、推荐、planHash；不建任务、不签证书、不发交易。
 * 环境：apps/verify-service/.env（OKX + Finnhub + registry）。可调 POLICY、BUDGET_RAW、LADDER、SIDE、LEGS。
 * 证据写 .probes/<ts>_LIVE_plan.json。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLadder, buildPlanReport, type PlanGoal } from "@chaconne/core/verify";
import { loadConfig } from "../src/config";
import { loadRegistry } from "../src/registry";
import { LiveEvidenceProvider, type LadderLeg } from "../src/evidence/live";
import { OkxClient } from "../src/adapters/okx/client";
import { FinnhubClient } from "../src/adapters/finnhub";

const OUT = join(process.cwd(), "..", "..", "OKX dev day", "probes");
const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const USDC = "eip155:196:0xb6ceceab302e2e4948951ee7843fc24e92933061";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const NVDAX = "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const cfg = loadConfig();
  const registry = loadRegistry(cfg);
  const provider = new LiveEvidenceProvider({
    okx: new OkxClient({ apiKey: cfg.OKX_API_KEY, secretKey: cfg.OKX_SECRET_KEY, passphrase: cfg.OKX_PASSPHRASE, baseUrl: cfg.OKX_API_BASE_URL }),
    finnhub: cfg.FINNHUB_API_KEY ? new FinnhubClient(cfg.FINNHUB_API_KEY) : null,
    rpcUrl: cfg.XLAYER_RPC_URL,
    guardAddress: (cfg.GUARD_ADDRESS || null) as `0x${string}` | null,
    approvedRouter: (cfg.ROUTER_ADDRESS || null) as `0x${string}` | null,
    approvedSpender: (cfg.SPENDER_ADDRESS || null) as `0x${string}` | null,
    closeClassification: "v2",
  });

  const basket = process.env["LEGS"] === "2";
  const goal: PlanGoal = {
    ownerAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381",
    recipientAddress: "0xbacb138e0e9e1444bae9b401c4615378c57c0381",
    executionChainId: 196,
    legs: basket ? [{ outputAssetKey: AAPLX, weightBps: 6000 }, { outputAssetKey: NVDAX, weightBps: 4000 }] : [{ outputAssetKey: AAPLX, weightBps: 10000 }],
    budget: { inputAssetKeys: process.env["MULTI_INPUT"] === "1" ? [USDG, USDC] : [USDG], amountInRaw: process.env["BUDGET_RAW"] ?? "10000000" },
    // SIDE 文档里一直写着可调，但之前没接上（env 给了也没用，仍按买入跑）。
    // 约定同 V-18：卖出时 budget/legs 仍按买入形状书写（预算=资金币种、腿=股票），由 side 翻转链上方向。
    side: (process.env["SIDE"] === "sell" ? "sell" : "buy") as PlanGoal["side"],
    policyId: (process.env["POLICY"] ?? "REFERENCE_CONTEXT") as PlanGoal["policyId"],
    policyVersion: process.env["POLICY_VERSION"] ?? "1.1.0",
    maxSlippageBps: 50,
    maxPriceImpactBps: Number(process.env["MAX_IMPACT_BPS"] ?? 100),
    maxReferenceDeviationBps: 300,
    deadline: new Date(Date.now() + 3600_000).toISOString(),
    ...(process.env["LADDER"] ? { ladderBps: process.env["LADDER"].split(",").map(Number) } : {}),
  };

  const specs = buildLadder(goal, registry);
  console.info(`候选 ${specs.length} 个（腿 ${goal.legs.length}，资金币种 ${goal.budget.inputAssetKeys.length}）`);
  const byLeg = new Map<string, LadderLeg>();
  for (const s of specs) {
    const k = `${s.legIndex}:${s.inputAssetKey}`;
    const leg = byLeg.get(k) ?? { legIndex: s.legIndex, inputAssetKey: s.inputAssetKey, outputAssetKey: s.outputAssetKey, amounts: [] };
    leg.amounts.push(s.amountInRaw);
    byLeg.set(k, leg);
  }
  const nowIso = new Date().toISOString();
  const ladder = await provider.quoteLadder([...byLeg.values()], registry, nowIso);
  console.info(`quote 调用 ${ladder.quoteCalls} 次，成功 ${ladder.quotes.filter((q) => q.ok).length}/${ladder.quotes.length}，证据 ${ladder.evidence.length} 条`);
  for (const q of ladder.quotes.filter((x) => !x.ok)) console.info(`  失败 leg${q.legIndex} ${q.amountInRaw}: ${q.error}`);

  const quoteFor = (spec: (typeof specs)[number]) => {
    const hit = ladder.quotes.find((q) => q.legIndex === spec.legIndex && q.inputAssetKey === spec.inputAssetKey && q.amountInRaw === spec.amountInRaw);
    return hit?.evidenceId ? (ladder.evidence.find((e) => e.evidenceId === hit.evidenceId) ?? null) : null;
  };
  const quotes: Record<string, (typeof ladder.evidence)[number] | null> = {};
  for (const s of specs) quotes[s.candidateId] = quoteFor(s);
  const shared = ladder.evidence.filter((e) => e.payload.kind !== "okx_quote");

  const report = buildPlanReport({ planId: `plan_live_${Date.now().toString(16)}`, goal, registry, specs, evidence: { shared, quotes }, evaluatedAt: nowIso });
  console.info("\n候选表：");
  for (const c of report.candidates) {
    const blocking = c.reasons.filter((r) => r.severity === "block").map((r) => r.code);
    console.info(
      `  leg${c.legIndex} ${c.completionBps / 100}% ${c.inputAssetKey.slice(-6)} in=${c.amountInRaw} out=${c.expectedOutRaw ?? "—"} impact=${c.adverseImpactBps ?? "?"}bps → ${c.chosenPolicyVerdict.padEnd(8)} ${c.nextStep}${blocking.length ? " [" + blocking.join(",") + "]" : ""}`,
    );
  }
  console.info(`\n推荐：${report.recommended ?? "（无可行候选）"}`);
  console.info(`planHash ${report.planHash}\ngoalHash ${report.goalHash}\nevidenceHash ${report.evidenceHash}`);

  // 确定性复核：同证据集合重算必须一致（PL-01）
  const again = buildPlanReport({ planId: report.planId, goal, registry, specs, evidence: { shared, quotes }, evaluatedAt: nowIso });
  console.info(`确定性复核 planHash 一致: ${again.planHash === report.planHash}`);

  writeFileSync(join(OUT, `${nowIso.replace(/[:.]/g, "-")}_LIVE_plan.json`), JSON.stringify({ goal, quoteCalls: ladder.quoteCalls, ladderQuotes: ladder.quotes, report, deterministic: again.planHash === report.planHash }, null, 2));
}

main().catch((e) => {
  console.error("规划 LIVE 失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
