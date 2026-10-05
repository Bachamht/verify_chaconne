"use client";
/**
 * 页头钱包按钮（v8）：未连接 → 「连接钱包」（连接中显示钱包名）；已连接 → 短地址 + 菜单（复制地址 / 更换钱包 / 断开连接）。
 * 会拉 lib/wallet（viem），营销壳用 next/dynamic 延迟加载它。
 */
import { ChevronDown, Copy, LogOut, Repeat, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/i18n";
import { middleTruncate } from "@/lib/numbers";
import { useAccount } from "@/lib/useAccount";
import { useWalletStatus } from "@/lib/useWalletStatus";
import { activeWalletName } from "@/lib/wallet";
import { disconnectWallet } from "@/lib/disconnect";
import { useCopy } from "@/components/kit/useCopy";
import { useConnect } from "./useConnect";

const ADDRESS_COPIED = { zh: "已复制地址", en: "Address copied" };

export default function WalletButton() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const status = useWalletStatus();
  // 取消 / 拒绝：全局提示条已说明，这里不再弹错（不读 useConnect 的 error）
  const { busy, connect: doConnect } = useConnect();
  const { copy } = useCopy(ADDRESS_COPIED);
  const connecting = busy || (status.status !== "idle" && status.phase === "connect");

  if (!account) {
    const name = status.walletName;
    return (
      <Button size="sm" onClick={() => void doConnect()} disabled={connecting} aria-busy={connecting || undefined}>
        <Wallet aria-hidden="true" />
        <span className="hidden sm:inline">{connecting ? (name ? (zh ? `连接 ${name} 中…` : `Connecting ${name}…`) : (zh ? "连接中…" : "Connecting…")) : (zh ? "连接钱包" : "Connect wallet")}</span>
        <span className="sm:hidden">{connecting ? "…" : (zh ? "连接" : "Connect")}</span>
      </Button>
    );
  }
  const walletName = activeWalletName();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="ch-wallet-connected gap-2 font-mono text-xs" aria-label={zh ? `钱包 ${account}` : `Wallet ${account}`}>
          <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
          <span className="min-w-0 truncate">{middleTruncate(account)}</span>
          <ChevronDown className="size-3.5 text-fg-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-xs font-normal text-fg-3">{walletName ?? (zh ? "已连接钱包" : "Connected wallet")}</span>
          <span className="font-mono text-xs break-all text-fg-1" translate="no">{account}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copy(account)}>
          <Copy aria-hidden="true" />{zh ? "复制地址" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void doConnect(true)}>
          <Repeat aria-hidden="true" />{zh ? "更换钱包" : "Switch wallet"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void disconnectWallet()}>
          <LogOut aria-hidden="true" />{zh ? "断开连接" : "Disconnect"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
