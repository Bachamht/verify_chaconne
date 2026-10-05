"use client";
/** ⌘K 面板本体（cmdk）：只在第一次打开时由 CommandPalette 动态加载（D6）。数据来自 lib/nav.ts */
import { useRouter } from "next/navigation";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useI18n } from "@/lib/i18n";
import { NAV_NEW_TASK, NAV_TOOLS, NAV_WORKSPACE, NAV_DEVELOPERS, type NavLink } from "@/lib/nav";
import { NAV_ICONS } from "@/components/shell/navIcons";

const START: NavLink = { href: "/start", label: { zh: "开始体验", en: "Get started" }, icon: "start" };

export default function CommandPaletteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const go = (href: string) => { onOpenChange(false); router.push(href); };
  const item = (n: NavLink) => {
    const Icon = NAV_ICONS[n.icon];
    return (
      <CommandItem key={n.href} value={`${n.label.zh} ${n.label.en} ${n.href} ${(n.keywords ?? []).join(" ")}`} onSelect={() => go(n.href)}>
        <Icon aria-hidden="true" />
        <span>{n.label[locale]}</span>
        <span className="ml-auto font-mono text-xs text-fg-3">{n.href}</span>
      </CommandItem>
    );
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={zh ? "跳转与搜索" : "Go to and search"} description={zh ? "输入页面名或动作" : "Type a page or an action"}>
      <CommandInput placeholder={zh ? "搜索页面、动作…" : "Search pages and actions…"} />
      <CommandList>
        <CommandEmpty>{zh ? "没有匹配项。" : "No matches."}</CommandEmpty>
        <CommandGroup heading={zh ? "动作" : "Actions"}>{item(NAV_NEW_TASK)}{item(START)}</CommandGroup>
        <CommandGroup heading={zh ? "工作区" : "Workspace"}>{NAV_WORKSPACE.map(item)}</CommandGroup>
        <CommandGroup heading={zh ? "工具" : "Tools"}>{[...NAV_TOOLS, NAV_DEVELOPERS].map(item)}</CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
