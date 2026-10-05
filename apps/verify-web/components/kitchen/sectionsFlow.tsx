"use client";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { StepFlow } from "@/components/kit/StepFlow";
import { Blockers } from "@/components/kit/Blockers";
import { Countdown, Timestamp } from "@/components/kit/Timestamp";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { EvidencePanel } from "@/components/kit/EvidencePanel";
import { Amount } from "@/components/kit/Amount";
import { Mascot } from "@/components/kit/Mascot";
import { CodeBlock } from "@/components/kit/CodeBlock";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export function FlowSection() {
  return (
    <Panel>
      <Panel.Header eyebrow="06" title="StepFlow · Blockers" />
      <Panel.Body className="grid gap-6 lg:grid-cols-2">
        <StepFlow aria-label="执行四步">
          <StepFlow.Step state="done" index={1} title="连接钱包" meta={<Timestamp at={ago(12)} mode="rel" />} />
          <StepFlow.Step state="done" index={2} title="授权额度" description="只授权本步需要的金额，不做无限授权。" />
          <StepFlow.Step state="active" index={3} title="再核验" meta={<>证书剩余 <Countdown to={new Date(Date.now() + 9 * 60_000).toISOString()} /></>} description="报价与证据刷新中。" />
          <StepFlow.Step state="failed" index={4} title="签名并发送" description="钱包拒绝了签名。点「重试」重新发起。"><Button size="sm" variant="outline">重试</Button></StepFlow.Step>
          <StepFlow.Step state="idle" index={5} title="链上确认" last />
        </StepFlow>
        <div className="flex min-w-0 flex-col gap-4">
          <StepFlow orientation="horizontal" aria-label="引导步骤">
            <StepFlow.Step state="done" index={1} title="交代" />
            <StepFlow.Step state="active" index={2} title="观察" />
            <StepFlow.Step state="idle" index={3} title="授权" last />
          </StepFlow>
          <Blockers items={[
            { code: "MARKET_OUTSIDE_REGULAR", nextCheckAt: new Date(Date.now() + 40 * 60_000).toISOString() },
            { code: "SELL_MANDATE_REQUIRED" },
            { code: "QUOTE_UNAVAILABLE" },
            { code: "SOMETHING_NEW_FROM_SERVER" },
          ]} />
          <p className="text-xs text-fg-3">暂停态（hideNextCheck）：</p>
          <Blockers hideNextCheck items={[{ code: "TARGET_NOT_REACHED", nextCheckAt: new Date().toISOString() }]} />
        </div>
      </Panel.Body>
    </Panel>
  );
}

export function StatesSection() {
  return (
    <Panel>
      <Panel.Header eyebrow="08" title="FourStates" description="loading（等形骨架，10 s 后提示）· empty（原因 + 动作）· error（修法 + 编号）" />
      <Panel.Body className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-md border p-4"><LoadingBlock rows={4} onRetry={() => undefined} /></div>
        <div className="rounded-md border"><EmptyState art={<Mascot alt="小指挥家" />} title="今晚还没有任务" description="交代一个目标，Agent 会先观察给你看。" action={<Button size="sm">新建任务</Button>} /></div>
        <div className="rounded-md border"><ErrorState status={502} requestId="req_8f2a91c0d3e4" onRetry={() => undefined} /></div>
        <div className="rounded-md border lg:col-span-3"><ErrorState size="sm" onRetry={() => undefined} /></div>
      </Panel.Body>
    </Panel>
  );
}

export function EvidenceSection() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" id="evidence">
      <EvidencePanel>
        <EvidencePanel.Header title="报价与依据" count={3} />
        <EvidencePanel.Item source="okx-dex · aggregator/quote" at={ago(3)} mode="LIVE" hash="ev_01J9QX2B7K"><Amount value="336.88" prefix="$" maxFrac={2} minFrac={2} /></EvidencePanel.Item>
        <EvidencePanel.Item source="收盘价 · nasdaq last trade" at={ago(900)} mode="backfill" hash="ev_01J9QX2C11"><Amount value="337.02" prefix="$" maxFrac={2} minFrac={2} /></EvidencePanel.Item>
        <EvidencePanel.Item source="示例上下文" at={ago(60)} mode="sample" />
        <EvidencePanel.Raw json={{ quoteId: "q_123", amountInRaw: "3000000", priceImpactBps: 4 }} />
      </EvidencePanel>
      <CodeBlock language="bash" code={"curl -s https://verify.chaconne.xyz/healthz | jq .release\n# a very long line that must scroll inside the block instead of widening the page ------------------------------------------------"} />
    </div>
  );
}
