"use client";
/**
 * /agent/keys（v8，方案 §5.8）：这个钱包的 Agent 接入 key 列表 + 创建（Dialog，明文只显示一次）+ 吊销（二次确认）。
 * key 代表这个钱包（调用方 agent:<钱包>），与网站上看到的是同一批任务与记录。
 */
import { useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { DataTable, type ColumnDef } from "@/components/kit/DataTable";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { KeyValue } from "@/components/kit/KeyValue";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { Timestamp } from "@/components/kit/Timestamp";
import { apiKeys, type ApiKeyItem } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { requestIdOf, useResource } from "@/lib/useResource";
import { writeErrorText } from "../common/writeError";
import { CreateKeyDialog } from "./CreateKeyDialog";

export function KeysPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const owner = account?.toLowerCase() ?? null;
  const keys = useResource(owner ? `keys:${owner}` : null, () => apiKeys.list(owner!), { isEmpty: (d) => d.keys.length === 0 });
  const [creating, setCreating] = useState(false);
  const [revoke, setRevoke] = useState<ApiKeyItem | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function doRevoke() {
    if (!revoke || !owner) return;
    setRevoking(true);
    const r = await apiKeys.revoke(revoke.id, owner).catch(() => ({ status: 0, data: null }));
    setRevoking(false);
    if (r.status !== 200) {
      toast.error(zh ? "没能吊销这把 key" : "Could not revoke the key", { description: writeErrorText(r, zh, zh ? "这把 key 仍然有效。" : "The key is still valid.") });
      return;
    }
    toast.success(zh ? `已吊销「${revoke.label}」` : `Revoked "${revoke.label}"`);
    setRevoke(null);
    keys.reload();
  }

  const lastUsed = (k: ApiKeyItem) => (k.lastUsedAt ? <Timestamp at={k.lastUsedAt} mode="rel" className="text-fg-2" /> : <span className="text-fg-3">{zh ? "还没用过" : "Never used"}</span>);
  const revokeBtn = (k: ApiKeyItem) => <Button variant="ghost" size="sm" className="text-bad hover:text-bad" onClick={() => setRevoke(k)}><Trash2 aria-hidden="true" />{zh ? "吊销" : "Revoke"}</Button>;
  const columns: ColumnDef<ApiKeyItem, unknown>[] = [
    { id: "label", header: zh ? "名称" : "Name", cell: ({ row }) => <span className="font-medium text-fg-1" title={row.original.label}>{row.original.label}</span>, meta: { className: "w-[30%]" } },
    { id: "hint", header: zh ? "提示" : "Hint", cell: ({ row }) => <span className="font-mono text-xs text-fg-2" translate="no">{row.original.hint}</span> },
    { id: "created", header: zh ? "创建" : "Created", cell: ({ row }) => <Timestamp at={row.original.createdAt} mode="rel" className="text-fg-2" />, meta: { align: "right" } },
    { id: "used", header: zh ? "最后使用" : "Last used", cell: ({ row }) => lastUsed(row.original), meta: { align: "right" } },
    { id: "action", header: () => <span className="sr-only">{zh ? "动作" : "Action"}</span>, cell: ({ row }) => revokeBtn(row.original), meta: { align: "right", className: "w-28" } },
  ];
  const createBtn = <Button onClick={() => setCreating(true)}><Plus aria-hidden="true" />{zh ? "创建 key" : "Create key"}</Button>;

  let body;
  if (keys.state === "loading" || keys.state === "idle") body = <div className="px-5 pb-5"><LoadingBlock rows={3} onRetry={keys.reload} /></div>;
  else if (keys.state === "error") body = <ErrorState size="sm" status={keys.status ?? 0} requestId={requestIdOf(keys.errorBody)} onRetry={keys.reload} title={zh ? "key 列表没有拿到" : "Keys did not load"} />;
  else if (keys.state === "empty") body = <EmptyState size="sm" art={<KeyRound className="size-8 text-fg-3" strokeWidth={1.5} aria-hidden="true" />} title={zh ? "这个钱包还没有 key" : "No key for this wallet yet"} description={zh ? "创建一把，粘进你的 Agent（MCP / SDK / HTTP）的 VERIFY_API_KEY。" : "Create one and paste it into your agent's VERIFY_API_KEY (MCP, SDK or HTTP)."} action={createBtn} />;
  else {
    body = (
      <div className="px-4 sm:px-0">
        <DataTable columns={columns} data={keys.data?.keys ?? []} getRowId={(k) => k.id} caption={zh ? "Agent 接入 key" : "Agent API keys"}
          cardRow={(k) => (
            <div className="flex flex-col gap-2 rounded-md border bg-surface-1 p-3">
              <div className="flex min-h-8 items-center justify-between gap-2"><span className="truncate text-sm font-medium text-fg-1">{k.label}</span>{revokeBtn(k)}</div>
              <KeyValue dense items={[
                { label: zh ? "提示" : "Hint", value: <span className="font-mono text-xs" translate="no">{k.hint}</span> },
                { label: zh ? "创建" : "Created", value: <Timestamp at={k.createdAt} mode="rel" /> },
                { label: zh ? "最后使用" : "Last used", value: lastUsed(k) },
              ]} />
            </div>
          )} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        className="mb-0"
        title={zh ? "Agent 接入 key" : "Agent API keys"}
        description={zh ? "把你的 Agent（MCP / SDK / 直接调 HTTP）接到 Chaconne。key 绑定你的钱包：它建的任务、读到的记录，和你在网站上看到的是同一批。" : "Connect your agent (MCP, SDK or plain HTTP) to Chaconne. A key is bound to your wallet: the tasks it creates and the records it reads are the ones you see on the site."}
        actions={keys.state === "ok" ? createBtn : undefined}
      />
      <Panel>
        <Panel.Header title={zh ? "这个钱包的 key" : "Keys for this wallet"} />
        <Panel.Body flush className="pb-4">{body}</Panel.Body>
        <Panel.Footer>
          <p className="text-xs text-fg-3">{zh ? "key 能做的事 = 你在网站上能做的事：建任务、授权后提交交易意图、修订计划、读记录。它签不了授权（那要你的钱包），也拿不到资金。丢了就吊销，再创建一把。" : "A key can do what you can do on the site: create tasks, submit trade intents once you have authorized, revise plans, read records. It cannot sign authorizations (that needs your wallet) and never touches funds. Lost it? Revoke it and create a new one."}</p>
        </Panel.Footer>
      </Panel>
      {account ? <CreateKeyDialog open={creating} onOpenChange={setCreating} account={account} onIssued={keys.reload} /> : null}
      <ConfirmDialog
        open={revoke !== null}
        onOpenChange={(o) => { if (!o) setRevoke(null); }}
        title={zh ? `吊销「${revoke?.label ?? ""}」？` : `Revoke "${revoke?.label ?? ""}"?`}
        consequence={zh ? "吊销后，用这把 key 的 Agent 会立刻被拒绝，不能恢复；要继续用就再创建一把新的。你的任务、授权和链上额度都不受影响。" : "Agents using this key are rejected immediately and the key cannot be restored; create a new one to continue. Your tasks, authorizations and on-chain allowances are not affected."}
        confirmLabel={zh ? "吊销 key" : "Revoke key"}
        pending={revoking}
        onConfirm={() => void doRevoke()}
      />
    </div>
  );
}
