"use client";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

export function VerdictBadge({ verdict }: { verdict: string }) {
  const { t } = useI18n();
  const map: Record<string, { cls: string; text: string }> = {
    eligible: { cls: "bg-ok/15 text-ok border-ok/40", text: t("eligible") },
    limited: { cls: "bg-warn/15 text-warn border-warn/40", text: t("limited") },
    rejected: { cls: "bg-bad/15 text-bad border-bad/40", text: t("rejected") },
  };
  const m = map[verdict] ?? { cls: "bg-neutral-800 text-neutral-300 border-neutral-700", text: verdict };
  return (
    <div className={`rounded-xl border px-4 py-3 ${m.cls}`}>
      <div className="mono text-xs uppercase opacity-70">{verdict}</div>
      <div className="text-lg font-semibold">{m.text}</div>
    </div>
  );
}

export function Row({ k, v, mono }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-neutral-800 py-2 text-sm last:border-0">
      <span className="text-neutral-400">{k}</span>
      <span className={mono ? "mono break-all text-right" : "text-right"}>{v}</span>
    </div>
  );
}

export function Card({ title, children, right }: { title?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card">
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "brand" }) {
  const cls = { neutral: "border-neutral-700 text-neutral-300", ok: "border-ok/40 text-ok", warn: "border-warn/40 text-warn", bad: "border-bad/40 text-bad", brand: "border-brand/50 text-brand" }[tone];
  return <span className={`mono rounded-md border px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="mono max-h-96 overflow-auto rounded-lg bg-neutral-950 p-3 text-xs text-neutral-300">{JSON.stringify(value, null, 2)}</pre>;
}
