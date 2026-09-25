"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { agentTaskHistory, hrefFor, type HistoryItem } from "@/lib/history";
import { formatTime } from "@/lib/format";
import { Card } from "@/components/ui";

/** 仅恢复这个浏览器保存的任务链接，不按占位 owner 查询共享任务。 */
export function RecentAgentTasks() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  useEffect(() => {
    const load = () => setItems(agentTaskHistory().slice(0, 6));
    load();
    window.addEventListener("verify:history", load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener("verify:history", load);
      window.removeEventListener("storage", load);
    };
  }, []);

  return (
    <Card title={zh ? "在这台设备上继续" : "Continue on this device"}>
      <p className="ag-note">{zh ? "这里只保存本浏览器的任务入口，并非钱包同步记录。打开任务后查看最新结果。" : "These task links are saved in this browser, not synced with your wallet. Open a task for its latest result."}</p>
      {items === null ? <p className="ag-note mt-3" role="status">{zh ? "读取本机记录…" : "Loading local records…"}</p> : items.length > 0 ? (
        <ul className="ag-list mt-3">
          {items.map((item) => <li key={item.id} className="ag-task-row">
            <Link className="break-words underline underline-offset-4" href={hrefFor(item)}>{item.title || (zh ? "打开计划任务" : "Open task")}</Link>
            <p className="ag-note mt-1">{zh ? "记录于" : "Saved"} {formatTime(item.createdAt, locale)}</p>
          </li>)}
        </ul>
      ) : <p className="ag-note mt-3">{zh ? "还没有本机任务记录。先做一次模拟，之后可以从这里回来。" : "No tasks saved here yet. Try a simulation, then return to it here."}</p>}
      <div className="ag-actions mt-3"><Link className="btn-ghost" href="/start">{zh ? "试一次模拟" : "Try a simulation"}</Link>{items && items.length > 0 && <Link className="text-sm underline" href="/me">{zh ? "管理本机记录" : "Manage local records"}</Link>}</div>
    </Card>
  );
}
