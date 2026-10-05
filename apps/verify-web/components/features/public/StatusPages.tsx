"use client";
/**
 * v8 的 404 与页面级错误：吉祥物 ≤120 + 一句原因 + 两个按钮（方案 §5.10）。
 * 错误页显示 digest（服务端错误编号）或本地生成的参考编号，用 <Hash kind="id"> 可复制，反馈时附上。
 */
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Hash } from "@/components/kit/Hash";
import { Mascot } from "@/components/kit/Mascot";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

function Frame({ code, title, reason, children, footer }: { code: string; title: string; reason: string; children: ReactNode; footer?: ReactNode }) {
  const { locale } = useI18n();
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center sm:py-16">
      <Mascot alt={locale === "zh" ? "小指挥家" : "The little conductor"} />
      <p className="text-xs font-medium tracking-wide text-fg-3 tabular-nums">{code}</p>
      <h1 className="text-title font-semibold text-fg-1">{title}</h1>
      <p className="max-w-md text-sm leading-6 text-fg-2">{reason}</p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>
      {footer}
    </div>
  );
}

export function NotFoundV8() {
  const { t, locale } = useI18n();
  return (
    <Frame code="404" title={t("nf_h")} reason={t("nf_p")}>
      <Button asChild><Link href="/">{t("nf_home")}</Link></Button>
      <Button asChild variant="outline"><Link href="/agent/tasks">{locale === "zh" ? "看我的任务" : "My tasks"}</Link></Button>
    </Frame>
  );
}

/** 本地参考编号：没有 digest（纯浏览器错误）时给一个，便于对照控制台日志 */
function localRef(): string {
  return `web_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function ErrorV8({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const [ref] = useState(localRef);
  useEffect(() => {
    console.error(error);
  }, [error]);
  const id = error.digest ?? ref;
  return (
    <Frame
      code={zh ? "页面出错" : "Page error"}
      title={t("err_h")}
      reason={zh ? "你的数据是安全的：没有钱包确认不会签名或发送任何东西。先重试；还出错就把下面的编号发给我们。" : "Your data is safe: nothing is signed or sent without your wallet. Try again; if it keeps failing, send us the ID below."}
      footer={<p className="flex flex-wrap items-center justify-center gap-1 text-xs text-fg-3">{zh ? "反馈时附上编号" : "Include this ID when reporting"} <Hash value={id} kind="id" head={14} tail={6} /></p>}
    >
      <Button onClick={() => reset()}>{t("err_retry")}</Button>
      <Button asChild variant="outline"><Link href="/">{t("nf_home")}</Link></Button>
    </Frame>
  );
}
