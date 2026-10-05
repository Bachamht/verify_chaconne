/** /agent/new 链接（事件卡、对照、回放、草案都用它）。单独成文件：链接方不必加载预填逻辑与表单模型（/replay 曾因此多 180 kB） */
export const FROM_SOURCES = ["draft", "event", "compare", "replay"] as const;
export type FromSource = (typeof FROM_SOURCES)[number];
export function fromSourceOf(v: string | null | undefined): FromSource | null {
  return (FROM_SOURCES as readonly string[]).includes(v ?? "") ? (v as FromSource) : null;
}

/** 生成 /agent/new 链接（事件卡、对照、回放、草案都用它） */
export function newTaskHref(from: FromSource, params: Record<string, string | readonly string[] | null | undefined> = {}): string {
  const q = new URLSearchParams({ from });
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    for (const one of typeof v === "string" ? [v] : v) if (one) q.append(k, one);
  }
  return `/agent/new?${q.toString()}`;
}
