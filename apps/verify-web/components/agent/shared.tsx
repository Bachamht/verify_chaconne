"use client";
/** /agent 页面族共用：子导航壳、「尚未就绪」空态、模式标签、owner 输入。值全部走 globals.css token。 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { PlugZap } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { EmptyState, Pill } from "@/components/ui";
import "./agent.css";

const SUB = [
  { href: "/agent", key: "nav_agent" },
  { href: "/agent/tasks", key: "nav_agent_tasks" },
  { href: "/agent/events", key: "nav_agent_events" },
  { href: "/agent/funds", key: "nav_agent_funds" },
  { href: "/agent/lab", key: "nav_agent_lab" },
  { href: "/agent/journal", key: "nav_agent_journal" },
] as const;

export function AgentShell({ children }: { children: ReactNode }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  const active = (href: string) => (href === "/agent" ? pathname === "/agent" : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <div className="ag-page">
      <nav className="ag-subnav" aria-label={locale === "zh" ? "Agent 子页" : "Agent sections"}>
        {SUB.map((s) => (
          <Link key={s.href} href={s.href} aria-current={active(s.href) ? "page" : undefined}>{t(s.key)}</Link>
        ))}
      </nav>
      {children}
    </div>
  );
}

/** 端点未部署 / 服务不可达：明确空态，不放假数据 */
export function NotReady({ what, status, compact = true }: { what?: string; status?: number; compact?: boolean }) {
  const { t } = useI18n();
  // 文案按状态码分：只有 404/501/502/503 才是「端点未部署 / 不可达」；4xx 是请求被拒（鉴权、参数），5xx 是服务端出错——写成「未部署」会误导排查（服务器 2026-09-23 反馈）
  const kind = !status || status === 404 || status === 501 || status === 502 || status === 503 ? "ag_not_ready_p" : status >= 500 ? "ag_not_ready_5xx" : "ag_not_ready_4xx";
  return <EmptyState compact={compact} icon={<PlugZap size={26} strokeWidth={1.5} />} title={what ? `${t("ag_not_ready_h")} · ${what}` : t("ag_not_ready_h")} description={<>{t(kind)}{status ? <span className="mono"> (HTTP {status})</span> : null}</>} />;
}

export type Mode = "SIMULATION" | "REPLAY" | "LIVE" | "FIXTURE" | "sample" | "backfill" | "live" | "unknown";
/** R-03 / CV-D13：三种标识必须可见；sample / backfill 永远不渲染成实时 */
export function ModeTag({ mode }: { mode: Mode }) {
  const { t } = useI18n();
  const m = String(mode);
  if (m === "LIVE" || m === "live") return <Pill tone="ok">{t("ag_mode_live")}</Pill>;
  if (m === "REPLAY" || m === "backfill") return <Pill tone="info">{m === "backfill" ? t("ag_mode_backfill") : t("ag_mode_replay")}</Pill>;
  if (m === "SIMULATION") return <Pill tone="brand">{t("ag_mode_sim")}</Pill>;
  if (m === "sample") return <Pill tone="warn">{t("ag_mode_sample")}</Pill>;
  if (m === "FIXTURE") return <Pill tone="warn">{t("ag_mode_fixture")}</Pill>;
  return <Pill tone="neutral">{m}</Pill>;
}

/** owner：已连接钱包优先；否则允许手填地址（只读页面），不弹窗 */
export function useOwnerInput(): { owner: string; setOwner: (v: string) => void; connected: string | null; valid: boolean } {
  const connected = useAccount();
  const [owner, setOwner] = useState("");
  useEffect(() => {
    if (connected) setOwner(connected);
  }, [connected]);
  return { owner, setOwner, connected, valid: /^0x[0-9a-fA-F]{40}$/.test(owner) };
}

export function OwnerField({ owner, setOwner, connected }: { owner: string; setOwner: (v: string) => void; connected: string | null }) {
  const { locale } = useI18n();
  return (
    <label className="ag-span">
      {locale === "zh" ? "钱包地址（owner）" : "Wallet address (owner)"}
      <input className="field mono" value={owner} onChange={(e) => setOwner(e.target.value.trim())} placeholder="0x…" spellCheck={false} disabled={!!connected} />
    </label>
  );
}

export const shortKey = (k: string) => (k.includes(":") ? `${k.split(":")[2]?.slice(0, 6)}…${k.slice(-4)}` : k);
