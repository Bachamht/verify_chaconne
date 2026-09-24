"use client";
/** /agent 页面族共用：页面壳、「尚未就绪」空态、加载态、toast、模式标签、owner 输入。值全部走 globals.css token。 */
import { useEffect, useState, type ReactNode } from "react";
import { PlugZap } from "lucide-react";
import { API_SLOW_MS } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { EmptyState, Pill } from "@/components/ui";
import "./agent.css";

/** V-47：子导航 pill 已删除——全站只有页头一套导航 */
export function AgentShell({ children }: { children: ReactNode }) {
  return <div className="ag-page">{children}</div>;
}

/** 端点未部署 / 服务不可达 / 超时：明确空态，不放假数据；status 0 = 30 s 无回应或网络错误，给「重试」 */
export function NotReady({ what, status, compact = true, onRetry }: { what?: string; status?: number; compact?: boolean; onRetry?: () => void }) {
  const { t } = useI18n();
  // 文案按状态码分：只有 404/501/502/503 才是「端点未部署 / 不可达」；4xx 是请求被拒（鉴权、参数），5xx 是服务端出错——写成「未部署」会误导排查（服务器 2026-09-23 反馈）
  const timedOut = !status;
  const kind = timedOut ? "ag_timed_out_p" : status === 404 || status === 501 || status === 502 || status === 503 ? "ag_not_ready_p" : status >= 500 ? "ag_not_ready_5xx" : "ag_not_ready_4xx";
  return <EmptyState compact={compact} icon={<PlugZap size={26} strokeWidth={1.5} />} title={timedOut ? t("ag_timed_out_h") : what ? `${t("ag_not_ready_h")} · ${what}` : t("ag_not_ready_h")} description={<>{t(kind)}{status ? <span className="mono"> (HTTP {status})</span> : null}</>} primary={onRetry ? { label: t("ag_retry"), onClick: onRetry } : undefined} />;
}

/** 加载态（V-29）：先「加载中…」，10 s 后变成「还在加载 · 重试」；30 s 硬超时由 api() 负责 */
export function LoadingState({ onRetry, label }: { onRetry?: () => void; label?: string }) {
  const { t } = useI18n();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), API_SLOW_MS);
    return () => clearTimeout(id);
  }, []);
  return (
    <p className="ag-note ag-loading" role="status" aria-live="polite">
      <span className="ag-spinner" aria-hidden="true" />
      {slow ? t("ag_still_loading") : (label ?? t("ag_loading"))}
      {slow && onRetry && <> · <button type="button" className="underline" onClick={onRetry}>{t("ag_retry")}</button></>}
    </p>
  );
}

/** 轻量 toast（V-32 / 4.5）：异步按钮三态里的「结果」；6 s 自动消失，可手动关 */
export interface ToastMsg { text: string; tone?: "ok" | "warn" | "bad" | "info" }
export function useToast(): [ToastMsg | null, (m: ToastMsg | null) => void] {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(id);
  }, [msg]);
  return [msg, setMsg];
}
export function Toast({ msg, onClose }: { msg: ToastMsg | null; onClose: () => void }) {
  if (!msg) return null;
  return (
    <div className="ag-toast" role="status" aria-live="polite" data-tone={msg.tone ?? "info"}>
      <span>{msg.text}</span>
      <button type="button" className="ag-toast-close" aria-label="close" onClick={onClose}>×</button>
    </div>
  );
}

/** 骨架（V-29）：事件台 / 资金页首屏先出形状，再出数据 */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={`ag-skel-wrap ${className ?? ""}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="ag-skel" style={{ width: `${[92, 70, 84, 60, 76][i % 5]}%` }} />)}
    </div>
  );
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
