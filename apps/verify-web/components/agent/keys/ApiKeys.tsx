"use client";
/**
 * Agent 接入 key（FIX-175）：钱包签一条消息 → 服务签发 vk_live_… → 明文只显示一次 → 粘进 MCP / SDK 的 VERIFY_API_KEY。
 * key 代表这个钱包（调用方 agent:<钱包>），与网站看到的是同一批任务与记录；随时可吊销。
 */
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Copy, Check, Trash2 } from "lucide-react";
import { apiKeyIssueMessage, API_KEY_LABEL_MAX_CHARS } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { apiKeys, notReady, type ApiKeyItem } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import { signMessage } from "@/lib/wallet";
import { walletErrorText } from "@/lib/i18n.execute";
import { Card } from "@/components/ui";
import { WalletGate } from "@/components/WalletGate";
import { LoadingState, NotReady, Skeleton } from "../shared";

const SERVICE = process.env["NEXT_PUBLIC_PUBLIC_SERVICE_URL"] ?? "https://verify.chaconne.xyz";

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ring-1 ring-line hover:bg-surface-2" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}{label}
    </button>
  );
}

export function ApiKeys() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><KeyRound size={22} aria-hidden />{zh ? "Agent 接入 key" : "Agent API keys"}</h1>
        <p className="mt-2 text-sm text-fg-2">{zh ? "把你的 Agent（MCP / SDK / 直接调 HTTP）接到 Chaconne Verify 需要一把 key。key 绑定你的钱包：用它建的任务、提交的意图、读到的记录，和你在网站上用同一钱包看到的是同一批。生成只需钱包签一条消息，不是交易、不花钱；随时可以吊销。" : "Connecting your agent (MCP, SDK or plain HTTP) to Chaconne Verify needs a key. A key is bound to your wallet: tasks it creates, intents it submits and records it reads are the same set you see on the site with that wallet. Issuing one takes a single wallet signature, no transaction, no cost; revoke any time."}</p>
      </header>
      <WalletGate title={zh ? "先连接要绑定的钱包" : "Connect the wallet to bind"} description={zh ? "key 会绑定这个地址。连接后签一条登录消息，再签一条签发消息；都不是交易。" : "The key binds to this address. After connecting you sign one sign-in message and one issue message; neither is a transaction."}>
        {(account) => <KeysPanel account={account} />}
      </WalletGate>
    </div>
  );
}

