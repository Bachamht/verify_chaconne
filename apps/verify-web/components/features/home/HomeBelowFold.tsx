"use client";
import type { Locale } from "@/lib/i18n";
import type { HomeCopy } from "./copy";
import { HomeFlow } from "./HomeFlow";
import { HomePreview } from "./HomePreview";
import { HomeSteps } from "./HomeSteps";
import { HomeDevRow, HomeTrust } from "./HomeTrust";

/** 首屏以下：一笔交易的流程动画 → 示例控制台 → 三步 → 信任区 → 开发者一行。由 HomeV8 按需加载（服务端照常渲染，不闪） */
export default function HomeBelowFold({ c, locale }: { c: HomeCopy; locale: Locale }) {
  return (
    <>
      <HomeFlow locale={locale} />
      <HomePreview c={c} locale={locale} />
      <HomeSteps c={c} locale={locale} />
      <HomeTrust c={c} />
      <HomeDevRow c={c} />
    </>
  );
}
