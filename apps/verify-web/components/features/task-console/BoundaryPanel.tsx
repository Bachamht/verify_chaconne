"use client";
/** 「边界」：签名覆盖的范围（scope），直接可读。PlanGuard 只约束经合约的步骤，这句话保留。 */
import type { Task } from "@chaconne/core/verify";
import { ShieldCheck } from "lucide-react";
import { Amount } from "@/components/kit/Amount";
import { KeyValue } from "@/components/kit/KeyValue";
import { Panel } from "@/components/kit/Panel";
import { Timestamp } from "@/components/kit/Timestamp";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { conditionText } from "@/lib/conditions";
import { useI18n } from "@/lib/i18n";

export function BoundaryPanel({ scope, assets, stable }: { scope: NonNullable<Task["scope"]>; assets: AssetEntry[]; stable: AssetEntry | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const sym = (k: string) => assetByKey(assets, k)?.displaySymbol ?? (zh ? "未知资产" : "Unknown asset");
  const money = (raw: string) => <Amount raw={raw} decimals={stable?.tokenDecimals ?? null} symbol={stable?.displaySymbol} maxFrac={2} />;
  const trust = scope.trustTier === "platform_only" ? (zh ? "只信 Chaconne 核验过的事实" : "Only facts verified by Chaconne") : scope.trustTier === "agent_data" ? (zh ? "也接受 Agent 带来源的数据（未核验）" : "Also sourced data from the agent (unverified)") : (zh ? "也接受 Agent 的研究结论（未核验）" : "Also the agent's research conclusions (unverified)");
  return (
    <Panel className="ch-boundary-panel" aria-label={zh ? "边界" : "Boundary"}>
      <Panel.Header title={zh ? "边界" : "Boundary"} description={zh ? "你签的范围，合约按它执行。" : "The scope you signed; the contract enforces it."} action={<ShieldCheck className="size-5 text-fg-3" aria-hidden="true" />} />
      <Panel.Body className="ch-boundary-body">
        {scope.objective ? <p className="ch-boundary-objective">{scope.objective}</p> : null}
        <div className="ch-boundary-assets">
          <h3>{zh ? "允许买入" : "May buy"}</h3>
          {scope.outputAssetKeys.length > 0 ? <ul>{scope.outputAssetKeys.map((key) => <li key={key}>{sym(key)}</li>)}</ul> : <span className="text-sm text-fg-3">—</span>}
        </div>
        <dl className="ch-boundary-budget">
          <div><dt>{zh ? "总预算" : "Total budget"}</dt><dd>{money(scope.budgetCapRaw)}</dd></div>
          <div><dt>{zh ? "每笔上限" : "Per step"}</dt><dd>{money(scope.perStepCapRaw)}</dd></div>
        </dl>
        <KeyValue className="ch-boundary-details" dense items={[
          { label: zh ? "最多笔数" : "Max steps", value: <span className="tabular-nums">{scope.maxSteps}</span> },
          { label: zh ? "有效期至" : "Valid until", value: <Timestamp at={scope.deadline} mode="abs" /> },
          { label: zh ? "卖出" : "Selling", value: scope.allowSell ? (zh ? "允许（另签卖出授权，可卖出钱包原有持仓）" : "Allowed (separate sell authorization; may include coins you already held)") : (zh ? "不允许" : "Not allowed") },
          { label: zh ? "信任档位" : "Trust tier", value: trust },
          { label: zh ? "谁来发起" : "Issuance", value: scope.issuance === "agent" ? (zh ? "Agent 提交意图后才签发" : "Only on agent trade intents") : (zh ? "平台按计划条件" : "Platform, by plan conditions") },
          ...(scope.hardConditions.length > 0 ? [{ label: zh ? "硬约束" : "Hard constraints", value: <span className="flex flex-col">{scope.hardConditions.map((c, i) => <span key={i}>{conditionText(c, locale)}</span>)}</span> }] : []),
        ]} />
        <p className="ch-boundary-note">{zh ? "PlanGuard 对经合约的每一步执行这个范围；Agent 用自己持有完整私钥的钱包绕开合约发的交易不在约束内。" : "PlanGuard enforces this scope on every step through the contract; transactions an agent sends outside the contract from a wallet whose key it fully holds are not constrained."}</p>
      </Panel.Body>
    </Panel>
  );
}
