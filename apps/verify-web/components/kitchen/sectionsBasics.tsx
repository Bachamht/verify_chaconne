"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { Panel } from "@/components/kit/Panel";
import { ModeTag, StatusBadge, ToneTag } from "@/components/kit/StatusBadge";
import { Amount } from "@/components/kit/Amount";
import { Hash } from "@/components/kit/Hash";
import { Countdown, Timestamp } from "@/components/kit/Timestamp";
import { EVIDENCE_MODES, UI_STATUSES } from "@/lib/status";

const SURFACES = ["bg-surface-0", "bg-surface-1", "bg-surface-2", "bg-surface-3", "bg-surface-brand", "bg-surface-warn"];
const STATES = ["bg-ok", "bg-info", "bg-warn", "bg-bad", "bg-brand-600", "bg-brand-400"];

export function TokensSection() {
  return (
    <Panel>
      <Panel.Header eyebrow="01" title="Tokens" description="surface 0–3 · brand · state · type scale 12–40" />
      <Panel.Body className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">{SURFACES.map((c) => <div key={c} className={`flex h-14 w-28 items-end rounded-md border p-2 text-xs text-fg-2 ${c}`}>{c.replace("bg-", "")}</div>)}</div>
        <div className="flex flex-wrap gap-2">{STATES.map((c) => <div key={c} className={`flex h-10 w-28 items-end rounded-md p-2 text-xs text-surface-0 ${c}`}>{c.replace("bg-", "")}</div>)}</div>
        <div className="flex flex-col gap-1">
          <p className="text-display font-semibold">40 display</p>
          <p className="text-kpi font-semibold tabular-nums">28 kpi 1,234.56</p>
          <p className="text-title font-semibold">20 title 页面标题</p>
          <p className="text-md font-medium">16 md 卡片标题</p>
          <p className="text-base">14 base 正文 body text</p>
          <p className="text-sm text-fg-2">13 sm 表格 / 次要说明</p>
          <p className="text-xs text-fg-3">12 xs 表头 · 徽章 · 时间戳</p>
          <p className="font-mono text-xs text-fg-2">JetBrains Mono 0xbacb4f2a9d27e1c0381</p>
        </div>
      </Panel.Body>
    </Panel>
  );
}

export function ButtonsSection() {
  const [pending, setPending] = useState(false);
  return (
    <Panel>
      <Panel.Header eyebrow="02" title="Buttons" description="一张卡 ≤ 1 主动作 + 1 次动作；异步三态；禁用必须有可见原因" />
      <Panel.Body className="flex flex-wrap items-start gap-3">
        <Button><Plus aria-hidden="true" />新建任务</Button>
        <Button variant="outline">次要动作</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">取消任务</Button>
        <Button variant="link">链接</Button>
        <Button size="sm">Small</Button>
        <AsyncButton pending={pending} pendingLabel="签名中…" onClick={() => { setPending(true); setTimeout(() => setPending(false), 2000); }}>签授权并等待</AsyncButton>
        <AsyncButton disabled disabledReason="先连接钱包才能签名">签授权并等待</AsyncButton>
      </Panel.Body>
    </Panel>
  );
}

export function BadgesSection() {
  const soon = new Date(Date.now() + 12 * 60_000).toISOString();
  const past = new Date(Date.now() - 2 * 3600_000).toISOString();
  return (
    <Panel>
      <Panel.Header eyebrow="03" title="Status · Amount · Hash · Time" />
      <Panel.Body className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">{UI_STATUSES.map((s) => <StatusBadge key={s} status={s} />)}</div>
        <div className="flex flex-wrap gap-2">{EVIDENCE_MODES.map((m) => <ModeTag key={m} mode={m} />)}<ToneTag tone="brand">brand</ToneTag></div>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <span>raw 5000000 / 6 → <Amount raw="5000000" decimals={6} symbol="USDG" maxFrac={2} /></span>
          <span>大数 → <Amount raw="123456789012" decimals={6} symbol="USDG" maxFrac={2} minFrac={2} /></span>
          <span>价格 → <Amount value="337.0234" prefix="$" maxFrac={2} minFrac={2} /></span>
          <span>compact → <Amount value="1234567" compact /></span>
          <span>未返回 → <Amount raw={null} decimals={6} symbol="USDG" /></span>
          <span>股数 → <Amount raw="12345678901234567" decimals={18} symbol="AAPLx" maxFrac={6} /></span>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <span>tx <Hash value="0x9d27a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789890a" kind="tx" /></span>
          <span>named <Hash value="0x535E00000000000000000000000000000000516C" kind="address" name="平台执行身份" /></span>
          <span>id <Hash value="tsk_c7bc0d49075b80b3d83e1a8c" kind="id" /></span>
          <span>missing <Hash value={null} /></span>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-fg-2">
          <span>both <Timestamp at={past} /></span>
          <span>rel <Timestamp at={past} mode="rel" /></span>
          <span>abs <Timestamp at={past} mode="abs" /></span>
          <span>countdown <Countdown to={soon} /></span>
          <span>missing <Timestamp at={null} /></span>
        </div>
      </Panel.Body>
    </Panel>
  );
}
