"use client";
/**
 * 自然语言框（可选）：页面**不内置模型**。只有当已连接的 Agent（MCP host）通过 `window.chaconneAgent.compileTask`
 * 注入编译器时才显示输入框，把一句话编译成 `create_task` 调用参数交给用户确认；没有 Agent 时只显示表单入口与接入说明。
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { CreateTaskBody } from "@/lib/api-v2";
import { Card, Pill } from "@/components/ui";

type Compiler = { compileTask: (text: string, hints: { locale: string }) => Promise<Partial<CreateTaskBody>> };
declare global {
  interface Window {
    chaconneAgent?: Compiler;
  }
}

export function NlBox({ onDraft }: { onDraft: (d: Partial<CreateTaskBody>) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [agent, setAgent] = useState<Compiler | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setAgent(typeof window !== "undefined" && window.chaconneAgent?.compileTask ? window.chaconneAgent : null);
    read();
    window.addEventListener("chaconne:agent", read);
    return () => window.removeEventListener("chaconne:agent", read);
  }, []);
  if (!agent) {
    return (
      <Card title={zh ? "用一句话交代（需要已连接的 Agent）" : "Say it in one sentence (needs a connected agent)"} right={<Pill tone="neutral">{zh ? "未检测到 Agent" : "no agent detected"}</Pill>}>
        <p className="ag-note">{zh ? "这个页面不内置模型。把 Chaconne 的 MCP 服务器接到你的 Agent（任意 MCP host）后，由它把你的话编译成 create_task 调用；金额、规则、权限仍由你在表单里确认。现在请直接用上面的四个入口。" : "This page has no built-in model. Connect the Chaconne MCP server to your agent any MCP host and it compiles your sentence into a create_task call; amounts, rules and permissions are still confirmed by you in the form. For now, use the four entries above."}</p>
        <p className="mt-2 text-sm"><Link className="underline" href="/developers">{zh ? "接入说明 →" : "How to connect →"}</Link></p>
      </Card>
    );
  }
  async function compile() {
    setBusy(true);
    setErr(null);
    try {
      onDraft(await agent!.compileTask(text, { locale }));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={zh ? "用一句话交代" : "Say it in one sentence"} right={<Pill tone="ok">{zh ? "Agent 已连接" : "agent connected"}</Pill>}>
      <textarea className="field" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={zh ? "例：下周分三次买 AAPLx，避开 CPI 前后半小时" : "e.g. buy AAPLx in three steps next week, skipping 30 min around CPI"} />
      <div className="ag-actions mt-2"><button className="btn" disabled={busy || !text.trim()} onClick={compile}>{zh ? "编译成任务草案" : "Compile into a task draft"}</button><span className="ag-note">{zh ? "草案会填进表单，由你确认后才创建。" : "The draft fills the form; nothing is created until you confirm."}</span></div>
      {err && <p className="mt-2 text-sm text-bad">{err}</p>}
    </Card>
  );
}
