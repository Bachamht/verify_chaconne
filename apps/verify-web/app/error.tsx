"use client";
/** X-01 / UV-05：页面级错误兜底（深色双语，可复制摘要，可重试），与 404 同一版式。 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    console.error(error);
  }, [error]);
  const summary = `Chaconne Agent · ${typeof window !== "undefined" ? window.location.pathname : ""}\n${error.name}: ${error.message}${error.digest ? `\ndigest: ${error.digest}` : ""}\n${new Date().toISOString()}`;
  return (
    <div className="chc-staff mx-auto flex max-w-xl flex-col items-center rounded-lg border border-line px-6 py-16 text-center">
      <AlertTriangle size={28} strokeWidth={1.5} className="text-warn" />
      <h1 className="mt-3 text-xl font-bold">{t("err_h")}</h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-fg-2">{t("err_p")}</p>
      <pre className="mono mt-4 w-full overflow-auto rounded-md border border-line bg-surface-1 p-3 text-left text-xs text-fg-2">{summary}</pre>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button className="btn" onClick={() => reset()}>{t("err_retry")}</button>
        <button
          className="btn-ghost"
          onClick={() => {
            navigator.clipboard?.writeText(summary).then(() => setCopied(true)).catch(() => undefined);
          }}
        >
          {copied ? <Check size={16} /> : null}
          {copied ? "" : t("err_copy")}
        </button>
        <Link href="/" className="btn-ghost">{t("nf_home")}</Link>
      </div>
    </div>
  );
}
