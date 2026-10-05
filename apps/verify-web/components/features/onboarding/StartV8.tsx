"use client";
/**
 * /start（v8）入口：?mode=play → 原「我来扮演 Agent」教学（旧组件原样）；?v7fixture=1 → 示例数据走完整流程（不连钱包、不签名）；
 * 已连接 → 四步引导；未连接 → 先交代再连接。
 */
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { useAccount } from "@/lib/useAccount";
import { v7FixtureRequested } from "@/lib/v7";
import { FX_OWNER } from "@/lib/v7fixtures";
import { StartFlow } from "./StartFlow";
import { StartWelcome } from "./StartWelcome";

/** 教学入口是旧组件（带旧 CSS）：按需加载，不进 v8 引导的首屏包 */
const Onboarding = dynamic(() => import("@/components/onboarding/Onboarding").then((m) => m.Onboarding));

export function StartV8() {
  const sp = useSearchParams();
  const account = useAccount();
  if (sp.get("mode") === "play") return <Onboarding />;
  if (v7FixtureRequested(sp.toString())) return <StartFlow key="fixture" owner={FX_OWNER} fixture />;
  if (account) return <StartFlow key={account.toLowerCase()} owner={account} fixture={false} />;
  return <StartWelcome />;
}
