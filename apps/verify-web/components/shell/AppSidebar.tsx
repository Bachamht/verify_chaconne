"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarRail, useSidebar,
} from "@/components/ui/sidebar";
import { useI18n } from "@/lib/i18n";
import { isActive, NAV_DEVELOPERS, NAV_NEW_TASK, NAV_TOOLS, NAV_WORKSPACE } from "@/lib/nav";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { LogoMark, Wordmark } from "@/components/Logo";
import { NAV_ICONS } from "./navIcons";

/** 工作区侧栏（240 / 折叠 64）：今天 · 任务 · 事件 · 资金 · 日志 · 实验；底部：开发者 · 工具 ▾ · 主站 */
export function AppSidebar() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const pathname = usePathname() ?? "";
  const { setOpenMobile } = useSidebar();
  const close = () => setOpenMobile(false);
  const NewIcon = NAV_ICONS[NAV_NEW_TASK.icon];
  const ToolsIcon = NAV_ICONS.tools;
  const DevIcon = NAV_ICONS[NAV_DEVELOPERS.icon];
  const toolsActive = NAV_TOOLS.some((n) => isActive(pathname, n.href));
  return (
    <Sidebar collapsible="icon" className="ch-app-sidebar" aria-label={zh ? "工作区导航" : "Workspace navigation"}>
      <SidebarHeader className="h-16 justify-center px-5 group-data-[collapsible=icon]:px-3">
        <Link href="/" className="ch-brand flex items-center gap-2.5 text-brand-300 group-data-[collapsible=icon]:justify-center" aria-label={zh ? "Chaconne Agent 首页" : "Chaconne Agent home"} onClick={close}>
          <LogoMark size={28} />
          <span className="group-data-[collapsible=icon]:hidden"><Wordmark /></span>
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-1 px-2 pt-3 group-data-[collapsible=icon]:px-2">
        <SidebarGroup className="px-2 pb-5 group-data-[collapsible=icon]:px-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={NAV_NEW_TASK.label[locale]} className="ch-sidebar-create h-11 justify-center gap-2 rounded-md bg-primary font-medium text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground data-[active=true]:bg-primary/90 data-[active=true]:text-primary-foreground" isActive={isActive(pathname, NAV_NEW_TASK.href)}>
                <Link href={NAV_NEW_TASK.href} onClick={close} aria-current={isActive(pathname, NAV_NEW_TASK.href) ? "page" : undefined}><NewIcon aria-hidden="true" /><span>{NAV_NEW_TASK.label[locale]}</span></Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="px-2 group-data-[collapsible=icon]:px-2">
          <SidebarGroupLabel className="mb-2 px-3 text-xs font-normal tracking-wide text-fg-3">{zh ? "工作区" : "Workspace"}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              {NAV_WORKSPACE.map((n) => {
                const Icon = NAV_ICONS[n.icon];
                return (
                  <SidebarMenuItem key={n.href}>
                    <SidebarMenuButton asChild className="ch-sidebar-link h-10 gap-3 px-3 text-fg-2 data-[active=true]:text-fg-1" isActive={isActive(pathname, n.href)} tooltip={n.label[locale]}>
                      <Link href={n.href} onClick={close} aria-current={isActive(pathname, n.href) ? "page" : undefined}><Icon strokeWidth={1.7} aria-hidden="true" /><span>{n.label[locale]}</span></Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="mx-2 gap-2 border-t border-sidebar-border/70 px-2 py-4">
        <SidebarGroupLabel className="px-3 text-xs font-normal tracking-wide text-fg-3">{zh ? "资源" : "Resources"}</SidebarGroupLabel>
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="h-10 gap-3 px-3 text-fg-2" isActive={isActive(pathname, NAV_DEVELOPERS.href)} tooltip={NAV_DEVELOPERS.label[locale]}>
              <Link href={NAV_DEVELOPERS.href} onClick={close} aria-current={isActive(pathname, NAV_DEVELOPERS.href) ? "page" : undefined}><DevIcon strokeWidth={1.7} aria-hidden="true" /><span>{NAV_DEVELOPERS.label[locale]}</span></Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <Collapsible asChild defaultOpen={toolsActive} className="group/tools">
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton className="h-10 gap-3 px-3 text-fg-2" tooltip={zh ? "工具" : "Tools"} isActive={toolsActive}>
                  <ToolsIcon strokeWidth={1.7} aria-hidden="true" /><span>{zh ? "工具" : "Tools"}</span>
                  <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/tools:rotate-90" aria-hidden="true" />
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub>
                  {NAV_TOOLS.map((n) => (
                    <SidebarMenuSubItem key={n.href}>
                      <SidebarMenuSubButton asChild className="h-auto min-h-9 py-2" isActive={isActive(pathname, n.href)}>
                        <Link href={n.href} onClick={close} aria-current={isActive(pathname, n.href) ? "page" : undefined}><span>{n.label[locale]}</span></Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="h-10 gap-3 px-3 text-fg-2" tooltip={zh ? "行情比价（主站）" : "Markets (main site)"}>
              <a href={MAIN_SITE_URL}><ArrowUpRight strokeWidth={1.7} aria-hidden="true" /><span>{zh ? "行情比价" : "Markets"}</span></a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
