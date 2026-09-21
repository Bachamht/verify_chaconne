"use client";
/** X-01：页面级错误兜底（深色双语，可复制摘要，可重试）。 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    console.error(error);
  }, [error]);
  const summary = `Chaconne Verify · ${typeof window !== "undefined" ? window.location.pathname : ""}\n${error.name}: ${error.message}${error.digest ? `\ndigest: ${error.digest}` : ""}\n${new Date().toISOString()}`;
  return (
    <div className="mx-auto max-w-xl space-y-4 py-16 text-center">
      <h1 className="text-2xl font-bold">{t("err_h")}</h1>
      <p className="text-sm text-neutral-400">{t("err_p")}</p>
      <pre className="mono overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-left text-xs text-neutral-300">{summary}</pre>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          className="btn-ghost"
          onClick={() => {
            navigator.clipboard?.writeText(summary).then(() => setCopied(true)).catch(() => undefined);
          }}
        >
          {copied ? "✓" : t("err_copy")}
        </button>
        <button className="btn" onClick={() => reset()}>{t("err_retry")}</button>
        <Link href="/" className="btn-ghost">{t("nf_home")}</Link>
      </div>
    </div>
  );
}