function KeysPanel({ account }: { account: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const owner = account.toLowerCase();
  const [state, setState] = useState<{ kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; keys: ApiKeyItem[] }>({ kind: "busy" });
  const [label, setLabel] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ apiKey: string; label: string; id: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState({ kind: "busy" });
    const r = await apiKeys.list(owner);
    if (r.status === 0 || notReady(r)) setState({ kind: "nr", http: r.status });
    else if (r.status !== 200) setState({ kind: "err", msg: apiError(r, locale) });
    else setState({ kind: "ok", keys: r.data.keys });
  }, [owner, locale]);
  useEffect(() => { void reload(); }, [reload]);

  async function issue() {
    const name = label.trim() || (zh ? "我的 Agent" : "My agent");
    setIssuing(true);
    setIssueError(null);
    try {
      const fields = { owner, label: name, nonce: randomHex(16), issuedAt: new Date().toISOString() };
      const signature = await signMessage(account as `0x${string}`, apiKeyIssueMessage(fields));
      const r = await apiKeys.issue({ ownerAddress: owner, label: fields.label, nonce: fields.nonce, issuedAt: fields.issuedAt, signature });
      if (r.status !== 201) { setIssueError(apiError(r, locale)); return; }
      setFresh({ apiKey: r.data.apiKey, label: r.data.label, id: r.data.id });
      setLabel("");
      void reload();
    } catch (e) {
      setIssueError(walletErrorText(e, locale));
    } finally {
      setIssuing(false);
    }
  }
  async function revoke(id: string) {
    if (!window.confirm(zh ? "吊销后用这把 key 的 Agent 会立刻被拒绝。继续？" : "Agents using this key are rejected immediately after revoking. Continue?")) return;
    setRevoking(id);
    const r = await apiKeys.revoke(id, owner);
    setRevoking(null);
    if (r.status !== 200) { setIssueError(apiError(r, locale)); return; }
    if (fresh?.id === id) setFresh(null);
    void reload();
  }

  const mcpEnv = fresh ? `{ "mcpServers": { "chaconne-verify": {\n    "command": "node", "args": ["<path-to>/verify_chaconne/packages/verify-mcp/bin/chaconne-verify-mcp.mjs"],\n    "env": { "VERIFY_SERVICE_URL": "${SERVICE}", "VERIFY_API_KEY": "${fresh.apiKey}" }\n} } }` : "";
  return (
    <div className="space-y-5">
      <Card title={zh ? "生成一把新 key" : "Issue a new key"}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-fg-2">{zh ? "给这把 key 起个名（哪个 Agent 在用）" : "Label (which agent uses it)"}
            <input className="rounded-md bg-surface-0 px-3 py-2 text-sm ring-1 ring-line" maxLength={API_KEY_LABEL_MAX_CHARS} value={label} placeholder={zh ? "例如：我的交易 Agent" : "e.g. My trading agent"} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button type="button" className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-50" disabled={issuing} onClick={() => void issue()}>{issuing ? (zh ? "等待钱包签名…" : "Waiting for the wallet…") : (zh ? "用钱包签名生成" : "Sign and issue")}</button>
        </div>
        {issueError && <p className="mt-2 text-sm text-bad" role="alert">{issueError}</p>}
        {fresh && (
          <div className="mt-4 rounded-lg border border-line bg-surface-0 p-3">
            <p className="text-sm font-medium">{zh ? `「${fresh.label}」的 key 只显示这一次，现在复制并保存：` : `The key for "${fresh.label}" is shown once. Copy and store it now:`}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="mono break-all rounded bg-surface-2 px-2 py-1 text-xs">{fresh.apiKey}</code>
              <CopyButton text={fresh.apiKey} label={zh ? "复制 key" : "Copy key"} />
            </div>
            <p className="mt-3 text-xs text-fg-2">{zh ? "MCP 客户端配置：" : "MCP client config:"}</p>
            <pre className="mono mt-1 overflow-auto rounded bg-surface-2 p-2 text-[11px]">{mcpEnv}</pre>
            <div className="mt-1"><CopyButton text={mcpEnv} label={zh ? "复制 MCP 配置" : "Copy MCP config"} /></div>
            <p className="mt-3 text-xs text-fg-2">{zh ? "直接调 HTTP：" : "Plain HTTP:"}</p>
            <pre className="mono mt-1 overflow-auto rounded bg-surface-2 p-2 text-[11px]">{`curl -H "x-api-key: ${fresh.apiKey}" "${SERVICE}/v1/tasks?owner=${owner}"`}</pre>
          </div>
        )}
      </Card>
      <Card title={zh ? "这个钱包的 key" : "Keys for this wallet"}>
        {state.kind === "busy" && <div className="space-y-2" aria-busy="true"><LoadingState onRetry={reload} /><Skeleton lines={3} /></div>}
        {state.kind === "nr" && <NotReady what="GET /v1/keys" status={state.http} onRetry={reload} />}
        {state.kind === "err" && <p className="text-sm text-bad">{state.msg}</p>}
        {state.kind === "ok" && (state.keys.length === 0
          ? <p className="text-sm text-fg-2">{zh ? "还没有 key。上面生成一把，粘进你的 Agent。" : "No keys yet. Issue one above and paste it into your agent."}</p>
          : <ul className="divide-y divide-line text-sm">
            {state.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1"><strong>{k.label}</strong> <code className="mono text-xs text-fg-2">{k.hint}</code></span>
                <span className="text-xs text-fg-3">{zh ? "签发" : "Issued"} {formatTime(k.createdAt, locale)}{k.lastUsedAt ? ` · ${zh ? "最近使用" : "last used"} ${formatTime(k.lastUsedAt, locale)}` : ` · ${zh ? "还没用过" : "never used"}`}</span>
                <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-bad ring-1 ring-line hover:bg-surface-2 disabled:opacity-50" disabled={revoking === k.id} onClick={() => void revoke(k.id)}><Trash2 size={12} aria-hidden />{revoking === k.id ? "…" : (zh ? "吊销" : "Revoke")}</button>
              </li>
            ))}
          </ul>)}
        <p className="mt-3 text-xs text-fg-3">{zh ? "key 能做的事 = 你在网站上能做的事：建任务、授权后提交交易意图、修订计划、读记录。它签不了授权（那要你的钱包），也拿不到资金。丢了就吊销、再生成。" : "A key can do what you can do on the site: create tasks, submit trade intents once you have authorized, revise plans, read records. It cannot sign authorizations (that needs your wallet) and never touches funds. Lost it? Revoke and issue a new one."}</p>
      </Card>
    </div>
  );
}
