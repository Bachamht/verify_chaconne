"use client";
import { useI18n } from "@/lib/i18n";
import { tv, tvMaybe, type V7Key } from "@/lib/i18n.v7";

/** v7 文案钩子：s(key, vars) 取固定键；m(key) 取动态键（不在字典里回 null） */
export function useV7() {
  const { locale } = useI18n();
  return {
    locale,
    zh: locale === "zh",
    s: (key: V7Key, vars?: Record<string, string | number>) => tv(locale, key, vars),
    m: (key: string, vars?: Record<string, string | number>) => tvMaybe(locale, key, vars),
  };
}
