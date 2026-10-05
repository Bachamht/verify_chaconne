"use client";
/**
 * 创建 Agent 接入 key：钱包签一条消息（不是交易、不花钱）→ 服务签发 → 明文只在这个框里显示一次。
 * 签名与提交逻辑与 v7 ApiKeys 一致（apiKeyIssueMessage + apiKeys.issue）。
 */
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { apiKeyIssueMessage, API_KEY_LABEL_MAX_CHARS } from "@chaconne/core/verify";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { CodeBlock } from "@/components/kit/CodeBlock";
import { FormField } from "@/components/kit/FormField";
import { Hash } from "@/components/kit/Hash";
import { apiKeys } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { walletErrorText } from "@/lib/i18n.execute";
import { classifyWalletError, signMessage } from "@/lib/wallet";
import { writeErrorText } from "../common/writeError";
import { curlExample, keyLabel, mcpConfig, randomHex } from "./keysModel";

export function CreateKeyDialog({ open, onOpenChange, account, onIssued }: { open: boolean; onOpenChange: (o: boolean) => void; account: string; onIssued: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const owner = account.toLowerCase();
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ apiKey: string; label: string } | null>(null);

  async function issue() {
    setPending(true);
    setError(null);
    try {
      const fields = { owner, label: keyLabel(label, zh, API_KEY_LABEL_MAX_CHARS), nonce: randomHex(16), issuedAt: new Date().toISOString() };
      const signature = await signMessage(account as `0x${string}`, apiKeyIssueMessage(fields));
      const r = await apiKeys.issue({ ownerAddress: owner, label: fields.label, nonce: fields.nonce, issuedAt: fields.issuedAt, signature });
      if (r.status !== 201) {
        setError(writeErrorText(r, zh, zh ? "没有生成 key，钱包签名不会被再次使用。" : "No key was issued; the signature will not be reused."));
        return;
      }
      setFresh({ apiKey: r.data.apiKey, label: r.data.label });
      setLabel("");
      toast.success(zh ? "key 已生成，现在复制保存" : "Key issued. Copy and store it now");
      onIssued();
    } catch (e) {
      setError(classifyWalletError(e) === "rejected" ? (zh ? "你在钱包里取消了签名，没有生成 key。" : "You cancelled the signature in the wallet; no key was issued.") : walletErrorText(e, locale));
    } finally {
      setPending(false);
    }
  }

  // 明文 key 显示期间只能点「我已保存」关闭：Esc / 点遮罩 / 右上角关闭都拦掉（onOpenChange 只在外部关闭时触发）。
  function close(o: boolean) {
    if (pending) return;
    if (!o) { setFresh(null); setError(null); }
    onOpenChange(o);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && fresh) return; close(o); }}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!fresh}
        onEscapeKeyDown={(e) => { if (fresh) e.preventDefault(); }}
        onInteractOutside={(e) => { if (fresh) e.preventDefault(); }}
      >
        {fresh ? (
          <>
            <DialogHeader>
              <DialogTitle>{zh ? `「${fresh.label}」的 key` : `Key for "${fresh.label}"`}</DialogTitle>
              <DialogDescription className="flex items-start gap-2 text-sm text-warn">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {zh ? "只显示这一次，关掉就再也看不到。现在复制，存进你的 Agent 或密码管理器。" : "Shown only once. Close this and it is gone for good. Copy it into your agent or password manager now."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border bg-surface-2 px-3 py-2">
                <span className="text-sm text-fg-2">{zh ? "key" : "Key"}</span>
                <Hash value={fresh.apiKey} kind="id" head={12} tail={6} />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="text-xs text-fg-2">{zh ? "MCP 客户端配置" : "MCP client config"}</p>
                <CodeBlock code={mcpConfig(fresh.apiKey)} language="json" maxHeight="sm" />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="text-xs text-fg-2">{zh ? "直接调 HTTP" : "Plain HTTP"}</p>
                <CodeBlock code={curlExample(fresh.apiKey, owner)} language="shell" maxHeight="sm" />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)}>{zh ? "我已保存，关闭" : "I saved it, close"}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{zh ? "创建 Agent 接入 key" : "Create an agent API key"}</DialogTitle>
              <DialogDescription>{zh ? "钱包签一条消息就能生成，不是交易、不花钱。key 绑定这个钱包，随时可以吊销。" : "One wallet signature issues it; not a transaction, no cost. The key is bound to this wallet and can be revoked any time."}</DialogDescription>
            </DialogHeader>
            <FormField label={zh ? "名称" : "Name"} hint={zh ? "写清是哪个 Agent 在用，方便以后吊销" : "Say which agent uses it, so you know what to revoke later"} optional={zh ? "（可选）" : "(optional)"}>
              <Input maxLength={API_KEY_LABEL_MAX_CHARS} value={label} placeholder={zh ? "例如：我的交易 Agent" : "e.g. My trading agent"} onChange={(e) => setLabel(e.target.value)} />
            </FormField>
            {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => close(false)} disabled={pending}>{zh ? "先不" : "Not now"}</Button>
              <AsyncButton pending={pending} pendingLabel={zh ? "等待钱包签名…" : "Waiting for the wallet…"} onClick={() => void issue()}>{zh ? "用钱包签名生成" : "Sign and issue"}</AsyncButton>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
