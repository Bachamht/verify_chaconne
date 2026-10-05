"use client";
/**
 * 步骤时间线（StepFlow 竖排）：买入授权的每一步 idle / active / done / failed；成交回执（tx 哈希 + 花费）挂在步骤上。
 * 只有链上确认算成交。卖出成交另列（如果有）。
 */
import { Panel } from "@/components/kit/Panel";
import { StepFlow } from "@/components/kit/StepFlow";
import { Amount } from "@/components/kit/Amount";
import { Hash } from "@/components/kit/Hash";
import { EmptyState } from "@/components/kit/FourStates";
import { useI18n } from "@/lib/i18n";
import type { AssetEntry } from "@/lib/assets";
import { stepTimeline, type FillLite } from "./consoleModel";

export function StepsPanel({ planned, fills, buyMandateId, running, stable, sim }: {
  planned: number | null;
  fills: FillLite[];
  buyMandateId: string | null;
  running: boolean;
  stable: AssetEntry | null;
  sim: boolean;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const steps = stepTimeline(planned, fills, buyMandateId, running);
  const others = fills.filter((f) => buyMandateId && f.mandateId !== buyMandateId);
  const confirmed = fills.filter((f) => f.state === "CONFIRMED" && (!buyMandateId || f.mandateId === buyMandateId)).length;
  return (
    <Panel className="ch-console-steps" aria-label={zh ? "步骤与成交" : "Steps and fills"}>
      <Panel.Header
        title={zh ? "步骤与成交" : "Steps and fills"}
        description={zh ? "只计链上已确认的成交；签发证书、广播交易都还不算。" : "Only on-chain confirmed fills count; an issued certificate or a broadcast transaction does not."}
        action={planned ? <span className="ch-fill-progress"><strong>{confirmed}</strong><span>/ {planned}</span></span> : undefined}
      />
      <Panel.Body>
        {sim ? <EmptyState size="sm" title={zh ? "观察任务不执行交易" : "Observation tasks do not trade"} description={zh ? "Agent 只给建议，不签证书、不成交。想真实运行，从这次观察创建一个真实任务。" : "The agent only suggests; nothing is certified or filled. To run for real, create a live task from this observation."} />
          : steps.length === 0 ? <EmptyState size="sm" title={zh ? "步骤数未返回" : "Step count not returned"} />
          : (
          <StepFlow className="ch-execution-timeline" aria-label={zh ? "买入步骤" : "Buy steps"}>
            {steps.map((st, i) => (
              <StepFlow.Step
                key={st.index}
                index={st.index + 1}
                state={st.state}
                locale={locale}
                last={i === steps.length - 1}
                title={st.state === "done" ? (zh ? `第 ${st.index + 1} 步 · 已成交` : `Step ${st.index + 1} · filled`) : st.state === "active" ? (st.fill ? (zh ? `第 ${st.index + 1} 步 · 已发出，等链上确认` : `Step ${st.index + 1} · sent, awaiting confirmation`) : (zh ? `第 ${st.index + 1} 步 · 等条件满足` : `Step ${st.index + 1} · waiting for conditions`)) : st.state === "failed" ? (zh ? `第 ${st.index + 1} 步 · 没有成功` : `Step ${st.index + 1} · did not go through`) : (zh ? `第 ${st.index + 1} 步` : `Step ${st.index + 1}`)}
              >
                {st.fill ? (
                  <div className="ch-fill-receipt">
                    {st.fill.spent ? <span>{zh ? "花费 " : "Spent "}<Amount raw={st.fill.spent} decimals={stable?.tokenDecimals ?? null} symbol={stable?.displaySymbol} maxFrac={2} /></span> : null}
                    {st.fill.txHash ? <Hash value={st.fill.txHash} kind="tx" /> : null}
                  </div>
                ) : null}
              </StepFlow.Step>
            ))}
          </StepFlow>
        )}
        {others.length > 0 ? (
          <div className="ch-sell-fills">
            <h3>{zh ? "卖出成交" : "Sell fills"}</h3>
            <ul>
              {others.map((f) => (
                <li key={`${f.mandateId}:${f.stepIndex}`} className="ch-fill-receipt">
                  <span className="text-fg-1">{f.state === "CONFIRMED" ? (zh ? "已成交" : "Filled") : (zh ? "已发出，等确认" : "Sent, awaiting confirmation")}</span>
                  {f.txHash ? <Hash value={f.txHash} kind="tx" /> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel.Body>
    </Panel>
  );
}
