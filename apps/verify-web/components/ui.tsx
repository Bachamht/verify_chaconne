"use client";
/** Verify 站基础组件（UV-10 保留的 .card/.btn/.field 之上的一小层；值全部走 globals.css 的 token）。 */
import type { ReactNode } from "react";
import Link from "next/link";
import { SearchX } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function VerdictBadge({ verdict }: { verdict: string }) {
  const { t } = useI18n();
  const map: Record<string, { cls: string; text: string }> = {
    eligible: { cls: "bg-ok/12 text-ok border-ok/30", text: t("eligible") },
    limited: { cls: "bg-warn/12 text-warn border-warn/30", text: t("limited") },
    rejected: { cls: "bg-bad/12 text-bad border-bad/30", text: t("rejected") },
  };
  const m = map[verdict] ?? { cls: "bg-surface-2 text-fg-1 border-line", text: verdict };
  return (
    <div className={`rounded-lg border px-4 py-3 ${m.cls}`}>
      <div className="mono text-[11px] uppercase opacity-70">{verdict}</div>
      <div className="text-lg font-semibold">{m.text}</div>
    </div>
  );
}

export function Row({ k, v, mono, tone }: { k: ReactNode; v: ReactNode; mono?: boolean; tone?: "changed" }) {
  return (
    <div className={`flex flex-wrap justify-between gap-2 border-b border-line py-2 text-sm last:border-0 ${tone === "changed" ? "-mx-2 rounded-sm border-l-2 border-l-warn bg-warn/8 px-2" : ""}`}>
      <span className="text-fg-2">{k}</span>
      <span className={mono ? "mono break-all text-right" : "text-right"}>{v}</span>
    </div>
  );
}

export function Card({ title, children, right, className }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || right) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-[15px] font-semibold leading-6">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "brand" | "info" }) {
  const cls = {
    neutral: "bg-surface-2 text-fg-2 ring-1 ring-line",
    ok: "bg-ok/12 text-ok",
    warn: "bg-warn/12 text-warn",
    bad: "bg-bad/12 text-bad",
    info: "bg-info/12 text-info",
    brand: "bg-brand-950/60 text-brand-300 ring-1 ring-line-brand",
  }[tone];
  return <span className={`mono inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-[11px] font-medium ${cls}`}>{children}</span>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="mono max-h-96 overflow-auto rounded-md bg-surface-0 p-3 text-xs text-fg-2">{JSON.stringify(value, null, 2)}</pre>;
}

/** 空状态 / 错误态统一版式（UV-05，与 404 页同款）：图标、标题、说明、最多两个动作。 */
export function EmptyState({ icon, title, description, primary, secondary, compact, code }: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  primary?: { href?: string; label: ReactNode; onClick?: () => void };
  secondary?: { href?: string; label: ReactNode; onClick?: () => void };
  compact?: boolean;
  /** 大号等宽装饰码（404 页用） */
  code?: string;
}) {
  const btn = (b: { href?: string; label: ReactNode; onClick?: () => void }, cls: string) =>
    b.href ? (
      <Link href={b.href} className={cls} onClick={b.onClick}>{b.label}</Link>
    ) : (
      <button type="button" className={cls} onClick={b.onClick}>{b.label}</button>
    );
  return (
    <div className={`chc-staff mx-auto flex max-w-xl flex-col items-center rounded-lg border border-line px-6 text-center ${compact ? "py-10" : "py-16"}`}>
      {code ? <p className="mono text-5xl font-bold text-fg-3">{code}</p> : <div className="text-fg-3">{icon ?? <SearchX size={28} strokeWidth={1.5} />}</div>}
      <h1 className="mt-3 text-xl font-bold text-fg-1">{title}</h1>
      {description && <p className="mt-2 max-w-md text-sm leading-6 text-fg-2">{description}</p>}
      {(primary || secondary) && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {primary && btn(primary, "btn")}
          {secondary && btn(secondary, "btn-ghost")}
        </div>
      )}
    </div>
  );
}
