"use client";
/**
 * v8 首页（方案 §5.1，MarketingShell 由根布局提供）：
 * hero → 示例任务控制台（FIXTURE，kit 组件渲染）→ 三步 → 信任区 → 开发者一行。
 * 不 import lib/wallet、lib/api（会拉 lib/session → viem）；本页不需要接口数据（D6）。
 * 全页只有一个实心主按钮（hero 的「让 Agent 先跑给我看」→ /start）。
 * 首屏以下（证据面板的折叠、Hash 的复制 toast 等）单独拆包：服务端照常整页渲染，首屏只水合 hero 需要的代码。
 */
import dynamic from "next/dynamic";
import { useI18n } from "@/lib/i18n";
import { HOME_COPY } from "./copy";
import { HomeHero } from "./HomeHero";

const HomeBelowFold = dynamic(() => import("./HomeBelowFold"));

export function HomeV8() {
  const { locale } = useI18n();
  const c = HOME_COPY[locale];
  return (
    <div className="ch-home" data-home-locale={locale}>
      <HomeHero c={c} />
      <HomeBelowFold c={c} locale={locale} />
    </div>
  );
}
